-- Migration 0030 — exposure_band_corrections (le journal en quatre faits, par actif)
--
-- Une ligne par (cycle, actif). La 0028 répond « la bande a-t-elle mordu, de combien, et
-- était-ce faisable » au niveau du VECTEUR. Celle-ci répond « quelle LIGNE a absorbé quoi »,
-- ce qui est l'objet du §3.3 du protocole.
--
-- ── Les quatre faits, et pourquoi ils sont quatre colonnes et pas une ──────────
--
-- Un objectif d'allocation n'est pas une exécution. Le seuil de 2 %, l'arrondi Binance ou un
-- échec d'ordre peuvent laisser le livre ailleurs, et les confondre rendrait impossible de
-- distinguer « la bande n'a rien demandé » de « la bande a demandé et la plomberie a effacé ».
--
--   FAIT 1  raw_weight_percent        ce que le MODÈLE a proposé
--   FAIT 2  correction_points         ce que la BANDE a imposé, signé
--   FAIT 3  corrected_weight_percent  la cible finale pour le moteur d'exécution
--   FAIT 4  booked_* / post_cycle_*   ce qui a RÉELLEMENT bougé et ce que le livre tient
--
-- En mode `observation`, le fait 4 décrit le cycle réel du bot, qui n'est PAS corrigé. L'écart
-- entre le fait 3 et le fait 4 est donc exactement la non-application de la correction — c'est
-- voulu, et c'est ce qui rendra le passage en `application` lisible : les deux convergeront.
--
-- ── L'origine, et le compteur qu'elle permet ──────────────────────────────────
--
-- `origin` distingue trois choses que rien d'autre ne distingue ensuite :
--
--   `modele`                le poids du modèle, intact ;
--   `correction_de_bande`   la bande a mis à l'échelle une conviction que le modèle avait ;
--   `allocation_de_secours` la bande a posé du poids là où le modèle n'avait RIEN dit (§3.5.4).
--
-- Le troisième cas n'exprime aucune conviction du modèle, et il est nommé à part précisément
-- pour que personne ne le relise plus tard comme s'il en exprimait une.
--
-- Ces colonnes suffisent à dériver, en SQL et sans écriture supplémentaire dans le cycle, le
-- compteur demandé : sur les cycles suivants, le modèle demande-t-il de défaire une position
-- que le correcteur a créée. La requête vit dans `src/replay/exposureBandBite.ts` ; la faire
-- en lecture plutôt qu'en écriture évite d'ajouter un mode de panne au chemin de trading pour
-- une statistique.
--
-- ── Ce que la table ne fait pas ───────────────────────────────────────────────
--
-- Elle ne corrige rien. La brique 2 calcule et journalise ; le mode `application` reste refusé
-- par le binaire jusqu'à la dernière brique, et le chemin des ordres n'est pas touché.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run) AVANT de déployer le code qui l'écrit (règle dure du projet).

