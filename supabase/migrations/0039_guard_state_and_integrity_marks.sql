-- Migration 0039 — l'état du garde par cycle, et les marques d'intégrité de la mesure
--
-- Incident des 18-19/09/2026 (PR #48). Au cycle 2112 la bande d'exposition a relevé le livre de
-- 33,75 % à 45 %. À partir de là, COHERENCE_GUARD refusait tout maintien : l'intention brute du
-- modèle (33,75) rejouée contre le livre déplacé (45) produisait des ventes — le renversement
-- des jambes de bande — et la règle `moved_line_without_note` exigeait une thèse sur chacune,
-- pendant que le mandat dit qu'un maintien conserve ses thèses. Quinze cycles sur dix-neuf
-- perdus (2113-2131), le garde désarmé à la main, et une fenêtre de mesure préenregistrée
-- contaminée de deux façons. Cette migration porte la seconde moitié de la réparation : rendre
-- la contamination LISIBLE PAR LES RAPPORTS, là où ils lisent, et pas dans un document à côté.
--
-- Deux objets, additifs, aucune ligne métier existante réécrite :
--
--   1. `decisions.coherence_guard_armed` — le garde était-il armé sur ce réveil. Écrit par le
--      cycle sur chaque nouvelle ligne, quel que soit son statut. NULL sur tout l'historique
--      antérieur : inconnu, et JAMAIS reconstruit ici. Les événements du garde prouvent « armé »
--      quand ils existent ; ils ne prouvent rien quand ils n'existent pas, et la période où le
--      garde a tourné désarmé (après 2131, à la main) n'a laissé aucune trace en base — c'est
--      exactement le trou que cette colonne ferme pour la suite.
--
--   2. `decision_integrity_marks` — une table de marques, une ligne par (décision, type), lue
--      par les lecteurs de la mesure (C8, le rejeu des témoins). Deux types :
--
--        `selection_par_le_garde`         la proposition du cycle est CONDITIONNÉE À L'ACTION :
--                                         pendant l'incident un maintien ne pouvait plus passer,
--                                         donc ce cycle n'a été décidé que parce qu'il bougeait.
--                                         Ce n'est pas une réaction libre à la bande. Quatre
--                                         cycles, listés à la main et validés : 2115, 2124, 2125,
--                                         2126. Les cycles `guard_failed` de l'intervalle ne
--                                         portent pas de marque : leur statut dit déjà le fait.
--
--        `relance_orientee_par_le_garde`  la proposition journalisée est celle de la SECONDE
--                                         tentative, produite sous le message de relance du
--                                         garde — qui demandait de « ré-émettre la référence ».
--                                         Dérivé du journal du garde lui-même, sans inférence :
--                                         tout cycle décidé de la fenêtre du pilote qui porte un
--                                         événement `guard_recovered_on_retry`. La première
--                                         réponse, non orientée, est recopiée en JSON depuis le
--                                         détail journalisé du refus quand il la cite
--                                         (`first_attempt_target`), pour que le lecteur puisse
--                                         dire si la relance a déplacé la cible sur une ligne.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run) AVANT de déployer le code qui écrit la colonne (règle dure du projet : un
-- binaire qui insère `coherence_guard_armed` sur une table qui ne l'a pas ne journalise plus
-- aucun cycle). Idempotente : chaque objet est créé « si absent », chaque marque « sauf conflit ».

-- ── 1. L'état du garde, par cycle ─────────────────────────────────────────────────────

alter table public.decisions
  add column if not exists coherence_guard_armed boolean;

comment on column public.decisions.coherence_guard_armed is
  'COHERENCE_GUARD etait-il arme sur le reveil qui a ecrit cette ligne. Ecrit par le cycle sur chaque nouvelle ligne, quel que soit le statut. NULL sur l''historique anterieur a la migration 0039 : inconnu, jamais reconstruit. Les evenements du garde prouvent « arme » quand ils existent et rien quand ils manquent — un garde desarme n''en emet aucun, c''est pourquoi l''etat est ecrit et non infere.';

