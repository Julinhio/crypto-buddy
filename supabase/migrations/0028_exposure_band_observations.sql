-- Migration 0028 — exposure_band_observations (pilote d'exposition contrainte, mode OBSERVATION)
--
-- Une ligne par cycle : le contexte déterministe que le contrôleur consomme, la bande A qui
-- en découle, où la cible retenue se situe par rapport à cette bande, et — la partie qui
-- compte le plus — ce que les gels et les plafonds par actif laissent RÉELLEMENT atteindre.
--
-- La bande ne corrige RIEN dans cette brique. Elle calcule et elle écrit ici ; l'allocation
-- du modèle est appliquée exactement comme avant. Le passage en mode `application` arrive
-- avec la dernière brique du pilote, et le binaire refuse cette valeur d'ici là.
--
-- ── À quoi cette table sert ─────────────────────────────────────────────────────
--
-- Répondre, en SQL et après n'importe quel redémarrage : combien de cycles la bande aurait
-- corrigés, dans quel sens, de combien de points, dans quel contexte — et sur combien
-- d'entre eux la borne était INATTEIGNABLE parce que les lignes actionnables ne suffisaient
-- pas. Ce dernier chiffre n'est pas une curiosité : sur l'historique v5, le plancher est
-- hors d'atteinte sur environ un cycle sur dix, et certains cycles n'ont aucune ligne
-- actionnable du tout.
--
-- ── Le contrat de gel, et pourquoi il est plus strict que la porte ──────────────
--
-- Arbitré : le code ne crée pas lui-même d'ordre sur une ligne que la couche de transition
-- déclare gelée, QUEL QUE SOIT `TRANSITION_MODE`. La contrainte porte sur les mouvements de
-- la correction et sur eux seuls — elle ne bascule pas la porte en `enforce` et ne touche
-- pas au vecteur brut du modèle. `increasable_assets` / `decreasable_assets` publient donc
-- ce que la correction s'autorise, qui est aujourd'hui plus étroit que ce que le modèle
-- s'autorise. La différence est une donnée, pas un défaut.
--
-- ── Lire target_exposure_percent ───────────────────────────────────────────────
--
-- C'est la SOMME des poids non-réserve, jamais `100 − réserve`. Les deux coïncident dès que
-- l'allocation totalise 100 — ce que le schéma impose et que les 884 lignes v5 respectent —
-- et quand elles divergent c'est la somme qui est honnête. `target_sum_percent` est publié à
-- côté pour que la divergence, si elle apparaît un jour, se voie.
--
-- ── Une donnée absente n'est jamais un contexte neutre ─────────────────────────
--
-- `gap` nomme la raison pour laquelle une ligne ne porte pas d'évaluation : `no_regime`,
-- `unclassifiable_regime`, `no_target`. Aucune des trois ne devient `neutral`. Le protocole
-- de fermeture compte des bougies par famille, et gonfler la famille non constructive avec
-- de l'absence décalerait la date d'arrêt du pilote.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run) AVANT de déployer le code qui l'écrit (règle dure du projet).

