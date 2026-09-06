-- Migration 0033 — exposure_pilot (l'identité persistante du pilote et son coupe-circuit)
--
-- §3.8 et §3.9 du protocole. Cette table porte la seule chose du chantier qui doit survivre à
-- tout : un redémarrage Railway, une désactivation temporaire de la variable, un nouveau
-- déploiement. Le drawdown ne se remet jamais à zéro, et le plus-haut non plus.
--
-- ── UNE SEULE IDENTITÉ, GARANTIE PAR LA BASE ──────────────────────────────────
--
-- « La même identité de pilote ne peut pas se réactiver automatiquement après un redémarrage
-- ou une modification de variable. » Arbitré plus loin : aucun mécanisme automatique de
-- génération suivante n'existe, et un pilote suivant exigera une opération administrative
-- explicite et revue.
--
-- L'index unique ci-dessous rend cette règle STRUCTURELLE plutôt que disciplinaire : la base
-- refuse une deuxième ligne, quelle que soit la course, le bug ou la faute de frappe. Créer le
-- pilote suivant supposera de lever cet index à la main — c'est-à-dire exactement l'acte
-- délibéré et revu que l'arbitrage demande, et rien de moins.
--
-- ── CE QUE LE COUPE-CIRCUIT FAIT, ET SURTOUT CE QU'IL NE FAIT PAS ─────────────
--
--   40 %  une alerte unique et une photographie. La correction CONTINUE de s'appliquer :
--         ce barreau est un avertissement, et en faire un arrêt désarmerait l'expérience à
--         l'instant précis où son résultat devient intéressant.
--   50 %  la correction de bande s'arrête, durablement. AUCUNE liquidation forcée, aucun
--         verdict de stratégie, et le bot v5 continue exactement comme avant.
--
-- ── LA FENÊTRE DE MESURE SE FERME, PAS L'APPLICATION ──────────────────────────
--
-- Arbitré. À huit semaines la fenêtre se ferme si la couverture requise est atteinte, sinon
-- elle court jusqu'à douze où elle se ferme dans tous les cas avec son libellé. Aucun cycle
-- postérieur n'entre dans les résultats officiels, C8 compris.
--
-- La correction, elle, continue après la clôture en attendant notre décision. Se désarmer sur
-- une date réarrangerait le portefeuille à un instant arbitraire, pour une raison qui n'a rien
-- à voir avec le risque.

create table if not exists public.exposure_pilot (
  id                            bigint primary key generated always as identity,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  -- L'EMPREINTE DU CONTRAT. Elle couvre les VALEURS : version de politique et de contrat,
  -- six bornes, univers et plafonds par actif, frais et seuil de mouvement, seuils de
  -- drawdown, durées et couverture requise. Elle n'inclut PAS le SHA git — un commentaire ou
  -- un renommage ne doit pas tuer une expérience de huit semaines — et la contrepartie est que
  -- `contract_version` se déplace à la main quand le comportement change.
  contract_sha256               text not null,
  contract_version              text not null,
  band_version                  text not null,

  -- L'INSTANT OFFICIEL. Il ne se dépense qu'une fois : l'equity du pilote, son plus-haut, son
  -- horloge de huit semaines et l'ouverture des témoins commencent tous ici.
  activated_at                  timestamptz not null,
  activated_decision_id         bigint,
  opening_equity_usd            numeric not null,

  -- LE PLUS-HAUT. Il ne fait que monter, et il survit à tout.
  peak_equity_usd               numeric not null,
  peak_decision_id              bigint,

  status                        text not null default 'active',

  -- 40 % — une fois pour ce pilote. `delivered` distingue « l'alerte a été décidée » de
  -- « l'alerte est partie » : une alerte unique manquée doit se voir, pas se deviner.
  alert_drawdown_at             timestamptz,
  alert_drawdown_decision_id    bigint,
  alert_drawdown_percent        numeric,
  alert_drawdown_equity_usd     numeric,
  alert_drawdown_delivered      boolean not null default false,

  -- 50 % — l'arrêt persistant de la seule correction de bande.
  stopped_at                    timestamptz,
  stopped_decision_id           bigint,
  stopped_drawdown_percent      numeric,
  stopped_equity_usd            numeric,

  -- Le contrat a divergé : le pilote est invalidé durablement. Un retour à l'ancienne
  -- configuration ne le réactive pas.
  invalidated_at                timestamptz,
  invalidated_decision_id       bigint,
  invalidated_seen_sha256       text,

  -- La fenêtre de MESURE, fermée par l'horloge et la couverture — jamais par le coupe-circuit.
  window_closed_at              timestamptz,
  window_closed_decision_id     bigint,
  window_closure_label          text,
  window_constructive_bars      integer,
  window_non_constructive_bars  integer,

  constraint exposure_pilot_status_known
    check (status in ('active', 'stopped_drawdown', 'invalidated_contract')),

  constraint exposure_pilot_closure_label_known
    check (window_closure_label is null
           or window_closure_label in ('couverture_atteinte', 'couverture_de_contexte_insuffisante')),

  -- Le plus-haut ne descend jamais sous l'equity d'ouverture : c'est lui-même à l'activation.
  constraint exposure_pilot_peak_at_least_opening
    check (peak_equity_usd >= opening_equity_usd - 0.000001),

  -- Un statut terminal SANS son instant serait un arrêt que personne ne peut dater, et un
  -- instant SANS son statut un arrêt que le code ne lirait pas. Les deux ensemble, ou aucun.
  constraint exposure_pilot_stop_is_coherent
    check ((status = 'stopped_drawdown') = (stopped_at is not null)),

  constraint exposure_pilot_invalidation_is_coherent
    check ((status = 'invalidated_contract') = (invalidated_at is not null)),

  -- Une fenêtre fermée porte toujours son libellé de couverture.
  constraint exposure_pilot_closure_is_coherent
    check ((window_closed_at is null) = (window_closure_label is null))
);

-- UNE SEULE LIGNE, POUR TOUJOURS — voir l'en-tête. C'est la garantie structurelle que rien
-- d'automatique ne peut démarrer un deuxième pilote.
create unique index if not exists exposure_pilot_singleton
  on public.exposure_pilot ((true));

comment on table public.exposure_pilot is
  'L''identite persistante du pilote d''exposition contrainte et son coupe-circuit. Une seule ligne, garantie par index unique : aucun mecanisme automatique ne peut creer un pilote suivant, cela reste une operation administrative explicite.';

comment on column public.exposure_pilot.contract_sha256 is
  'Empreinte canonique du contrat en VALEURS (politique, bornes, univers, plafonds, frais, seuil, seuils de drawdown, durees, couverture). N''inclut PAS le SHA git : une modification sans effet sur le contrat ne doit pas tuer l''experience.';

comment on column public.exposure_pilot.peak_equity_usd is
  'Le plus-haut d''equite depuis l''activation. Il ne fait que monter et survit aux redemarrages : un plus-haut remis a zero afficherait un drawdown nul le lendemain du pire jour du pilote.';

comment on column public.exposure_pilot.status is
  'active | stopped_drawdown (50 %, correction desarmee durablement, aucune liquidation) | invalidated_contract. Les deux etats terminaux sont DEFINITIFS pour cette identite.';

comment on column public.exposure_pilot.window_closed_at is
  'Cloture de la fenetre de MESURE (§7), jamais de l''application. Aucun cycle posterieur n''entre dans les resultats officiels, C8 compris ; la correction, elle, continue.';

-- Row Level Security : ACTIVÉE sans aucune policy (deny-all), même posture que toutes les
-- autres tables du bot. Le service role du bot passe outre ; personne d'autre ne lit.
alter table public.exposure_pilot enable row level security;
