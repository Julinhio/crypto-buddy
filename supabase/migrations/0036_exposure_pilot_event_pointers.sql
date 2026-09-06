-- Migration 0036 — la reference durable qui rend un battement nul lisible
--
-- Un battement nul n'est jamais une dispense. Mais il recouvre deux situations qui n'appellent
-- pas la meme reponse :
--
--   * aucun cycle DECIDE n'a tourne depuis l'activation — le pilote vient de naitre, ou son
--     recu de continuite n'a pas encore eu de cycle a nommer. La reprise reste possible.
--   * au moins un cycle decide a tourne depuis l'activation SANS battement correspondant —
--     il y a un trou dans le plus-haut, et l'identite devient `interrupted_mode`.
--
-- Les distinguer demande de savoir ou etait le journal a l'instant de l'activation. C'est ce
-- que cette colonne fige : le dernier cycle decide qui existait AVANT elle. Sans cette
-- reference, un battement nul serait ambigu — et l'ambiguite se resoudrait dans le mauvais
-- sens, en laissant reprendre un pilote qui a perdu de vue ses propres cycles.
--
-- Elle est ecrite une seule fois, dans l'insertion d'activation elle-meme, a partir de la
-- lecture que le meme cycle a deja faite pour juger l'interruption.

alter table public.exposure_pilot
  add column if not exists activation_baseline_decision_id bigint;

comment on column public.exposure_pilot.activation_baseline_decision_id is
  'Le dernier cycle DECIDE qui existait AVANT l''activation. C''est la reference durable qui distingue « aucun cycle decide depuis l''activation » — reprise possible — de « un cycle a tourne sans battement » — identite interrompue. Sans elle, un battement nul serait ambigu et l''ambiguite se resoudrait dans le mauvais sens.';
