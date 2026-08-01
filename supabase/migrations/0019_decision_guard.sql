-- Migration 0019 — le garde de cohérence du contrat de sortie (P0)
--
-- Deux défauts sont corrigés par la PR que cette migration précède, et ils n'ont pas
-- la même nature :
--
--   1. le modèle émettait `target_allocation` et `action_type` AVANT son raisonnement.
--      Un modèle raisonne en écrivant : il posait ses chiffres, réfléchissait ensuite,
--      changeait parfois d'avis, et ne pouvait plus revenir sur des champs déjà émis.
--      Le cycle 987 (30/07) décrivait un allègement BNB 12% → 8% dans son raisonnement,
--      sa notification et sa thèse, et émettait `hold` / BNB 12%. Aucun ordre. Trade réel
--      perdu. Le réordonnancement du schéma corrige ça et ne se journalise pas ;
--
--   2. le détecteur existant — une thèse ne s'écrit que sur une ligne qui a bougé — a
--      correctement tiré sur 987 et 1000, et son résultat s'est évaporé avec les logs du
--      processus : ni compteur, ni état consultable, ni alerte. C'EST CE DÉFAUT-LÀ que
--      cette migration adresse. Un détecteur dont le verdict ne survit pas au processus
--      n'est pas un détecteur, c'est un `console.log`.
--
-- D'où une table d'ÉVÉNEMENTS plutôt que trois compteurs entiers sur `bot_state`. Trois
-- entiers répondent à « combien », jamais à « lequel, quand, et sur quelle règle » —
-- et c'est exactement la question qu'on s'est posée le 31/07 sans pouvoir y répondre.
-- Les compteurs demandés restent disponibles : ils sont dérivés en vue, ci-dessous.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run) AVANT de déployer le code qui écrit dedans (règle dure du projet).

-- ── 1. Un cycle rejeté par le garde est un cycle en échec, VISIBLE ────────────────
--
-- Statut dédié plutôt que réutiliser `parse_failed`. Deux raisons, et la seconde est la
-- vraie :
--
--   - honnêteté de la métrique : `parse_failed` veut dire « la réponse n'était pas
--     exploitable ». Ici elle l'était parfaitement — elle était incohérente. Confondre
--     les deux pollue le compteur de parse failures, qui est à zéro depuis le 25/07 et
--     qui sert à surveiller autre chose ;
--
--   - et surtout : la CIBLE DE RÉFÉRENCE du garde se lit comme « le
--     `target_allocation` de la dernière ligne `decided` ». Le bot tourne en Cron
--     Schedule, chaque cycle est un processus neuf, il n'y a aucun état en mémoire entre
--     deux réveils : cette lecture DOIT venir de la base. En donnant au cycle rejeté un
--     statut qui n'est pas `decided`, la règle « un cycle rejeté n'établit aucune cible »
--     devient une propriété du schéma, pas une jointure à ne pas oublier. Le cas de
--     démarrage se résout au passage : les 139 décisions v5 existantes sont toutes
--     `decided`, donc le premier cycle post-déploiement trouve une référence sans
--     backfill et sans valeur par défaut implicite.
--
-- `classifyOutcome` (scheduler/policy.ts) range déjà tout ce qui n'est ni `decided` ni
-- `skipped` dans 'error' : le nouveau statut hérite donc du backoff et de l'alerte
-- « dégradé » à 3 échecs consécutifs, sans qu'il y ait à l'y ajouter à la main.
alter table public.decisions drop constraint if exists decisions_status_check;
alter table public.decisions add constraint decisions_status_check
  check (status = any (array['decided', 'skipped', 'parse_failed', 'error', 'guard_failed']));

-- ── 2. La trace durable ──────────────────────────────────────────────────────────
create table if not exists public.decision_guard_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  -- La décision concernée, quand il y en a une. NULL sur un cycle mort : un cycle
  -- rejeté deux fois n'écrit pas de ligne `decided`, et l'événement doit survivre
  -- quand même — c'est précisément le cas qu'on a perdu le 30/07. `run_token` le
  -- rattache alors au run du scheduler.
  decision_id bigint references public.decisions(id),
  run_token uuid,

  event_type text not null check (event_type in (
    -- Les trois compteurs demandés, dans l'ordre du brief §4.5.
    'guard_rejected_first_attempt',  -- réponse refusée au premier essai
    'guard_recovered_on_retry',      -- réponse corrigée avec succès à la relance
    'guard_failed_after_retry',      -- cycle encore invalide après la relance
    -- Condition SYSTÉMIQUE, pas un rejet de garde : le modèle a émis sa cible avant
    -- son raisonnement. L'ordre des clés est déterministe et vient du schéma, donc une
    -- violation casse tous les cycles à l'identique — aucune relance, le cycle meurt.
    'output_order_violation',
    -- Le refus d'écriture de thèse qui existait déjà et ne laissait qu'un console.log.
    'thesis_write_refused'
  )),

  -- 1 = première réponse, 2 = réponse de relance. Les événements systémiques et les
  -- refus de thèse portent 1.
  attempt smallint not null default 1 check (attempt between 1 and 2),

  -- Les identifiants des règles violées ('hold_moved_target', 'target_not_executable',
  -- 'note_on_unmoved_line', 'moved_line_without_note'). Vide sur les autres types.
  rules text[] not null default '{}',
  -- Les actifs concernés, quand la règle est par ligne.
  assets text[] not null default '{}',
  -- Le message lisible par un humain, tel qu'il a été servi au modèle ou loggé.
  detail text
);

