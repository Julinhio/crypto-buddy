-- Migration 0021 — un appel de relance qui n'aboutit pas n'est pas une réponse incohérente
--
-- Suite directe de 0020, même raisonnement appliqué au dernier cas qui restait mélangé.
-- Quand le second appel Anthropic lève (timeout, 429, réseau), il n'existe AUCUNE réponse
-- corrigée : le modèle n'a rien produit qu'on puisse juger incohérent. L'enregistrer en
-- `guard_failed_after_retry` — que la vue décrit comme « réponse restée incohérente après
-- correction » — envoie l'opérateur relire le prompt de relance et les règles, alors que
-- le problème est du transport ou de la latence.
--
-- Les trois familles d'échec de relance sont désormais distinctes, et chacune pointe vers
-- l'endroit où regarder :
--
--   guard_failed_after_retry      → le modèle n'arrive pas à se corriger    → prompt, règles
--   guard_failed_no_retry_budget  → plus de temps avant même de relancer    → latence, budget
--   guard_retry_call_failed       → la relance n'a pas abouti               → transport, API
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
    'guard_failed_no_retry_budget',
    -- NOUVEAU : la relance a été tentée mais l'appel lui-même a échoué. Aucune réponse
    -- corrigée n'existe, donc rien à juger côté cohérence.
    'guard_retry_call_failed',
    'output_order_violation',
    'thesis_write_refused'
  ));

-- DROP + CREATE plutôt que CREATE OR REPLACE : Postgres refuse d'insérer une colonne au
-- milieu d'une vue existante (42P16). La vue est une projection de lecture sans
-- dépendant, la recréer ne coûte rien.
drop view if exists public.decision_guard_counters;

create view public.decision_guard_counters
  with (security_invoker = true) as
select
  count(*) filter (where event_type = 'guard_rejected_first_attempt') as rejected_first_attempt,
  count(*) filter (where event_type = 'guard_recovered_on_retry')     as recovered_on_retry,
  count(*) filter (where event_type = 'guard_failed_after_retry')     as failed_after_retry,
  count(*) filter (where event_type = 'guard_failed_no_retry_budget') as failed_no_retry_budget,
  count(*) filter (where event_type = 'guard_retry_call_failed')      as retry_call_failed,
  count(*) filter (where event_type = 'output_order_violation')       as output_order_violations,
  count(*) filter (where event_type = 'thesis_write_refused')         as thesis_writes_refused,
  max(created_at)                                                     as last_event_at
from public.decision_guard_events;

comment on view public.decision_guard_counters is
  'Les trois compteurs du brief P0 (refuses au premier essai / corriges a la relance / encore invalides apres relance), plus les deux autres facons dont une relance peut ne pas aboutir (budget epuise avant de relancer, appel de relance en echec), les violations systemiques de l''ordre de sortie et les refus d''ecriture de these. failed_after_retry ne compte QUE les cycles ayant reellement obtenu une reponse corrigee restee incoherente : chaque compteur pointe vers un endroit different ou aller regarder.';