create table if not exists public.exposure_band_corrections (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  -- ON DELETE CASCADE : une correction sur une décision qui n'existe plus n'est la preuve
  -- de rien. Comme toute table portant une FK vers `decisions`, elle DOIT figurer dans le
  -- TRUNCATE de `reset_bot` — voir la migration 0031.
  decision_id bigint not null references public.decisions (id) on delete cascade,
  asset       text   not null,

  -- ── FAIT 1 — ce que le modèle a proposé ───────────────────────────────────────
  -- Null sur une ligne dont le cycle n'a pas journalisé de proposition brute.
  raw_weight_percent      numeric,
  -- La proposition APRÈS le plafonnement de risque : le point de départ de la correction.
  -- C'est là que la correction se placera quand elle deviendra effective — le garde a déjà
  -- jugé l'intention brute à ce moment, et la porte de transition n'a pas encore parlé.
  clamped_weight_percent  numeric not null,

  -- ── FAIT 2 — ce que la bande a imposé ─────────────────────────────────────────
  -- Signé : positif vers le plancher, négatif vers le plafond, zéro si rien n'a bougé.
  correction_points       numeric not null,
  origin                  text    not null,
  -- Pourquoi la ligne n'a pas absorbé ce que la bande lui demandait. Du plus spécifique au
  -- moins : un gel est un gel quoi qu'il arrive, un plafond atteint l'est quoi que dise le
  -- seuil, et la plomberie n'est blâmée qu'en dernier. Les confondre laisserait le seuil de
  -- 2 % prendre le crédit d'un gel, ce que ce journal existe pour empêcher.
  cause                   text    not null,

  -- ── FAIT 3 — la cible finale ──────────────────────────────────────────────────
  corrected_weight_percent numeric not null,

  -- ── le contexte de la ligne ───────────────────────────────────────────────────
  -- Le poids dans le LIVRE avant la décision : là où la ligne reste si sa jambe est supprimée.
  book_weight_percent     numeric not null,
  cap_percent             numeric not null,
  gate                    text,
  may_increase            boolean not null,
  may_decrease            boolean not null,

  -- ── ce que la correction PRODUIRAIT comme mouvement ──────────────────────────
  planned_side            text,
  planned_notional_quote  numeric,
  -- La jambe que le seuil de mouvement a effacée, et pourquoi. §3.3 et §3.6.4 : les mouvements
  -- supprimés par le seuil de 2 % doivent RESTER VISIBLES.
  suppressed_reason       text,
  suppressed_notional_quote numeric,

  -- ── FAIT 4 — ce qui a réellement bougé, et ce que le livre tient ─────────────
  -- En mode `observation` ce sont les mouvements du bot, pas ceux de la correction.
  booked_side             text,
  booked_notional_quote   numeric,
  post_cycle_weight_percent numeric,

  constraint exposure_band_corrections_unique_per_cycle_asset unique (decision_id, asset),
  constraint exposure_band_corrections_origin_known
    check (origin in ('modele', 'correction_de_bande', 'allocation_de_secours')),
  constraint exposure_band_corrections_cause_known
    check (cause in ('aucune', 'gel', 'plafond_individuel', 'seuil_de_mouvement', 'autre_impossibilite')),
  constraint exposure_band_corrections_sides_known
    check (
      (planned_side is null or planned_side in ('buy', 'sell'))
      and (booked_side is null or booked_side in ('buy', 'sell'))
    ),
  constraint exposure_band_corrections_suppressed_known
    check (suppressed_reason is null or suppressed_reason in ('movement_floor', 'no_price', 'dust')),
  -- Les faits 2 et 3 doivent se reconstruire l'un l'autre : une correction dont les trois
  -- nombres ne s'additionnent pas n'est pas une correction, c'est trois colonnes.
  constraint exposure_band_corrections_facts_reconcile
    check (abs((clamped_weight_percent + correction_points) - corrected_weight_percent) < 0.000001),
  -- Une ligne que la bande n'a pas touchée porte l'origine du modèle, et réciproquement.
  constraint exposure_band_corrections_origin_matches_move
    check ((correction_points = 0) = (origin = 'modele'))
);

comment on table public.exposure_band_corrections is
  'Le journal en quatre faits du pilote d''exposition contrainte, une ligne par (cycle, actif) : ce que le modele a propose, ce que la bande a impose, la cible finale, et ce qui a reellement bouge. En mode observation le fait 4 decrit le cycle reel du bot, qui n''est pas corrige — l''ecart avec le fait 3 EST la non-application de la correction.';

comment on column public.exposure_band_corrections.origin is
  'modele / correction_de_bande / allocation_de_secours. Le troisieme n''exprime AUCUNE conviction du modele (§3.5.4) et est nomme a part pour que personne ne le relise plus tard comme s''il en exprimait une.';

comment on column public.exposure_band_corrections.cause is
  'Du plus specifique au moins : un gel est un gel quoi qu''il arrive, un plafond atteint l''est quoi que dise le seuil, la plomberie n''est blamee qu''en dernier. Les confondre laisserait le seuil de 2 % prendre le credit d''un gel.';

