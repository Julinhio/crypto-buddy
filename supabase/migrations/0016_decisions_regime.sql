-- Migration 0016 — decisions: regime (Strategy V2, PR 1)
--
-- The market regime is now computed by the CODE, per tradable asset, from the daily
-- structure plus a 4h tactical horizon — it is no longer something the model
-- declares. On the 47 observed days the model's own `market_state` produced TWO
-- distinct values and stayed on `risk_off` while ETH climbed 27% off its low; that
-- classification was simply wrong, and a field the model asserts cannot be audited
-- against the data that produced it.
--
-- This column journals the code's read on EVERY cycle: the per-asset regime after
-- hysteresis, the raw (unsmoothed) label, the global risk_off posture and the exact
-- signals behind them. Shape (see src/market/regime.ts, RegimeJournal):
--
--   {
--     "version": "r1",
--     "barAt":   "2026-07-25T04:00:00.000Z",        -- the 4h bar it was computed on
--     "global":  { "riskOff": false, "raw": false, "breadthPercent": 40,
--                  "medianH4Rsi": 47.1, "pendingBars": 0 },
--     "assets":  { "ETH": { "effective": "trend_up", "regime": "trend_up",
--                           "raw": "trend_up", "pendingRegime": null,
--                           "pendingBars": 0, "bearish": false,
--                           "signals": { ... } }, ... }
--   }
--
-- `effective` is the regime the system acts on: the per-asset regime, or `risk_off`
-- when the global override is active (the override is a portfolio POSTURE, priority
-- over the per-asset structure — never a sixth competing label).
--
-- SHADOW MODE: at this PR the regime is journaled but is NOT shown to the model and
-- does NOT influence any decision. It becomes an input to the mandate only with the
-- v5 prompt, behind STRATEGY_VERSION.
--
-- Nullable on purpose: every row predating this PR has no regime, and a cycle whose
-- 4h series was unavailable journals null rather than failing (a missing regime is
-- information, not a crash). Deliberately NOT added to the
-- decisions_decided_complete CHECK, for the same reason as notification_summary.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → Run) BEFORE deploying the code that writes it (the project's hard rule).

alter table public.decisions
  add column if not exists regime jsonb;

comment on column public.decisions.regime is
  'Code-computed market regime for this cycle (Strategy V2 PR 1): per-asset regime after hysteresis + raw label + global risk_off posture + the signals behind them. See src/market/regime.ts (RegimeJournal). Null on pre-V2 rows and when the 4h series was unavailable. Shadow mode: journaled only, never shown to the model at this stage.';

-- The audit query this exists for — "what regime did the bot see, per asset, per
-- cycle" — is a scan over recent rows, so the useful index is the same time ordering
-- the rest of the table already uses. A GIN index on the payload would only pay off
-- for containment queries we do not run; skipped deliberately.
create index if not exists decisions_regime_present_idx
  on public.decisions (created_at desc)
  where regime is not null;
