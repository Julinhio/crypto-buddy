-- Migration 0034 — le verdict du pilote, cycle par cycle, dans le journal de la bande
--
-- Arbitré : « si la lecture ou l'écriture obligatoire de l'identité, du plus-haut ou du
-- coupe-circuit échoue, la correction ne s'applique pas dans ce cycle. Le bot normal continue
-- et l'échec est journalisé. »
--
-- Une ligne de log n'est pas un journal. Ces trois colonnes rendent le verdict LISIBLE là où
-- toutes les autres questions sur la bande se lisent déjà, cycle par cycle :
--
--   `pilot_hold`   pourquoi la correction n'a pas touché les ordres, nommé et jamais tu.
--                  Null quand elle les a touchés — le seul cas où il n'y a rien à expliquer.
--   `pilot_drawdown_percent` / `pilot_peak_equity_usd`
--                  ce que le coupe-circuit voyait à cet instant. Sans eux, un arrêt ne se
--                  relit qu'au travers de l'identité, qui ne garde que le dernier état.
--
-- En mode `observation`, `pilot_hold` vaut `mode_inactif` sur tous les cycles : c'est la
-- réponse honnête, et c'est aussi la preuve continue que rien ne s'applique.

alter table public.exposure_band_observations
  add column if not exists pilot_hold             text,
  add column if not exists pilot_drawdown_percent numeric,
  add column if not exists pilot_peak_equity_usd  numeric;

alter table public.exposure_band_observations
  drop constraint if exists exposure_band_observations_pilot_hold_known;

alter table public.exposure_band_observations
  add constraint exposure_band_observations_pilot_hold_known
    check (
      pilot_hold is null
      or pilot_hold in (
        'mode_inactif',
        'identite_illisible',
        'ecriture_obligatoire_impossible',
        'pilote_arrete_drawdown',
        'pilote_invalide_contrat',
        'contrat_divergent',
        'equite_inutilisable'
      )
    );

comment on column public.exposure_band_observations.pilot_hold is
  'Pourquoi la correction n''a pas touche les ordres ce cycle. Null uniquement quand elle les a touches. En mode observation, vaut `mode_inactif` partout : la preuve continue que rien ne s''applique.';

comment on column public.exposure_band_observations.pilot_drawdown_percent is
  'Le drawdown que le coupe-circuit voyait a cet instant, mesure depuis le plus-haut du pilote. Null tant qu''aucun pilote n''est actif.';