comment on column public.exposure_band_corrections.suppressed_reason is
  'La jambe que le seuil de mouvement a effacee. §3.3 et §3.6.4 : les mouvements supprimes par le seuil de 2 % doivent rester visibles, jamais absorbes dans un silence.';

comment on column public.exposure_band_corrections.post_cycle_weight_percent is
  'Le poids REELLEMENT detenu apres le cycle. Un objectif d''allocation n''est pas une execution : le seuil, l''arrondi Binance ou un echec d''ordre peuvent laisser le livre ailleurs.';

-- « Un cycle, toutes ses lignes » — l'audit d'un réveil.
create index if not exists exposure_band_corrections_decision_idx
  on public.exposure_band_corrections (decision_id);

-- « Un actif dans le temps » — la série sur laquelle le compteur « le modèle défait-il ce que
-- le correcteur a créé » se lit.
create index if not exists exposure_band_corrections_asset_time_idx
  on public.exposure_band_corrections (asset, created_at desc);

-- La requête vedette — « quelles lignes la bande a-t-elle réellement touchées » — sur une
-- table où la majorité des lignes ne portent aucune correction. Partielle, donc elle reste
-- petite à quatre lignes par cycle.
create index if not exists exposure_band_corrections_moved_idx
  on public.exposure_band_corrections (created_at desc)
  where origin <> 'modele';

-- Row Level Security : ACTIVÉE sans aucune policy (deny-all), même posture que toutes les
-- autres tables. C'est la base de preuves sur laquelle la lecture finale du pilote sera faite ;
-- un journal modifiable est un argument modifiable.
alter table public.exposure_band_corrections enable row level security;

-- ── Le niveau VECTEUR de la correction, sur la table de la 0028 ────────────────
--
-- La 0028 publie où la cible se situe par rapport à la bande et ce que les gels et les
-- plafonds laissent atteindre. La correction ajoute trois choses qu'elle ne pouvait pas
-- connaître, parce qu'elles demandent la répartition :
--
--   * la cible corrigée réelle, une fois la répartition faite ;
--   * ce que le LIVRE tiendrait vraiment, une fois le seuil de 2 % passé par là ;
--   * si la consolidation du §3.5.5 a servi, et combien de fois elle a été essayée.
--
-- DEUX ÉCARTS, PAS UN. `unrealisable_points` (0028) mesure ce que les GELS et les PLAFONDS
-- rendent impossible. `realised_gap_points` mesure ce qui reste hors bande une fois la
-- PLOMBERIE passée aussi. Leur différence est exactement la part de l'écart imputable au
-- seuil de mouvement, et fusionner les deux colonnes rendrait cette attribution indérivable.
alter table public.exposure_band_observations
  add column if not exists corrected_exposure_percent numeric,
  add column if not exists realised_exposure_percent  numeric,
  add column if not exists realised_gap_points        numeric,
  add column if not exists consolidated               boolean,
  add column if not exists consolidation_rounds       integer,
  add column if not exists consolidation_attempts     integer,
  add column if not exists planned_movements          integer,
  add column if not exists suppressed_movements       integer;

comment on column public.exposure_band_observations.realised_exposure_percent is
  'Ce que le LIVRE tiendrait apres le cycle, une fois le seuil de 2 % passe : le poids corrige la ou la jambe survit, le poids du LIVRE la ou elle est effacee. Ce n''est pas la cible, et c''est le nombre sur lequel la bande est reellement jugee.';

comment on column public.exposure_band_observations.realised_gap_points is
  'Points encore hors bande une fois les gels, les plafonds ET la plomberie passes. unrealisable_points ne compte que les deux premiers ; la difference est la part imputable au seuil de mouvement.';

comment on column public.exposure_band_observations.consolidated is
  'Vrai quand le plan retenu est un plan RETRECI (§3.5.5). Faux quand le retrecissement a ete essaye et n''a rien change — un deficit valant environ un seuil de mouvement ne peut pas etre sauve par la concentration, parce qu''une jambe d''ACHAT calibree sur le seuil en ressort juste en dessous une fois les frais pris sur le budget. consolidation_attempts separe « rien a faire » de « tout essaye, rien n''a marche ».';
