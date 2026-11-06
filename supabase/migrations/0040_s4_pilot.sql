-- Migration 0040 — le pilote « S4 testnet » : l'état de S4, son journal de clôtures, son coupe-circuit
--
-- Chantier du 06/11/2026. S4 (protocole de sortie v0.4, « Go pilote testnet » sur le gel f2cc048)
-- devient le seul décideur de la cible. Le modèle sort du chemin des ordres.
--
-- ── TROIS TABLES, ADDITIVES ───────────────────────────────────────────────────
--
--   s4_pilot            une seule ligne (id = 1, garanti par la base) : l'identité du pilote
--                       (début, cycle, SHA, capital de départ), la dernière clôture journalière
--                       consommée, l'exécution en attente et le coupe-circuit `orders_enabled`.
--   s4_line_state       une ligne par actif : en marché ou hors marché, entrée, plus-haut suivi,
--                       sortie, recroisement armé, raison du dernier mouvement.
--   s4_close_decisions  le journal : une ligne par (clôture, actif), UNIQUE. Une même clôture ne
--                       peut produire qu'une décision, et la base le refuse sinon.
--
-- L'ancien pilote `exposure_pilot` (identité A.1, close le 01/11/2026) n'est NI lu, NI écrit, NI
-- modifié par cette migration ni par le code S4 : son historique reste immuable.
--
-- ── UNE CLÔTURE, UNE TRANSACTION ──────────────────────────────────────────────
--
-- `s4_commit_closes` écrit l'état des quatre actifs, le journal et la nouvelle dernière clôture
-- dans UNE transaction, sous condition (`last_close_at` = la valeur lue au début du cycle). Deux
-- cycles concurrents ne peuvent donc pas consommer la même clôture : le second échoue, n'écrit
-- rien et ne place aucun ordre. L'unicité du journal en est la seconde serrure.
--
-- ── LE COUPE-CIRCUIT ──────────────────────────────────────────────────────────
--
-- `update s4_pilot set orders_enabled = false where id = 1;` arrête tout NOUVEL ordre dès le cycle
-- suivant, sans redéploiement. Les cycles continuent de lire le marché, de décider l'état S4 et
-- de journaliser. Rien ne réactive l'ancienne stratégie : elle n'a plus aucun chemin vers les
-- ordres.

create table if not exists public.s4_pilot (
  id                        smallint primary key default 1 check (id = 1),
  label                     text not null default 'S4 testnet',
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- D'où vient l'état de départ : la reconstruction rejouée sur le banc (voir la PR).
  seed_source               jsonb not null,
  -- L'IDENTITÉ, écrite par le premier cycle S4, une seule fois.
  started_at                timestamptz,
  start_decision_id         bigint references public.decisions(id),
  start_git_sha             text,
  starting_equity_usd       numeric,
  orders_enabled            boolean not null default true,
  -- La dernière clôture journalière UTC (minuit) dont la décision est enregistrée.
  last_close_at             timestamptz not null,
  -- Posée avant les ordres d'un cycle, effacée après : sa présence au cycle suivant signale une
  -- exécution interrompue, rapprochée depuis le livre.
  pending_execution         jsonb,
  -- Anti-rafale de l'alerte « clôture manquante » : la clôture déjà signalée.
  blocked_close_alerted     timestamptz,
  constraint s4_pilot_last_close_is_midnight check (extract(epoch from last_close_at)::bigint % 86400 = 0),
  constraint s4_pilot_identity_is_whole check (
    (started_at is null) = (start_decision_id is null)
    and (started_at is null) = (starting_equity_usd is null)
  )
);

comment on table public.s4_pilot is
  'Le pilote S4 testnet (06/11/2026) : une seule ligne. Identité (début, cycle, SHA, capital de départ), dernière clôture journalière consommée, exécution en attente, coupe-circuit orders_enabled. Coexiste avec exposure_pilot (A.1), qui reste immuable.';

create table if not exists public.s4_line_state (
  asset              text primary key,
  status             text not null check (status in ('in', 'out')),
  entry_at           timestamptz,
  entry_price        numeric,
  high               numeric,
  exit_at            timestamptz,
  days_out           integer,
  armed              boolean not null default false,
  last_move_reason   text check (last_move_reason is null or last_move_reason in
                       ('reprise_etat_banc', 'transition_initiale', 'sortie_s4', 'rachat_s4', 'reequilibrage')),
  last_move_at       timestamptz,
  updated_at         timestamptz not null default now(),
  constraint s4_line_out_has_exit check ((status = 'out') = (exit_at is not null)),
  constraint s4_line_out_has_no_entry check (status = 'in' or (entry_at is null and high is null))
);

