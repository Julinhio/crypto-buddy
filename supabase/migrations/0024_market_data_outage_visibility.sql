-- Migration 0024 — rendre visible une panne de données de marché
--
-- L'incident : entre le 09/08 03:55 et le 10/08 03:30 UTC, le bot s'est réveillé 31 fois
-- sans obtenir la moindre donnée de marché exploitable. Les cinq marchés disparaissaient
-- ensemble à chaque fois. Cycles en échec : 1,24 s de moyenne contre 28,70 s pour un cycle
-- normal — un échec IMMÉDIAT dans le chemin d'accès aux données publiques Binance, ni
-- timeout ni crash.
--
-- Le comportement financier a été correct : aucune décision, aucun ordre, positions et
-- thèses préservées. Le fail-closed a fonctionné.
--
-- LE VRAI DÉFAUT, et c'est celui-ci que la migration adresse : toute la supervision est
-- restée VERTE pendant 23 heures.
--
--   - un cycle sans données s'enregistre comme un run terminé avec l'issue `skip` ;
--   - `consecutive_failures` n'a jamais bougé (classifyOutcome range `skipped` dans
--     'skip', qui remet le compteur à zéro) — donc pas d'alerte « dégradé » ;
--   - le dead-man's switch a continué de recevoir ses pings, puisque le bot se réveillait
--     bien. Il mesure « le scheduler est vivant », ce qui était VRAI.
--
-- Et tout ce qui a été conservé pour ces 31 cycles, c'est la chaîne `status=skipped` et le
-- `skip_reason` « no tradable pairs returned usable market data ». Pas de code HTTP, pas
-- d'endpoint, pas de classe d'erreur : l'erreur détaillée ne vivait que dans les logs du
-- processus, qui ne sont pas conservés. C'est pour cette raison que la cause reste une
-- hypothèse — le blocage d'IP de sortie est plausible, personne ne peut le prouver.
--
-- Deux ajouts, qui répondent à deux questions différentes :
--
--   1. une TABLE d'incidents — « que s'est-il passé exactement, à quel cycle ». C'est ce
--      qui rend la PROCHAINE panne diagnosticable, et c'est pour ça qu'elle vient en
--      premier ;
--   2. trois colonnes sur `bot_state` — « le bot voit-il le marché EN CE MOMENT ». C'est
--      le second état de santé, séparé du premier : le dead-man's switch continue de
--      mesurer que le scheduler est vivant, INCHANGÉ, et un bot qui se réveille sans voir
--      le marché sort désormais vert sur l'un et rouge sur l'autre.
--
-- Comment appliquer : coller dans le SQL Editor Supabase (Dashboard → SQL Editor → New
-- query → Run) AVANT de déployer le code qui écrit dedans (règle dure du projet).
--
-- Périmètre : OBSERVABILITÉ UNIQUEMENT. Aucune décision, aucun ordre, aucun chemin de
-- données de production n'est modifié. `api.binance.com` reste la source. La porte de
-- transition n'est pas touchée, ni son mode.