-- ── 2. Les marques d'intégrité ────────────────────────────────────────────────────────

create table if not exists public.decision_integrity_marks (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  -- ON DELETE CASCADE : une marque sur une décision qui n'existe plus ne marque rien. Comme
  -- toute table portant une FK vers `decisions`, elle DOIT figurer dans le TRUNCATE de
  -- `reset_bot` et dans son `grant truncate` — voir plus bas, dans cette même migration.
  decision_id bigint not null references public.decisions (id) on delete cascade,
  kind        text   not null,
  -- La justification DURABLE, en clair : ce qui s'est passé et pourquoi la lecture est
  -- affectée. Un lecteur dans six semaines doit pouvoir la lire sans ouvrir git.
  reason      text   not null,
  -- D'où vient la marque : la PR, la migration, l'incident.
  source      text   not null,
  -- `relance_orientee_par_le_garde` seulement : la PREMIÈRE réponse du modèle sur ce cycle,
  -- telle que le garde l'a citée dans son refus, recopiée en allocation. NULL quand le refus
  -- ne la citait pas (seule la règle 1 cite l'allocation émise). C'est ce qui permet au
  -- lecteur C8 de dire si la relance a déplacé la cible sur la ligne qu'il lit : si la cible
  -- décidée égale la première sur cette ligne, la lecture reste attribuable ; sinon, ou si
  -- la première est inconnue, elle ne l'est pas.
  first_attempt_target jsonb,

  constraint decision_integrity_marks_kind_known
    check (kind in ('selection_par_le_garde', 'relance_orientee_par_le_garde')),
  constraint decision_integrity_marks_one_per_kind unique (decision_id, kind)
);

comment on table public.decision_integrity_marks is
  'Marques d''integrite de la mesure du pilote d''exposition, une ligne par (decision, type). selection_par_le_garde : proposition conditionnee a l''action par le garde de coherence pendant l''incident des 18-19/09/2026 — jamais une reaction libre a la bande. relance_orientee_par_le_garde : proposition journalisee produite sur la seconde tentative, sous le message de relance du garde. Lues par C8 et par le rejeu des temoins ; additives, jamais reecrites.';

comment on column public.decision_integrity_marks.first_attempt_target is
  'relance_orientee_par_le_garde seulement : la premiere reponse du modele sur ce cycle, recopiee depuis le detail journalise du refus de la regle 1 (« emitted [...] »). NULL quand le refus ne la citait pas. Permet de dire, ligne par ligne, si la relance a deplace la cible.';

create index if not exists decision_integrity_marks_decision_idx
  on public.decision_integrity_marks (decision_id);

-- Row Level Security : ACTIVÉE sans aucune policy (deny-all), même posture que toutes les
-- autres tables. Une marque modifiable depuis l'extérieur serait une mesure modifiable.
alter table public.decision_integrity_marks enable row level security;

-- ── 3. reset_bot connaît la nouvelle table ────────────────────────────────────────────
--
-- La règle écrite par la 0025 et rappelée par la 0031 : TOUTE table portant une FK vers
-- `decisions` doit figurer DANS la liste du TRUNCATE de `reset_bot` ET dans son `grant
-- truncate`, sinon le reset entier échoue sur « cannot truncate a table referenced in a
-- foreign key constraint ». Le reste de la fonction est ré-énoncé verbatim depuis la 0031 ;
-- cette migration n'ajoute qu'un nom dans deux listes.

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

  -- 3. Purge de l'historique. `decision_integrity_marks` rejoint la liste ici — sans elle, sa
  --    FK vers `decisions` fait échouer TOUT le TRUNCATE. L'ordre à l'intérieur d'un TRUNCATE
  --    n'a aucune importance (une seule instruction, les FK sont vérifiées sur l'ensemble),
  --    seule la présence compte.
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
    public.decision_integrity_marks,
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
  public.decision_integrity_marks,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events/market_data_incidents/transition_observations/refused_intentions/exposure_band_observations/exposure_band_corrections/decision_integrity_marks (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags (including consecutive_blind_cycles, blind_alert_sent, last_market_data_ok_at), releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at. EVERY table with a FK to decisions must be in the TRUNCATE list AND in the grant above, or the whole reset fails (transition_observations was missing from 0022 to 0024).';

-- ── 4. Les marques de l'incident ──────────────────────────────────────────────────────
--
-- 4a. Les quatre cycles conditionnés à l'action, listés à la main et validés (arbitrage du
--     19/09). Chaque insertion est GARDÉE par l'existence d'une ligne `decided` portant cet id :
--     sur une base qui ne porte pas ces cycles (une base neuve, un rejeu local), rien n'est
--     inséré — jamais une marque sur un id qui n'est pas celui de l'incident.