create table if not exists public.exposure_band_observations (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  -- Le cycle. ON DELETE CASCADE : une observation sur une décision qui n'existe plus n'est
  -- la preuve de rien.
  decision_id bigint not null references public.decisions (id) on delete cascade,

  -- Le mode sous lequel la ligne a été écrite (`observation` aujourd'hui). Stocké par ligne
  -- et non déduit d'une date : c'est une variable d'environnement, elle peut changer entre
  -- deux cycles, et l'attribution a posteriori depuis un journal qui ne l'enregistre pas est
  -- exactement le trou que la couche de transition a déjà rencontré.
  mode           text not null,
  -- La version de la politique de bande (`A`). Une politique changée doit être lisible comme
  -- telle, jamais déduite de six nombres.
  policy_version text not null,

  -- ── le contexte déterministe, par la fonction de production ───────────────────
  -- La bougie 4h sur laquelle le régime a été calculé — PAS l'heure du réveil. Le bot se
  -- réveille 3 à 7 fois dans une même bougie et elles partagent un seul contexte.
  bar_at        timestamptz,
  -- `defensive` / `neutral` / `constructive`, par `readContext` — importée, jamais réécrite.
  state         text,
  -- La posture globale de production, calculée sur 5 actifs (SOL compris). La largeur nette
  -- ci-dessous est calculée sur les 4 allouables. Les deux estimateurs diffèrent, et l'état
  -- hérite des deux : divergence réelle, journalisée plutôt que lissée.
  risk_off      boolean,
  net_breadth   numeric,
  bullish       integer,
  bearish       integer,
  neutral       integer,
  unavailable   integer,
  -- L'empreinte de la LECTURE ENTIÈRE, pour le contrôle d'intégrité par bougie. Pas une
  -- poignée d'agrégats : deux dérives opposées dans une même bougie s'y annuleraient.
  context_fingerprint text,
  universe      text[] not null default '{}',

  -- ── la bande ──────────────────────────────────────────────────────────────────
  band_low_percent  numeric,
  band_high_percent numeric,

  -- ── les expositions ───────────────────────────────────────────────────────────
  raw_exposure_percent    numeric,
  target_exposure_percent numeric,
  target_sum_percent      numeric,
  -- Le livre AVANT la décision de ce cycle — ce que le modèle avait sous les yeux.
  book_exposure_percent   numeric,
  -- Poids porté par une ligne qu'un peak stop sort ce cycle. Zéro sur presque tous.
  stopped_weight_percent  numeric,

  -- ── la correction, au niveau du vecteur ───────────────────────────────────────
  direction                    text,
  required_exposure_percent    numeric,
  required_points              numeric,
  -- Où la correction atterrirait réellement, une fois les gels et les plafonds appliqués.
  attainable_exposure_percent  numeric,
  -- Points encore hors bande après la correction maximale faisable. Strictement positif =
  -- le cas §3.4.4, journalisé plutôt qu'attendu en silence.
  unrealisable_points          numeric,
  label                        text,

  -- ── la faisabilité, en détail ─────────────────────────────────────────────────
  -- FAUX quand la couche de transition n'a produit aucun verdict pour ce cycle. En vivant
  -- c'est impossible — `decide()` calcule un verdict par actif tradable avant même d'appeler
  -- le modèle. Ça arrive dans le REJEU HISTORIQUE, sur les deux semaines de v5 antérieures à
  -- la couche : là, « toutes les lignes sont non jugées » est un fait sur le journal, pas sur
  -- le marché. Sans ce drapeau, ces cycles porteraient `bande_partiellement_irrealisable`,
  -- qui AFFIRME que les gels ont bloqué la correction. Ils ne l'ont peut-être pas fait ; nous
  -- n'en avons simplement aucune trace. Les colonnes de faisabilité sont donc nulles plutôt
  -- que calculées sur un ensemble de verdicts vide.
  feasibility_known    boolean,
  increasable_assets   text[] not null default '{}',
  decreasable_assets   text[] not null default '{}',
  -- Actifs portant du poids pour lesquels la couche n'a produit aucun verdict. Échoue fermé,
  -- et se nomme : la correction ne doit pas être ce qui découvre une divergence d'univers.
  unjudged_assets      text[] not null default '{}',
  reserved_up_percent   numeric,
  reserved_down_percent numeric,
  max_reachable_percent numeric,
  min_reachable_percent numeric,

  -- ── la plomberie ──────────────────────────────────────────────────────────────
  attainable_notional_quote numeric,
  movement_floor_quote      numeric,
  -- NÉCESSAIRE, PAS SUFFISANT. `false` prouve que la correction serait inerte ; `true` ne
  -- prouve pas qu'elle passerait — répartie sur quatre lignes, un total de 2,5 seuils donne
  -- quatre jambes sous le seuil et rien d'envoyé. Trancher demande la répartition, qui est
  -- la brique suivante.
  clears_movement_floor     boolean,

  -- Le détail par actif : poids, verdict de porte, et ce que la correction s'autoriserait.
  lines jsonb,

  -- ── l'absence, nommée ─────────────────────────────────────────────────────────
  gap        text,
  gap_detail text,

  constraint exposure_band_observations_unique_per_cycle unique (decision_id),
  constraint exposure_band_observations_mode_known
    check (mode in ('observation', 'application')),
  constraint exposure_band_observations_gap_known
    check (gap is null or gap in ('no_regime', 'unclassifiable_regime', 'no_target')),
  constraint exposure_band_observations_state_known
    check (state is null or state in ('defensive', 'neutral', 'constructive')),
  constraint exposure_band_observations_direction_known
    check (direction is null or direction in ('none', 'up', 'down')),
  constraint exposure_band_observations_label_known
    check (
      label is null
      or label in (
        'aucune_correction',
        'hausse_vers_plancher',
        'baisse_vers_plafond',
        'bande_partiellement_irrealisable'
      )
    ),
  -- Une ligne porte une évaluation OU une raison de ne pas en porter, jamais ni l'une ni
  -- l'autre. Sans cette contrainte, une ligne muette serait indiscernable d'une ligne où la
  -- bande n'a rien eu à dire, et le dénominateur de chaque taux publié deviendrait douteux.
  constraint exposure_band_observations_assessed_or_explained
    check ((label is null) = (gap is not null))
);

comment on table public.exposure_band_observations is
  'Pilote d''exposition contrainte, mode OBSERVATION : une ligne par cycle avec le contexte déterministe (readContext), la bande A, la position de la cible retenue par rapport à la bande, et ce que les gels et les plafonds laissent réellement atteindre. Ne corrige rien — l''allocation du modèle est appliquée inchangée. La correction arrive avec la brique suivante.';

comment on column public.exposure_band_observations.target_exposure_percent is
  'Somme des poids NON-RÉSERVE de la cible retenue, jamais 100 − réserve. target_sum_percent publie le total à côté pour qu''une divergence se voie au lieu d''être absorbée.';

comment on column public.exposure_band_observations.unrealisable_points is
  'Points encore hors bande après la correction maximale faisable, une fois les gels et les plafonds appliqués. Strictement positif sur environ un cycle sur dix de l''historique v5 : ce n''est pas un cas limite.';

comment on column public.exposure_band_observations.clears_movement_floor is
  'NÉCESSAIRE, PAS SUFFISANT : false prouve l''inertie de la correction, true ne prouve pas qu''elle passerait une fois répartie en jambes.';

comment on column public.exposure_band_observations.feasibility_known is
  'Faux quand aucun verdict de transition n''existe pour ce cycle (rejeu historique d''avant le 08/08). Les colonnes de faisabilite sont alors nulles : « inconnu » et « bloque par les gels » sont deux faits differents et ne doivent jamais se confondre.';

comment on column public.exposure_band_observations.gap is
  'Pourquoi la ligne ne porte pas d''évaluation. Aucune de ces trois raisons ne devient un contexte neutre — le protocole de fermeture compte des bougies par famille, et gonfler une famille avec de l''absence décalerait la date d''arrêt.';

comment on column public.exposure_band_observations.context_fingerprint is
  'Empreinte de la lecture ENTIÈRE du contrôleur, pour le contrôle d''intégrité par bougie. Deux cycles d''une même bougie 4h doivent porter la même : sinon le rejeu échoue bruyamment.';

-- « Un cycle » — l'audit d'un réveil, et la jointure avec decisions.
create index if not exists exposure_band_observations_decision_idx
  on public.exposure_band_observations (decision_id);

-- « Une bougie, tous ses cycles » — le contrôle d'intégrité et le comptage de couverture du
-- protocole de fermeture passent tous les deux par là.
create index if not exists exposure_band_observations_bar_idx
  on public.exposure_band_observations (bar_at, decision_id);

-- La requête vedette — « quels cycles la bande aurait-elle corrigés » — sur une table où une
-- bonne part des lignes ne porte aucune correction. Partielle, donc elle reste petite.
create index if not exists exposure_band_observations_corrections_idx
  on public.exposure_band_observations (created_at desc)
  where label is not null and label <> 'aucune_correction';

-- Row Level Security : ACTIVÉE sans aucune policy (deny-all), même posture que toutes les
-- autres tables. Le backend utilise la clé service role, qui contourne RLS ; toute clé
-- anon/publique est refusée.
--
-- Cela compte ici pour une raison propre à cette table : c'est la base de preuves sur
-- laquelle le point de contrôle obligatoire sera lu, et sur laquelle la décision d'armer ou
-- non le mode `application` sera prise. Un journal d'observation modifiable est un argument
-- modifiable.
alter table public.exposure_band_observations enable row level security;