-- ── 1. La trace durable d'une lecture de marché ratée ────────────────────────────
--
-- PAS de foreign key vers `decisions`, et c'est délibéré. Une panne de données peut très
-- bien empêcher le cycle d'écrire sa ligne de décision (l'insert échoue, la base est
-- injoignable, le cycle meurt avant) : une FK ferait alors disparaître l'incident au
-- moment précis où il est le plus intéressant. `decision_id` est donc un bigint nu,
-- rempli quand on l'a, et `run_token` rattache la ligne au run du scheduler sinon.
-- C'est la leçon de `decision_guard_events.decision_id` (nullable pour survivre au cycle
-- mort), poussée d'un cran : ici même la contrainte disparaît.
create table if not exists public.market_data_incidents (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  -- Le rattachement, best-effort et sans contrainte (voir ci-dessus).
  decision_id bigint,
  run_token   uuid,

  -- ── l'état de santé du cycle ──────────────────────────────────────────────────
  -- true  = AUCUN marché tradable exploitable → le bot est aveugle, le fail-closed a
  --         refusé de décider. Ce sont les 31 cycles du 09/08.
  -- false = perte PARTIELLE : au moins une lecture a raté, mais l'univers tradable
  --         n'était pas vide et la décision est partie normalement. Conservé aussi,
  --         parce qu'une panne totale commence en général par des pertes partielles et
  --         que personne ne les a jamais vues.
  blind boolean not null,

  -- Le « nombre de marchés affectés » du brief, avec son dénominateur — 5/5 et 1/5 sont
  -- deux incidents très différents et un compteur nu ne les distingue pas.
  markets_attempted integer not null,
  markets_failed    integer not null,

  -- ── l'erreur, structurée ──────────────────────────────────────────────────────
  -- Les quatre champs du brief, promus en colonnes parce que ce sont ceux sur lesquels
  -- on filtrera à 3 h du matin. `error_class` est la classe CCXT (ExchangeNotAvailable,
  -- DDoSProtection, RequestTimeout…), qui distingue à elle seule un blocage d'un timeout.
  error_class text,
  http_status integer,
  endpoint    text,
  -- L'en-tête `Retry-After` tel qu'il a été renvoyé, en texte : la spec autorise un
  -- nombre de secondes OU une date HTTP, et convertir à l'écriture perdrait laquelle des
  -- deux le serveur a choisi.
  retry_after text,

  -- Le détail complet, par marché et par réponse HTTP. Les colonnes ci-dessus sont un
  -- résumé (la classe dominante, le premier statut vu) ; ceci est la matière brute qu'on
  -- regrettera de ne pas avoir gardée. C'est exactement le manque qui a rendu le 09/08
  -- non diagnosticable.
  failures    jsonb not null default '[]'::jsonb,
  http_traces jsonb not null default '[]'::jsonb,

  -- ── la sonde de diagnostic ────────────────────────────────────────────────────
  -- Une requête, une seule par cycle, vers l'endpoint public ALTERNATIF, depuis la même
  -- instance et au moment exact de l'échec. La question à laquelle elle répond : « est-ce
  -- que data-api.binance.vision répond depuis cette IP de sortie pendant que
  -- api.binance.com refuse ? » — la seule qui départage l'hypothèse du blocage d'IP.
  --
  -- La requête n'est pas au hasard : `exchangeInfo?symbol=BTCUSDT` est l'équivalent de
  -- l'appel commun qui a échoué, celui qui charge les métadonnées de marché. Un simple
  -- /ping répondrait sans tester l'hypothèse.
  --
  -- DIAGNOSTIC UNIQUEMENT. Ces colonnes sont écrites et jamais relues par le bot : aucune
  -- décision, aucune allocation, aucun prix, aucun régime ne peut en dépendre. Côté code
  -- la garantie est structurelle — la fonction qui sonde et écrit renvoie `void` (voir
  -- src/market/outage.ts), donc rien ne peut en ressortir.
  probe_attempted   boolean not null default false,
  probe_reachable   boolean,
  probe_http_status integer,
  probe_latency_ms  integer,
  probe_error       text
);

create index if not exists market_data_incidents_created_at_idx
  on public.market_data_incidents (created_at desc);
-- L'index qui sert la question « depuis quand est-il aveugle » sans scanner la table.
create index if not exists market_data_incidents_blind_idx
  on public.market_data_incidents (created_at desc) where blind;

comment on table public.market_data_incidents is
  'Trace durable d''une lecture de marché ratée : classe d''erreur CCXT, statut HTTP, endpoint, Retry-After, nombre de marchés affectés, plus le résultat de la sonde de diagnostic. Existe parce que la panne du 09/08 (31 cycles aveugles, 23 h) n''a laissé que la chaîne "status=skipped" et reste donc une hypothèse. Pas de FK vers decisions : une panne peut empêcher le cycle d''écrire sa décision, et l''incident doit survivre à ça.';

comment on column public.market_data_incidents.blind is
  'true = aucun marché tradable exploitable (le fail-closed a refusé de décider) ; false = perte partielle, la décision est partie normalement. Seul true fait avancer bot_state.consecutive_blind_cycles.';

comment on column public.market_data_incidents.probe_reachable is
  'DIAGNOSTIC UNIQUEMENT — jamais relu par le bot. Résultat de la sonde vers data-api.binance.vision depuis la même IP de sortie, au moment exact de l''échec.';

-- Row Level Security : ACTIVÉE, ZÉRO policy (deny-all), comme toutes les autres tables.
-- Le backend utilise la service role key, qui contourne RLS ; toute clé anon/publique est
-- refusée. Une migration l'a déjà oublié une fois — pas deux.
alter table public.market_data_incidents enable row level security;

