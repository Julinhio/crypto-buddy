-- Migration 0038 — le plus-haut du pilote voit toute valorisation admissible
--
-- ── LE DÉFAUT ────────────────────────────────────────────────────────────────
--
-- Le jugement du pilote — plus-haut, alerte 40 %, arrêt 50 % — ne s'exécutait que sur les
-- cycles ayant franchi le modèle et le garde de cohérence. Un cycle `guard_failed` ou `error`
-- dispose pourtant du même livre souverain, valorisé aux mêmes prix vivants : son equity est la
-- valeur réelle du livre à cet instant. Le 14/09, les cycles 2027 (1 081,72 $) et 2028
-- (1 081,31 $) étaient AU-DESSUS du plus-haut enregistré (1 079,65 $) et n'ont jamais été vus.
-- Un coupe-circuit qui mesure depuis un sommet trop bas mord trop tard, dans le sens qui
-- compte.
--
-- Le code juge désormais la VALORISATION sur tout cycle qui a atteint un livre souverain, avant
-- l'appel au modèle. Aucune donnée existante n'est modifiée ici ; le rattrapage éventuel du
-- plus-haut est un acte séparé et revu.
--
-- ── CE QUE CETTE MIGRATION CHANGE : LE VOCABULAIRE DU JOURNAL, ET RIEN D'AUTRE ──
--
-- Deux valeurs entrent dans `exposure_band_observations.pilot_hold` :
--
--   `cycle_non_decide`  le pilote a jugé la valorisation (ses chiffres sont sur la ligne),
--                       mais le cycle a échoué avant qu'une cible existe : aucune correction
--                       n'a été jugée ni appliquée. Auparavant ces lignes portaient NULL,
--                       c'est-à-dire la valeur qui signifie « la correction a été autorisée à
--                       toucher les ordres » — l'ambiguïté que cette valeur retire.
--
--   `prix_de_repli`     une ligne DÉTENUE n'avait pas de prix vivant ce cycle et a été
--                       valorisée à son coût moyen. Un prix de repli ne peut ni établir un
--                       sommet ni déclencher un seuil irréversible ; la correction se tient
--                       en retrait ce cycle, et le pilote lui-même continue (le battement est
--                       écrit : une bougie sans lecture n'est pas un cycle non vu).
--
-- NULL ne signifie donc plus qu'une seule chose : la correction a été autorisée à toucher les
-- ordres ce cycle.

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
        'pilote_interrompu',
        'contrat_divergent',
        'equite_inutilisable',
        'prix_de_repli',
        'cycle_non_decide'
      )
    );

comment on column public.exposure_band_observations.pilot_hold is
  'Pourquoi la correction n''a pas touche les ordres ce cycle. NULL uniquement quand elle les a touches. `cycle_non_decide` : la valorisation a ete jugee mais le cycle a echoue avant toute cible (error, guard_failed, parse_failed, skipped). `prix_de_repli` : une ligne detenue sans prix vivant, aucun sommet ni seuil sur cette valorisation. En mode observation, vaut `mode_inactif` partout.';

comment on column public.exposure_band_observations.pilot_peak_equity_usd is
  'Le plus-haut du pilote tel que le coupe-circuit le voyait a cet instant, sur TOUT cycle ayant atteint un livre souverain — y compris un cycle en echec, dont la valorisation compte. Null tant qu''aucun pilote n''est actif, ou quand le cycle n''a jamais eu de livre fiable a juger.';
