-- Migration 0031 — reset_bot connaît exposure_band_corrections
--
-- La 0030 crée `public.exposure_band_corrections` avec une FK vers `public.decisions`. La
-- règle que la 0025 a écrite noir sur blanc, après l'avoir apprise à ses dépens : TOUTE table
-- portant une FK vers `decisions` doit figurer DANS la liste du TRUNCATE de `reset_bot` ET
-- dans son `grant truncate`. Sans ce nom ici, `reset_bot` échouerait entièrement avec :
--
--     ERROR: cannot truncate a table referenced in a foreign key constraint
--     DETAIL: Table "exposure_band_corrections" references "decisions".
--
-- L'échec surviendrait APRÈS le claim du run-lock : le rollback le relâche, rien n'est purgé,
-- rien n'est corrompu. Le défaut serait une INDISPONIBILITÉ du reset, découverte au pire
-- moment. La 0022 avait créé ce trou et il a survécu trois migrations.
--
-- Vérification faite table par table : les tables portant aujourd'hui une FK vers
-- `public.decisions` sont `executions` (0003), `scheduler_runs` (0006), `equity_snapshots`
-- (0008), `decision_guard_events` (0019), `transition_observations` (0022),
-- `refused_intentions` (0026), `exposure_band_observations` (0028) et désormais
-- `exposure_band_corrections` (0030). Les sept premières sont déjà dans la liste ; la huitième
-- est le seul ajout.
--
-- Le reste de `reset_bot` est INCHANGÉ et ré-énoncé verbatim depuis la 0029 — cette migration
-- n'ajoute qu'un nom dans deux listes.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run). Aucun déploiement de code ne l'accompagne : `reset_bot` s'appelle à la main.

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

  -- 3. Purge de l'historique. `exposure_band_observations` rejoint la liste ici — et pas par
  --    souci de complétude : sans elle, sa FK vers `decisions` fait échouer TOUT le TRUNCATE.
  --    L'ordre à l'intérieur d'un TRUNCATE n'a aucune importance (c'est une seule
  --    instruction, les FK sont vérifiées sur l'ensemble), seule la présence compte.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decision_guard_events,
    public.market_data_incidents,
    public.transition_observations,
    public.refused_intentions,
    public.exposure_band_observations,
    public.exposure_band_corrections,
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
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.position_state,
  public.decision_guard_events,
  public.market_data_incidents,
  public.transition_observations,
  public.refused_intentions,
  public.exposure_band_observations,
  public.exposure_band_corrections,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events/market_data_incidents/transition_observations/refused_intentions/exposure_band_observations/exposure_band_corrections (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags (including consecutive_blind_cycles, blind_alert_sent, last_market_data_ok_at), releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at. EVERY table with a FK to decisions must be in the TRUNCATE list AND in the grant above, or the whole reset fails (transition_observations was missing from 0022 to 0024).';