-- ── 2. Le second état de santé, sur bot_state ────────────────────────────────────
--
-- Ce sont deux questions distinctes, aujourd'hui confondues en une seule :
--
--   - LE SCHEDULER EST VIVANT : le bot se réveille bien. Mesuré par le dead-man's switch
--     (Healthchecks) et `last_heartbeat_at`. INCHANGÉ par cette migration — il avait
--     raison le 09/08, le bot se réveillait vraiment ;
--   - LE BOT DISPOSE DE DONNÉES EXPLOITABLES : il voit le marché. C'est ce qui manquait,
--     et c'est ce que ces trois colonnes rendent consultable.
--
-- Même forme que les deux compteurs existants (`consecutive_failures`,
-- `floor_delay_streak`) et leurs drapeaux de debounce : réclamé pré-cycle via
-- record_heartbeat (`returning *`, donc les nouvelles colonnes remontent sans y toucher),
-- recalculé post-cycle par une fonction pure de l'app, et écrit par finish_run.
alter table public.bot_state
  add column if not exists consecutive_blind_cycles integer   not null default 0,
  add column if not exists blind_alert_sent         boolean   not null default false,
  add column if not exists last_market_data_ok_at   timestamptz;

comment on column public.bot_state.consecutive_blind_cycles is
  'Cycles D''AFFILÉE terminés sans le moindre marché tradable exploitable. Remis à zéro par un cycle qui voit le marché ; laissé INCHANGÉ par un cycle dont l''état de données est inconnu (timeout, throw avant la lecture) — un inconnu n''est ni une preuve d''aveuglement ni une preuve de rétablissement.';
comment on column public.bot_state.blind_alert_sent is
  'Drapeau de debounce de l''alerte « données de marché indisponibles » (consecutive_blind_cycles ≥ seuil). true = déjà alerté tant qu''on est au-dessus ; réarmé (false) dès qu''un cycle revoit le marché. Même mécanique que floor_alert_sent / failure_alert_sent.';
comment on column public.bot_state.last_market_data_ok_at is
  'Dernier cycle ayant vu le marché. L''analogue de last_success_at pour le SECOND état de santé : rend « depuis combien de temps est-il aveugle » lisible en une requête, sans reconstituer la séquence.';

-- ── 3. finish_run() : trois assignations de plus, zéro logique de plus ───────────
--
-- Inchangée dans l'esprit — replanifier + relâcher + clore le run dans UNE transaction,
-- gardée par le jeton de fencing. On AJOUTE deux paramètres écrits comme de simples
-- assignations à côté des compteurs existants (aucune logique nouvelle dans cette
-- fonction critique ; la décision de debounce est prise dans l'app, comme en 0007), plus
-- `last_market_data_ok_at` qui suit exactement la forme de `last_success_at` juste
-- au-dessus. Un run reclaimé ne peut toujours pas écraser tout ça : les trois colonnes
-- voyagent sous la même garde `run_token`.
--
-- `p_saw_market_data` est un booléen NULLABLE à trois états, et c'est voulu :
--   true  → le cycle a vu le marché      → compteur remis à 0, horodatage rafraîchi ;
--   false → le cycle était aveugle       → compteur incrémenté par l'app ;
--   null  → état de données INCONNU      → horodatage laissé tel quel.
-- L'app calcule déjà le compteur (fonction pure, testée hors-ligne) ; ce paramètre ne
-- sert qu'à l'horodatage, qui lui doit prendre now() côté base comme last_success_at.
--
-- La liste d'arguments change, donc il faut DROP l'ancienne version 12-arg d'abord (un
-- simple `create or replace` laisserait une surcharge périmée derrière lui). Le drop
-- retire aussi ses grants, réappliqués plus bas pour la signature 15-arg.
drop function if exists public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text, boolean, boolean
);

create or replace function public.finish_run(
  p_run_token                uuid,
  p_run_id                   bigint,
  p_delay_minutes            integer,
  p_consecutive_failures     integer,
  p_floor_delay_streak       integer,
  p_succeeded                boolean,
  p_outcome                  text,
  p_decision_id              bigint,
  p_missed_beats             integer,
  p_detail                   text,
  p_floor_alert_sent         boolean,
  p_failure_alert_sent       boolean,
  p_consecutive_blind_cycles integer,
  p_blind_alert_sent         boolean,
  p_saw_market_data          boolean
)
returns boolean
language plpgsql
as $$
declare
  v_lock_held boolean;
