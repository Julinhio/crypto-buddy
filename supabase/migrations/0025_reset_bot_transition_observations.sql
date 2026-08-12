-- Migration 0025 — reset_bot connaît transition_observations
--
-- CORRECTIF D'UN DÉFAUT LATENT. `public.reset_bot(numeric)` est cassé depuis la migration
-- 0022, et personne ne s'en est aperçu parce que personne n'a relancé de reset depuis.
--
-- La 0022 a créé `public.transition_observations` avec :
--
--     decision_id bigint not null references public.decisions (id) on delete cascade
--
-- ...et ne l'a ajoutée NI à la liste du TRUNCATE de `reset_bot`, NI à son `grant truncate`.
-- Or PostgreSQL refuse de tronquer une table référencée par une foreign key à moins que la
-- table référençante soit tronquée DANS LA MÊME INSTRUCTION (ou qu'on passe CASCADE). Le
-- `truncate table ... public.decisions` de `reset_bot` échoue donc désormais avec :
--
--     ERROR: cannot truncate a table referenced in a foreign key constraint
--     DETAIL: Table "transition_observations" references "decisions".
--
-- Et comme tout `reset_bot` tient dans UNE transaction, l'échec survient APRÈS que le
-- run-lock a été réclamé : le rollback le relâche, rien n'est purgé, rien n'est corrompu.
-- Le défaut est une INDISPONIBILITÉ du reset, pas une purge à moitié faite. C'est la seule
-- bonne nouvelle de l'affaire — mais elle ne se serait découverte qu'au pire moment, le
-- jour où quelqu'un veut réellement repartir de zéro.
--
-- La 0019 avait pourtant écrit la règle noir sur blanc, en la nommant : « decision_guard_events
-- a une FK vers decisions : sans elle dans la liste, le TRUNCATE échouerait purement et
-- simplement ». La 0022 a créé une FK de plus et ne l'a pas relue. La 0024 a re-énoncé la
-- fonction verbatim en y ajoutant `market_data_incidents` — qui n'a AUCUNE FK, donc n'a
-- jamais été le problème — et a recopié l'oubli au passage.
--
-- Vérification faite table par table, pour ne pas refermer la moitié du trou : les cinq
-- tables qui portent aujourd'hui une FK vers `public.decisions` sont `executions` (0003),
-- `scheduler_runs` (0006), `equity_snapshots` (0008), `decision_guard_events` (0019) et
-- `transition_observations` (0022). Les quatre premières sont déjà dans la liste ;
-- `transition_observations` est le seul manque. `executions.intent_execution_id` (0005)
-- est une auto-référence d'`executions` vers elle-même, couverte par sa propre présence
-- dans la liste, et `position_state` (0017) ne porte aucune FK.
--
-- Le reste de reset_bot est INCHANGÉ et ré-énoncé verbatim depuis la 0024 — cette
-- migration n'ajoute qu'un nom dans deux listes.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run). Aucun déploiement de code ne l'accompagne : `reset_bot` s'appelle à la
-- main, le bot ne l'appelle jamais.

create or replace function public.reset_bot(
  p_new_starting_capital_usd numeric
)
returns table (
  status        text,
  locked_until  timestamptz,
  next_check_at timestamptz
)
language plpgsql
as $$
declare
  v_locked_until timestamptz;
  v_next         timestamptz;
begin
  -- 1. Valider le nouveau capital AVANT de toucher au lock ou à la moindre donnée.
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2. Claim du run-lock — le même compare-and-set que le scheduler, sans le « due ? ».
  update public.bot_state as b
     set run_token    = gen_random_uuid(),
         locked_until = now() + make_interval(secs => 60)
   where b.id = 1
     and (b.run_token is null or b.locked_until is null or b.locked_until <= now());

  if not found then
    select b.locked_until into v_locked_until from public.bot_state as b where b.id = 1;
    return query select 'busy'::text, v_locked_until, null::timestamptz;
    return;
  end if;

  -- 3. Purge de l'historique. transition_observations rejoint la liste ici — et pas par
  --    souci de complétude : sans elle, sa FK vers `decisions` fait échouer TOUT le
  --    TRUNCATE. L'ordre à l'intérieur d'un TRUNCATE n'a aucune importance (c'est une
  --    seule instruction, les FK sont vérifiées sur l'ensemble), seule la présence compte.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decision_guard_events,
    public.market_data_incidents,
    public.transition_observations,
    public.decisions;

  -- 4. bot_state remis à plat, nouveau capital écrit, lock relâché.
  v_next := now();
  update public.bot_state as b
     set run_token                = null,
         locked_until             = null,
         consecutive_failures     = 0,
         floor_delay_streak       = 0,
         floor_alert_sent         = false,
         failure_alert_sent       = false,
         consecutive_blind_cycles = 0,
         blind_alert_sent         = false,
         last_market_data_ok_at   = null,
         last_success_at          = null,
         next_check_at            = v_next,
         starting_capital_usd     = p_new_starting_capital_usd,
         updated_at               = now()
   where b.id = 1;

  if not found then
    raise exception 'reset_bot: bot_state singleton (id=1) is missing during finalize';
  end if;

  return query select 'reset'::text, null::timestamptz, v_next;
end;
$$;

-- TRUNCATE demande le privilège TRUNCATE (non impliqué par DELETE). Idempotent.
--
-- Le grant compte AUTANT que la liste du TRUNCATE, et pour une raison qui n'est pas
-- évidente : `reset_bot` n'est pas SECURITY DEFINER, elle s'exécute donc avec les droits
-- de l'appelant — `service_role`. Une table absente d'ici ferait échouer la fonction sur
-- un « permission denied for table », c'est-à-dire au même endroit et avec la même
-- conséquence que la FK manquante, en moins lisible.
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.position_state,
  public.decision_guard_events,
  public.market_data_incidents,
  public.transition_observations,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events/market_data_incidents/transition_observations (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags (including consecutive_blind_cycles, blind_alert_sent, last_market_data_ok_at), releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at. EVERY table with a FK to decisions must be in the TRUNCATE list AND in the grant above, or the whole reset fails (transition_observations was missing from 0022 to 0024).';