comment on table public.s4_line_state is
  'État S4 par actif : en marché ou hors marché, entrée (exécution flat → détenu) et son prix, plus-haut des clôtures journalières depuis l''entrée, sortie, jours hors marché, recroisement de la moyenne 50 j armé, raison du dernier mouvement.';

create table if not exists public.s4_close_decisions (
  id               bigint primary key generated always as identity,
  close_at         timestamptz not null,
  asset            text not null,
  event            text not null check (event in ('exit', 'rebuy', 'armed', 'high', 'hold')),
  close            numeric not null,
  sma50            numeric not null,
  status_before    text not null check (status_before in ('in', 'out')),
  status_after     text not null check (status_after in ('in', 'out')),
  high_before      numeric,
  high_after       numeric,
  threshold_price  numeric,
  armed_after      boolean not null,
  days_out         integer,
  git_sha          text,
  decision_id      bigint references public.decisions(id),
  decided_at       timestamptz not null default now(),
  constraint s4_close_decisions_once unique (close_at, asset)
);

comment on table public.s4_close_decisions is
  'Journal S4 : une ligne par (clôture journalière UTC, actif), unique. Une même clôture ne produit jamais deux décisions.';

alter table public.s4_pilot enable row level security;
alter table public.s4_line_state enable row level security;
alter table public.s4_close_decisions enable row level security;

-- ── LA TRANSACTION D'UNE OU PLUSIEURS CLÔTURES ────────────────────────────────

create or replace function public.s4_commit_closes(
  p_expected_last_close timestamptz,
  p_new_last_close      timestamptz,
  p_lines               jsonb,
  p_journal             jsonb,
  p_git_sha             text
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.s4_pilot
     set last_close_at = p_new_last_close, updated_at = now()
   where id = 1 and last_close_at = p_expected_last_close and p_new_last_close > p_expected_last_close;
  if not found then
    return false;
  end if;

  update public.s4_line_state s
     set status = x.status, entry_at = x.entry_at, entry_price = x.entry_price, high = x.high,
         exit_at = x.exit_at, days_out = x.days_out, armed = x.armed,
         last_move_reason = x.last_move_reason, last_move_at = x.last_move_at, updated_at = now()
    from jsonb_to_recordset(p_lines) as x(
           asset text, status text, entry_at timestamptz, entry_price numeric, high numeric,
           exit_at timestamptz, days_out integer, armed boolean, last_move_reason text, last_move_at timestamptz)
   where s.asset = x.asset;

  insert into public.s4_close_decisions
         (close_at, asset, event, close, sma50, status_before, status_after, high_before, high_after,
          threshold_price, armed_after, days_out, git_sha)
  select x.close_at, x.asset, x.event, x.close, x.sma50, x.status_before, x.status_after, x.high_before,
         x.high_after, x.threshold_price, x.armed_after, x.days_out, p_git_sha
    from jsonb_to_recordset(p_journal) as x(
           close_at timestamptz, asset text, event text, close numeric, sma50 numeric, status_before text,
           status_after text, high_before numeric, high_after numeric, threshold_price numeric,
           armed_after boolean, days_out integer);
  -- Une violation de `s4_close_decisions_once` lève une exception : TOUTE la transaction est
  -- annulée, dernière clôture comprise.
  return true;
end;
$$;

comment on function public.s4_commit_closes is
  'Consomme une ou plusieurs clôtures S4 en une transaction : état des actifs, journal unique par (clôture, actif) et dernière clôture, sous condition sur la dernière clôture lue. Renvoie false si une autre exécution l''a déjà consommée.';

-- ── LES LIGNES « decided » DE S4 ──────────────────────────────────────────────
--
-- `decisions_decided_complete` exige les champs que le MODÈLE remplissait (confiance, état de
-- marché, délai demandé…). Une ligne S4 n'a pas de modèle : elle les laisse NULL plutôt que d'en
-- inventer. La contrainte est remplacée par une version qui exige, pour une ligne S4
-- (`prompt_version` 's4-…'), ce que le code S4 produit vraiment.

alter table public.decisions drop constraint if exists decisions_decided_complete;
alter table public.decisions add constraint decisions_decided_complete check (
  status <> 'decided'
  or (
    prompt_version like 's4-%'
    and target_allocation is not null
    and applied_allocation is not null
    and action_type is not null
    and what_changed is not null
    and reasoning is not null
    and applied_delay_minutes is not null
  )
  or (
    target_allocation is not null and action_type is not null and what_changed is not null
    and confidence is not null and market_state is not null and reasoning is not null
    and requested_delay_minutes is not null and applied_delay_minutes is not null
  )
);
