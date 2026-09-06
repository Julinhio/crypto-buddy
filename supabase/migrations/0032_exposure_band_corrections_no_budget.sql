-- Migration 0032 — la comptabilité des suppressions devient exhaustive (`no_budget`)
--
-- Le passage de relais de la brique 2 nomme une limite connue et en fait un CRITÈRE
-- OBLIGATOIRE avant toute activation du pilote :
--
--   > Un achat abandonné faute de budget n'apparaît nulle part. Quand le cash est déjà au
--   > niveau de la réserve cible et que les ventes censées le financer sont toutes supprimées
--   > sous le seuil de 2 %, le budget d'achat est nul et `planMovements` saute la boucle
--   > d'achat entière. Les achats en attente ne figurent alors ni dans `movements`, ni dans
--   > `suppressed`.
--
-- La correction ajoute une quatrième raison de suppression. Elle est DISTINCTE des trois
-- autres, et c'est tout l'objet :
--
--   `movement_floor`  la jambe était trop petite pour valoir la peine d'être envoyée ;
--   `no_price`        la jambe ne pouvait pas être dimensionnée ;
--   `dust`            il n'y avait rien à bouger ;
--   `no_budget`       la jambe valait la peine, tenait au-dessus du seuil, et il n'y avait
--                     pas de quoi la payer.
--
-- Les fondre aurait laissé le seuil de 2 % prendre le crédit d'une contrainte de trésorerie —
-- la même famille de mauvaise attribution que la cause par ligne existe pour empêcher.
--
-- ── Ce que cette migration ne fait pas ────────────────────────────────────────
--
-- Elle n'élargit qu'un vocabulaire. Aucune ligne existante ne devient invalide : la contrainte
-- passe de trois valeurs admises à quatre, donc tout ce qui était accepté hier l'est encore.
-- Aucun ordre, aucun mouvement, aucune position n'est touché, ici comme dans le code : les
-- jambes concernées n'étaient pas envoyées avant et ne le sont pas davantage. Ce qui change,
-- c'est qu'elles sont déclarées.

alter table public.exposure_band_corrections
  drop constraint if exists exposure_band_corrections_suppressed_known;

alter table public.exposure_band_corrections
  add constraint exposure_band_corrections_suppressed_known
    check (
      suppressed_reason is null
      or suppressed_reason in ('movement_floor', 'no_price', 'dust', 'no_budget')
    );

comment on column public.exposure_band_corrections.suppressed_reason is
  'La jambe que le plan a refuse d''envoyer, et pourquoi. §3.3 et §3.6.4 : les mouvements supprimes doivent rester visibles, jamais absorbes dans un silence. Quatre raisons distinctes : `movement_floor` (sous le seuil de 2 %), `no_price` (non dimensionnable), `dust` (rien a bouger), `no_budget` (aucun cash au-dessus de la reserve cible pour la payer).';
