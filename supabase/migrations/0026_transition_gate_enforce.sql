-- Migration 0026 — la porte de transition passe en mode bloquant
--
-- PUREMENT ADDITIVE, et c'est une contrainte née d'un incident du 12/08 : la migration
-- 0024 avait changé la SIGNATURE de `finish_run`, et entre son application à la main et le
-- redéploiement du code, l'ancien code a appelé une fonction qui n'existait plus. Un cycle
-- est resté bloqué sur `running`, repris par bail expiré, sans dégât mais sans être gratuit.
--
-- Ici : une colonne nullable, une table neuve, et `reset_bot` remplacée EN PLACE avec la
-- MÊME signature (`create or replace`, aucun `drop`). L'ancien code ignore simplement la
-- colonne et la table. Il n'y a donc AUCUNE fenêtre : la migration peut être appliquée
-- avant le déploiement sans qu'un seul cycle intermédiaire ne casse.
--
-- Ordre recommandé : migration d'abord, déploiement ensuite (le code neuf écrit dans la
-- nouvelle table). L'inverse marcherait aussi, au prix de quelques écritures perdues.

-- ── 1. Pourquoi l'appliquée diverge de la proposition, quand ce n'est pas le clamp ──
--
-- Jusqu'ici `applied_allocation` ne pouvait s'écarter de `target_allocation` que par le
-- clamp de risque, et `clamped` suffisait à le dire. Avec la porte armée, un cycle refusé
-- laisse `clamped` à FALSE pendant que les deux colonnes divergent : un lecteur qui filtre
-- sur `clamped` conclurait que rien n'a rogné la cible, en regardant deux allocations qui
-- se contredisent.
--
-- Colonne dédiée plutôt que réutiliser `clamp_reason` : deux causes distinctes, deux
-- colonnes, aucune surcharge de sens. `resolveEffectiveTarget` (PR #27) avait été livré en
-- prévision de ce jour — c'est aujourd'hui que les deux colonnes divergent pour la
-- première fois.
alter table public.decisions
  add column if not exists applied_divergence_cause text;

comment on column public.decisions.applied_divergence_cause is
  'Pourquoi applied_allocation s''écarte de target_allocation quand le CLAMP n''en est pas la cause — aujourd''hui, uniquement la porte de transition refusant le vecteur stratégique du cycle. NULL quand les deux colonnes s''accordent, et sur toute ligne antérieure à 0026. Sur un cycle refusé, applied_allocation conserve le vecteur appliqué PRÉCÉDENT : la ligne reste `decided`, l''intention avance, l''appliquée ne bouge pas.';

-- ── 2. Le devenir des intentions refusées ────────────────────────────────────────
--
-- C'est la table qui dira, dans quelques jours, si la porte valait son coût. Bloquer un
-- ordre n'est un gain que si l'intention refusée était mauvaise ; si le modèle la répète
-- à l'identique dès que l'actif redevient actionnable, la porte n'aura fait que retarder
-- le même trade — et il faudra le savoir avec des chiffres, pas avec une impression.
--
-- UNE LIGNE PAR ÉPISODE ET PAR ACTIF, pas une par cycle. Un gel dure plusieurs réveils et
-- le modèle peut re-proposer à chaque fois ; compter les cycles gonflerait le
-- dénominateur et ferait passer un seul désaccord pour dix. La ligne s'ouvre au premier
-- refus, et se ferme au premier cycle où l'actif redevient actionnable.
--
-- PAS de foreign key vers `decisions`, pour la raison qui a servi à `market_data_incidents` :
-- l'épisode survit à sa décision, et une ligne d'observabilité ne doit jamais pouvoir
-- bloquer une purge ni disparaître dans une cascade. Les identifiants sont des bigint nus.
create table if not exists public.refused_intentions (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  asset text not null,

  -- ── l'intention, telle qu'elle a été refusée ──────────────────────────────────
  -- La décision qui l'a portée, et le cycle. Best-effort, sans contrainte.
  refused_decision_id bigint,
  refused_at          timestamptz not null default now(),
  -- Le mouvement que le modèle voulait : sens, notionnel, et le prix du moment.
  refused_side        text not null check (refused_side in ('buy','sell')),
  refused_notional    numeric,
  refused_price       numeric,
  -- La cible du modèle SUR CET ACTIF (en % d'équité), et la référence en vigueur —
  -- l'allocation que le livre poursuivait réellement au moment du refus.
  refused_target_percent   numeric,
  reference_target_percent numeric,
  -- Pourquoi cette jambe est tombée : son propre actif était gelé (`forbidden`), ou elle a
  -- été emportée par l'atomicité (`cancelled_atomic`). Sans ça les deux se confondent, et
  -- la deuxième a l'air parfaitement tradable dans sa propre ligne.
  refused_leg_verdict text,
  gate_at_refusal     text,

  -- ── la résolution, au premier cycle redevenu actionnable ──────────────────────
  resolved_at          timestamptz,
  resolved_decision_id bigint,
  -- Ce que le modèle a proposé sur cet actif une fois la porte rouverte.
  resolved_side            text check (resolved_side in ('buy','sell')),
  resolved_target_percent  numeric,
  resolved_price           numeric,

  -- ── le verdict, et les trois mesures ──────────────────────────────────────────
  -- repeated  : même sens re-proposé → la porte n'a fait que retarder le trade.
  -- abandoned : plus rien sur cet actif → l'intention était bien de l'agitation.
  -- inverted  : sens opposé → la porte a évité un aller-retour. Le cas du 11/08.
  -- unresolved: l'épisode court toujours, ou s'est terminé sans qu'on puisse conclure.
  outcome text check (outcome in ('repeated','abandoned','inverted','unresolved')),
  -- Combien de temps l'actif est resté gelé.
  delay_minutes numeric,
  -- De combien le prix a bougé entre le refus et la résolution, en pourcent. C'est le
  -- chiffre qui dit si attendre a coûté ou rapporté.
  price_move_percent numeric,
  -- L'écart entre la cible refusée et celle finalement proposée, en points d'allocation.
  target_gap_percent numeric,
  -- Combien de réveils l'actif a passé gelé — le dénominateur honnête de l'épisode.
  frozen_cycles integer not null default 1
);

-- Un seul épisode OUVERT par actif à la fois. C'est ce qui fait qu'un gel de vingt cycles
-- produit une ligne et non vingt, sans que le code ait à s'en souvenir.
create unique index if not exists refused_intentions_open_per_asset_idx
  on public.refused_intentions (asset) where resolved_at is null;
create index if not exists refused_intentions_refused_at_idx
  on public.refused_intentions (refused_at desc);
create index if not exists refused_intentions_outcome_idx
  on public.refused_intentions (outcome, refused_at desc);

comment on table public.refused_intentions is
  'Le devenir des intentions que la porte de transition a refusées : une ligne par ÉPISODE et par actif (pas par cycle), ouverte au premier refus et fermée au premier cycle redevenu actionnable. Classe en repeated / abandoned / inverted / unresolved et mesure le délai, le déplacement du prix et l''écart de cible. Existe pour répondre avec des chiffres à "la porte valait-elle son coût" — bloquer un ordre n''est un gain que si l''intention refusée était mauvaise.';

-- Row Level Security : ACTIVÉE, ZÉRO policy (deny-all), comme toutes les autres tables.
alter table public.refused_intentions enable row level security;

-- ── 3. reset_bot connaît la nouvelle table ───────────────────────────────────────
--
-- Signature INCHANGÉE, `create or replace` sans `drop` : pas de fenêtre de déploiement.
-- La leçon de 0018 puis de 0025 (une table persistante que reset_bot ignore survit à un
-- reset, et si elle porte une FK elle fait carrément échouer le TRUNCATE), appliquée le
-- jour même. `refused_intentions` n'a aucune FK, donc sa place dans la liste est libre.
--
-- Tout le reste de reset_bot est inchangé et ré-énoncé verbatim.
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
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

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

  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decision_guard_events,
    public.market_data_incidents,
    public.transition_observations,
    public.refused_intentions,
    public.decisions;

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
-- NOTE, corrigeant un commentaire faux des migrations 0006/0007/0019/0024 : le
-- `revoke execute ... from public` qui suit N'EMPÊCHE PAS `anon` et `authenticated`
-- d'appeler la fonction. Supabase leur accorde EXECUTE NOMINATIVEMENT via
-- `alter default privileges`, et un revoke sur PUBLIC ne retire pas un grant nominatif —
-- vérifié en base le 12/08 sur les cinq fonctions du scheduler. L'accès reste fermé, mais
-- par la couche du dessous : RLS deny-all sur les tables, et des fonctions SECURITY INVOKER
-- (aucune n'est definer), donc un appelant anon ne lit ni n'écrit rien et n'a pas le
-- privilège TRUNCATE. Le revoke est conservé — il ferme bien PUBLIC — mais il ne faut pas
-- lui prêter une protection qu'il n'apporte pas.
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.position_state,
  public.decision_guard_events,
  public.market_data_incidents,
  public.transition_observations,
  public.refused_intentions,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events/market_data_incidents/transition_observations/refused_intentions (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags, releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
