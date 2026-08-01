-- Migration 0020 — distinguer « pas eu le budget de relancer » de « relancé et toujours faux »
--
-- Le compteur du brief §4.5 n°3 est « cycles encore invalides APRÈS la relance ». La
-- branche qui refuse de relancer faute de temps enregistrait `guard_failed_after_retry`,
-- alors qu'aucune relance n'a eu lieu : ces cycles gonflaient donc le compteur et se
-- présentaient à l'opérateur comme des réponses corrigées restées incohérentes. Ce sont
-- deux pannes différentes, avec deux réactions différentes :
--
--   - `guard_failed_after_retry`      → le modèle n'arrive pas à se corriger. On regarde
--                                       le prompt de relance et les règles ;
--   - `guard_failed_no_retry_budget`  → le cycle a manqué de temps AVANT de pouvoir
--                                       relancer. On regarde la latence, le budget de
--                                       cycle et ce qui a ralenti le réveil. Le modèle
--                                       n'est pas en cause.
--
-- Un compteur qui mélange les deux envoie chercher le problème au mauvais endroit, ce
-- qui est exactement le genre de perte de temps que la table existe pour éviter.
--
-- Comment appliquer : coller dans le SQL Editor Supabase AVANT de déployer le code qui
-- écrit la nouvelle valeur (règle dure du projet).

alter table public.decision_guard_events
  drop constraint if exists decision_guard_events_event_type_check;

alter table public.decision_guard_events
  add constraint decision_guard_events_event_type_check
  check (event_type in (
    'guard_rejected_first_attempt',
    'guard_recovered_on_retry',
    'guard_failed_after_retry',
    -- NOUVEAU : rejeté au premier essai, et pas assez de budget de cycle restant pour
    -- tenter la relance. Aucun appel LLM n'a été fait pour ce cycle au-delà du premier.
    'guard_failed_no_retry_budget',
    'output_order_violation',
    'thesis_write_refused'
  ));

-- La vue expose les deux séparément. `failed_after_retry` retrouve le sens exact que le
-- brief lui donne : des cycles qui ont VRAIMENT eu leur relance et sont restés faux.
--
-- DROP puis CREATE, et non CREATE OR REPLACE : Postgres refuse d'insérer une colonne au
-- milieu d'une vue existante (42P16, il croit qu'on renomme). La vue est une projection
-- de lecture sans dépendant, donc la recréer ne coûte rien.
drop view if exists public.decision_guard_counters;

create view public.decision_guard_counters
  with (security_invoker = true) as
select
  count(*) filter (where event_type = 'guard_rejected_first_attempt') as rejected_first_attempt,
  count(*) filter (where event_type = 'guard_recovered_on_retry')     as recovered_on_retry,
  count(*) filter (where event_type = 'guard_failed_after_retry')     as failed_after_retry,
  count(*) filter (where event_type = 'guard_failed_no_retry_budget') as failed_no_retry_budget,
  count(*) filter (where event_type = 'output_order_violation')       as output_order_violations,
  count(*) filter (where event_type = 'thesis_write_refused')         as thesis_writes_refused,
  max(created_at)                                                     as last_event_at
from public.decision_guard_events;

comment on view public.decision_guard_counters is
  'Les trois compteurs du brief P0 (refuses au premier essai / corriges a la relance / encore invalides apres relance), plus les cycles morts faute de budget avant meme de relancer, les violations systemiques de l''ordre de sortie et les refus d''ecriture de these. failed_after_retry ne compte QUE les cycles qui ont reellement eu leur relance : melanger les deux enverrait chercher le probleme au mauvais endroit.';