begin
  -- Reschedule + release bot_state ONLY if we still own the lock (the fencing token).
  -- If our run overran and was reclaimed, we must NOT clobber the state — the reclaiming
  -- run owns rescheduling AND its own alert evaluation.
  update public.bot_state
     set next_check_at            = now() + make_interval(mins => p_delay_minutes),
         run_token                = null,
         locked_until             = null,
         last_success_at          = case when p_succeeded then now() else last_success_at end,
         consecutive_failures     = p_consecutive_failures,
         floor_delay_streak       = p_floor_delay_streak,
         floor_alert_sent         = p_floor_alert_sent,
         failure_alert_sent       = p_failure_alert_sent,
         consecutive_blind_cycles = p_consecutive_blind_cycles,
         blind_alert_sent         = p_blind_alert_sent,
         -- Même forme que last_success_at : now() côté base, et on ne touche à rien quand
         -- l'état de données est inconnu (null) ou aveugle (false).
         last_market_data_ok_at   = case
                                      when p_saw_market_data then now()
                                      else last_market_data_ok_at
                                    end,
         updated_at               = now()
   where id = 1
     and run_token = p_run_token;

  v_lock_held := found;

  -- ALWAYS close the history row. The run DID finish its cycle; on the fencing path it
  -- just lost the lock — that is NOT a crash, so don't leave it 'running' (that label is
  -- reserved for runs that truly never came back). Record the lock-lost in the detail,
  -- and only stamp next_check_at when we actually rescheduled.
  update public.scheduler_runs
     set finished_at   = now(),
         status        = 'completed',
         outcome       = p_outcome,
         decision_id   = p_decision_id,
         missed_beats  = p_missed_beats,
         next_check_at = case when v_lock_held then now() + make_interval(mins => p_delay_minutes) else null end,
         detail        = case
                           when v_lock_held then p_detail
                           else coalesce(p_detail || ' | ', '') ||
                                'lock lost/overran: reclaimed by another beat; this run did not reschedule bot_state'
                         end
   where id = p_run_id;

  return v_lock_held;  -- true = we held the lock (normal); false = fencing (reclaimed)
end;
$$;

-- Re-apply the lockdown for the NEW signature (the drop above removed the old grants).
-- New functions grant EXECUTE to PUBLIC by default; revoke that and grant it back ONLY to
-- service_role — anon/authenticated then can't call it at all.
revoke execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text, boolean, boolean,
  integer, boolean, boolean
) from public;
grant execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text, boolean, boolean,
  integer, boolean, boolean
) to service_role;

-- ── 4. reset_bot connaît la nouvelle table et les nouvelles colonnes ─────────────
--
-- La leçon de la migration 0018, appliquée le jour même plutôt qu'après coup : une table
-- persistante que `reset_bot` ignore survit à un reset, et trois compteurs qu'il oublie
-- de remettre à zéro font repartir le bot neuf avec une alerte déjà armée.
--
-- `market_data_incidents` n'a AUCUNE foreign key (voir §1), donc sa place dans le
-- TRUNCATE est libre et ne peut pas casser l'ordre.
--
-- Tout le reste de reset_bot est inchangé et ré-énoncé verbatim.
create or replace function public.reset_bot(
  p_new_starting_capital_usd numeric
)
returns table (
  status        text,
  locked_until  timestamptz,
  next_check_at timestamptz
)
language plpgsql
as $$
declare
  v_locked_until timestamptz;
  v_next         timestamptz;
begin
  -- 1. Valider le nouveau capital AVANT de toucher au lock ou à la moindre donnée.
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2. Claim du run-lock — le même compare-and-set que le scheduler, sans le « due ? ».
  update public.bot_state as b
     set run_token    = gen_random_uuid(),
         locked_until = now() + make_interval(secs => 60)
   where b.id = 1
     and (b.run_token is null or b.locked_until is null or b.locked_until <= now());

  if not found then
    select b.locked_until into v_locked_until from public.bot_state as b where b.id = 1;
    return query select 'busy'::text, v_locked_until, null::timestamptz;
    return;
  end if;

  -- 3. Purge de l'historique. market_data_incidents rejoint la liste ici.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decision_guard_events,
    public.market_data_incidents,
    public.decisions;

  -- 4. bot_state remis à plat, nouveau capital écrit, lock relâché.
  v_next := now();
  update public.bot_state as b
     set run_token                = null,
         locked_until             = null,
         consecutive_failures     = 0,
         floor_delay_streak       = 0,
         floor_alert_sent         = false,
         failure_alert_sent       = false,
         consecutive_blind_cycles = 0,
         blind_alert_sent         = false,
         last_market_data_ok_at   = null,
         last_success_at          = null,
         next_check_at            = v_next,
         starting_capital_usd     = p_new_starting_capital_usd,
         updated_at               = now()
   where b.id = 1;

  if not found then
    raise exception 'reset_bot: bot_state singleton (id=1) is missing during finalize';
  end if;

  return query select 'reset'::text, null::timestamptz, v_next;
end;
$$;

-- TRUNCATE demande le privilège TRUNCATE (non impliqué par DELETE). Idempotent.
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.position_state,
  public.decision_guard_events,
  public.market_data_incidents,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state/decision_guard_events/market_data_incidents (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags (including consecutive_blind_cycles, blind_alert_sent, last_market_data_ok_at), releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