insert into public.decision_integrity_marks (decision_id, kind, reason, source)
select v.id,
       'selection_par_le_garde',
       'Incident garde/bande des 18-19/09/2026. Après la correction de bande du cycle 2112 '
       || '(exposition relevée de 33,75 % à 45 %), COHERENCE_GUARD refusait tout maintien : '
       || 'l''intention brute rejouée contre le livre déplacé produisait le renversement des '
       || 'jambes de bande, et la règle moved_line_without_note exigeait une thèse sur chacune. '
       || 'Ce cycle n''a passé le garde que parce qu''il bougeait : sa proposition est '
       || 'conditionnée à l''action, sélectionnée par le garde, et n''est pas une réaction libre '
       || 'à la bande. Aucune lecture C8 ni aucun rapport ne doit la lire comme telle.',
       'PR #48 (fix/guard-band-hold) — migration 0039, arbitrage du 19/09/2026'
  from (values (2115), (2124), (2125), (2126)) as v (id)
 where exists (select 1 from public.decisions d where d.id = v.id and d.status = 'decided')
    on conflict (decision_id, kind) do nothing;

-- 4b. Les cycles décidés sur la seconde tentative, DÉRIVÉS du journal du garde et de lui seul :
--     un événement `guard_recovered_on_retry` prouve que la ligne décidée est la réponse à la
--     relance. Borné à la fenêtre du pilote (depuis son cycle d'activation), parce que c'est la
--     mesure que ces marques protègent ; une base sans pilote n'insère rien. La première
--     réponse est recopiée depuis le détail du refus quand la règle 1 l'a citée — c'est le
--     format `fmt()` du garde lui-même (« ASSET valeur% », séparés par « , »), pas une prose.

insert into public.decision_integrity_marks (decision_id, kind, reason, source, first_attempt_target)
select e.decision_id,
       'relance_orientee_par_le_garde',
       'Cycle décidé sur la SECONDE tentative, après une relance du garde de cohérence dont le '
       || 'message orientait la réponse (« re-emit the reference target UNCHANGED »). Règles '
       || 'refusées en première tentative : ' || array_to_string(e.rules, ', ') || '. La '
       || 'proposition journalisée est celle de la relance ; la première réponse, non orientée, '
       || 'n''est connue que par le détail journalisé du refus (first_attempt_target quand la '
       || 'règle 1 l''a citée). Constat historique de l''incident garde/bande des 18-19/09/2026 : '
       || 'vingt relances de ce type entre 1840 et 2102, pour des maintiens qui reprenaient '
       || 'l''allocation appliquée.',
       'PR #48 (fix/guard-band-hold) — migration 0039, dérivé de decision_guard_events',
       (select jsonb_object_agg(split_part(kv, ' ', 1), rtrim(split_part(kv, ' ', 2), '%')::numeric)
          from unnest(string_to_array(substring(e.detail from 'emitted \[([^]]*)\]'), ', ')) as kv
         where kv <> '')
  from public.decision_guard_events e
  join public.decisions d on d.id = e.decision_id and d.status = 'decided'
 where e.event_type = 'guard_recovered_on_retry'
   and e.decision_id >= (select p.activated_decision_id
                           from public.exposure_pilot p
                          where p.activated_decision_id is not null
                          limit 1)
    on conflict (decision_id, kind) do nothing;