create index if not exists decision_guard_events_created_at_idx
  on public.decision_guard_events (created_at desc);
create index if not exists decision_guard_events_decision_id_idx
  on public.decision_guard_events (decision_id);
create index if not exists decision_guard_events_type_idx
  on public.decision_guard_events (event_type, created_at desc);

comment on table public.decision_guard_events is
  'Trace durable du garde de cohérence du contrat de sortie (P0). Un événement par verdict : rejet au premier essai, correction réussie à la relance, échec après relance, violation systémique de l''ordre de sortie, refus d''écriture de thèse. Existe parce que le détecteur du trade perdu du 30/07 a fonctionné et que son résultat s''est évaporé avec les logs du processus. Les trois compteurs du brief sont dérivés dans la vue decision_guard_counters.';

comment on column public.decision_guard_events.decision_id is
  'La décision concernée, NULL quand le cycle est mort sans écrire de ligne decided (rejeté deux fois). Le rattachement passe alors par run_token.';

comment on column public.decision_guard_events.rules is
  'Identifiants des règles violées. Le garde ne lit QUE du structuré : il compare cible contre cible de référence, et note de thèse contre mouvement calculé. Il n''interprète jamais la prose.';

-- Row Level Security : ACTIVÉE, ZÉRO policy (deny-all), comme toutes les autres tables.
-- Le backend utilise la service role key, qui contourne RLS ; toute clé anon/publique
-- est refusée. Une migration l'a déjà oublié une fois — pas deux.
alter table public.decision_guard_events enable row level security;

-- ── 3. Les trois compteurs, dérivés ──────────────────────────────────────────────
--
-- `security_invoker = true` : la vue s'exécute avec les droits de l'APPELANT, donc la
-- RLS deny-all de la table sous-jacente s'applique à travers elle. Une vue en
-- security definer (le défaut historique de Postgres) serait un trou : elle rendrait
-- lisible via la vue ce que la RLS refuse sur la table.
create or replace view public.decision_guard_counters
  with (security_invoker = true) as
select
  count(*) filter (where event_type = 'guard_rejected_first_attempt') as rejected_first_attempt,
  count(*) filter (where event_type = 'guard_recovered_on_retry')     as recovered_on_retry,
  count(*) filter (where event_type = 'guard_failed_after_retry')     as failed_after_retry,
  count(*) filter (where event_type = 'output_order_violation')       as output_order_violations,
  count(*) filter (where event_type = 'thesis_write_refused')         as thesis_writes_refused,
  max(created_at)                                                     as last_event_at
from public.decision_guard_events;

comment on view public.decision_guard_counters is
  'Les trois compteurs du brief P0 §4.5 (refusés au premier essai / corrigés à la relance / encore invalides après relance), plus les violations systémiques de l''ordre de sortie et les refus d''écriture de thèse. Dérivés de decision_guard_events — un compteur entier répondrait à "combien" et jamais à "lequel, quand, sur quelle règle".';

-- ── 4. reset_bot connaît la nouvelle table ───────────────────────────────────────
--
-- La leçon de la migration 0018, appliquée le jour même plutôt qu'après coup : une
-- table persistante que `reset_bot` ignore survit à un reset. Ici la conséquence serait
-- plus bénigne que pour `position_state` (des compteurs qui ne repartent pas de zéro,
-- pas une thèse zombie), mais `decision_guard_events` a une FK vers `decisions` : sans
-- elle dans la liste, le TRUNCATE échouerait purement et simplement.
--
-- Tout le reste de reset_bot est inchangé et re-énoncé verbatim.
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

  -- 3. Purge de l'historique. decision_guard_events rejoint la liste ici.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decision_guard_events,
    public.decisions;

  -- 4. bot_state remis à plat, nouveau capital écrit, lock relâché.
  v_next := now();
  update public.bot_state as b
     set run_token            = null,
         locked_until         = null,
         consecutive_failures = 0,
         floor_delay_streak   = 0,
         floor_alert_sent     = false,
         failure_alert_sent   = false,
         last_success_at      = null,
         next_check_at        = v_next,
         starting_capital_usd = p_new_starting_capital_usd,
         updated_at           = now()
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
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags, releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
