-- Migration 0035 — l'interruption du mode `application` invalide durablement le pilote
--
-- Arbitré, et c'est un durcissement : « Je n'accepte pas la reprise silencieuse avec un
-- plus-haut potentiellement manquant. Dès qu'une identité active connaît un cycle hors
-- `application`, cette interruption doit empêcher durablement sa reprise. »
--
-- ── CE QUE LA BRIQUE 4 FAISAIT, ET POURQUOI C'ÉTAIT INSUFFISANT ───────────────
--
-- Le plus-haut n'était suivi que pendant que le pilote était armé. Un passage temporaire en
-- `observation` laissait donc un trou : un sommet atteint pendant ce trou n'était pas
-- enregistré, et le drawdown mesuré au retour partait du dernier sommet CONNU — c'est-à-dire
-- sous-estimé, dans le sens qui fait mordre le coupe-circuit trop tard.
--
-- La limite était documentée. Elle est maintenant supprimée : une identité qui a connu un
-- trou ne reprend pas.
--
-- ── COMMENT LE TROU EST DÉTECTÉ — PAR LE JOURNAL, PAS PAR UN DRAPEAU ──────────
--
-- `last_seen_decision_id` est le dernier cycle DÉCIDÉ que le pilote a réellement vu. À chaque
-- cycle en `application`, le code compare ce nombre au dernier cycle décidé que la table
-- `decisions` contient. S'il en existe un plus récent, c'est qu'au moins un cycle a tourné
-- sans que le pilote le voie — et la seule façon d'en arriver là est que le mode n'était pas
-- `application`, ou que l'écriture du pilote n'a pas abouti.
--
-- La preuve ne dépend donc PAS d'un drapeau que le cycle interrompu aurait dû poser lui-même :
-- elle se lit dans le journal des décisions, qui est écrit quoi qu'il arrive. Un cycle
-- intermédiaire ne peut pas être ignoré, parce que c'est lui qui laisse la trace.
--
-- Un simple redémarrage avec `application` inchangé ne laisse aucun trou : les cycles décidés
-- se suivent, et la reprise se fait normalement depuis l'état persistant.
--
-- Les cycles `skipped` et `error` ne comptent pas : ils ne décident rien, ne passent pas par
-- le bloc du pilote et ne déplacent aucun ordre. Ce que l'invariant garantit est exactement
-- « aucun cycle DÉCIDÉ n'a tourné sans que le pilote le voie ».

alter table public.exposure_pilot
  add column if not exists last_seen_decision_id        bigint,
  add column if not exists interrupted_at               timestamptz,
  add column if not exists interrupted_decision_id      bigint,
  add column if not exists interrupted_after_decision_id bigint,
  add column if not exists interrupted_seen_decision_id bigint;

-- Un quatrième état terminal, aussi définitif que les deux autres.
alter table public.exposure_pilot
  drop constraint if exists exposure_pilot_status_known;

alter table public.exposure_pilot
  add constraint exposure_pilot_status_known
    check (status in ('active', 'stopped_drawdown', 'invalidated_contract', 'interrupted_mode'));

alter table public.exposure_pilot
  drop constraint if exists exposure_pilot_interruption_is_coherent;

alter table public.exposure_pilot
  add constraint exposure_pilot_interruption_is_coherent
    check ((status = 'interrupted_mode') = (interrupted_at is not null));

comment on column public.exposure_pilot.last_seen_decision_id is
  'Le dernier cycle DECIDE que le pilote a reellement vu. Un cycle decide plus recent dans `decisions` prouve qu''au moins un cycle a tourne sans lui — mode hors `application`, ou ecriture non aboutie — et cela invalide durablement l''identite.';

comment on column public.exposure_pilot.interrupted_at is
  'Instant ou l''interruption a ete constatee. L''identite ne peut plus se reactiver : un retour ulterieur de la variable a `application` ne la rearme pas.';

-- La cause correspondante dans le journal par cycle de la bande.
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
        'equite_inutilisable'
      )
    );
