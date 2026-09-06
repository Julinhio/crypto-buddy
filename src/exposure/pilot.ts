import { createHash } from 'node:crypto';

/**
 * THE PILOT'S IDENTITY AND ITS CIRCUIT BREAKER — brick 4 of the constrained-exposure pilot.
 *
 * PURE and TOTAL: no I/O, no clock of its own, no database, no network. Everything it needs
 * arrives as an argument, so the whole lifecycle — activation, the high-water mark, the 40%
 * alert, the 50% stop, an invalidated contract — is decided by a function a test can call a
 * thousand times without a market.
 *
 * ── WHY THIS MODULE DOES NOT REUSE `provenance/artefacts.ts` ───────────────────────────
 *
 * That file has the project's canonical serialiser and its SHA-256, and it also imports
 * `node:child_process` and `node:fs` at module scope to answer "which commit produced this".
 * This module is the FIRST thing in the chantier to sit on the TRADING path — the correction
 * cannot apply without it — and dragging a process spawner into that graph for two lines of
 * hashing would be a poor trade. The digest below builds its object in an explicit, fixed key
 * order, so it does not depend on a shared serialiser to be deterministic, and a test walks
 * this module's graph to prove nothing here can spawn or read a file.
 *
 * ── WHAT THE DIGEST COVERS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────
 *
 * ARBITRATED. It covers the whole contract as VALUES: the policy version and the context
 * definition's declared version, the six bounds, the universe and the per-asset caps, the fees
 * and the movement floor, the drawdown thresholds, the durations and the required coverage.
 *
 * It does NOT include the git SHA, mechanically or otherwise. A comment, a rename or a test
 * must not kill an eight-week experiment. The counterpart is a duty: a substantial change to
 * how the band or the correction BEHAVES must move `contractVersion` by hand, because no
 * digest of values can see a change in code.
 */

/** Everything the pilot's identity is a contract over. Order is fixed and load-bearing. */
export interface PilotContract {
  /** Moved BY HAND when the behaviour changes. The digest cannot see code. */
  contractVersion: string;
  bandVersion: string;
  band: {
    defensive: { lowPercent: number; highPercent: number };
    neutral: { lowPercent: number; highPercent: number };
    constructive: { lowPercent: number; highPercent: number };
  };
  universe: readonly string[];
  caps: {
    perAsset: Readonly<Record<string, number>>;
    defaultPerAsset: number;
    minCashPercent: number;
  };
  execution: { feePercent: number; minMovementPercent: number };
  drawdown: { alertPercent: number; stopPercent: number };
  window: { minWeeks: number; maxWeeks: number; requiredBarsPerFamily: number };
}

/**
 * The contract's fingerprint. Same contract, same string, on any machine and in any order the
 * caller happened to build its objects in — the shape below is rebuilt explicitly rather than
 * serialised as given, so a key added upstream cannot silently change the digest either.
 */
export function contractDigest(contract: PilotContract): string {
  const canonical = {
    contract_version: contract.contractVersion,
    band_version: contract.bandVersion,
    band: {
      defensive: [contract.band.defensive.lowPercent, contract.band.defensive.highPercent],
      neutral: [contract.band.neutral.lowPercent, contract.band.neutral.highPercent],
      constructive: [contract.band.constructive.lowPercent, contract.band.constructive.highPercent],
    },
    universe: [...contract.universe].sort(),
    caps: {
      per_asset: Object.entries(contract.caps.perAsset)
        .map(([asset, cap]) => [asset, cap] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      default_per_asset: contract.caps.defaultPerAsset,
      min_cash_percent: contract.caps.minCashPercent,
    },
    execution: [contract.execution.feePercent, contract.execution.minMovementPercent],
    drawdown: [contract.drawdown.alertPercent, contract.drawdown.stopPercent],
    window: [contract.window.minWeeks, contract.window.maxWeeks, contract.window.requiredBarsPerFamily],
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

// ── THE IDENTITY ──────────────────────────────────────────────────────────────────────

/**
 * A pilot's status. Both terminal states are PERMANENT for that identity: no environment
 * variable, no restart and no return to the old configuration brings it back. A following
 * pilot is a deliberate, reviewed administrative act — and no code path in this brick can
 * perform one.
 */
export type PilotStatus = 'active' | 'stopped_drawdown' | 'invalidated_contract';

export interface PilotIdentity {
  contractSha256: string;
  contractVersion: string;
  status: PilotStatus;
  activatedAt: string;
  activatedDecisionId: number | null;
  openingEquityQuote: number;
  peakEquityQuote: number;
  /** Null until the 40% alert has fired. It fires once for the life of the pilot. */
  alertDrawdownAt: string | null;
}

/** Why the correction is not touching the orders this cycle. Never a silence. */
export type PilotHold =
  | 'mode_inactif'
  | 'identite_illisible'
  | 'ecriture_obligatoire_impossible'
  | 'pilote_arrete_drawdown'
  | 'pilote_invalide_contrat'
  | 'contrat_divergent'
  | 'equite_inutilisable';

/** A durable change the caller MUST land before the correction may touch anything. */
export type PilotWrite =
  | { kind: 'activation'; openingEquityQuote: number; peakEquityQuote: number }
  | { kind: 'peak'; peakEquityQuote: number }
  | { kind: 'alert_drawdown'; drawdownPercent: number; peakEquityQuote: number }
  | { kind: 'stop_drawdown'; drawdownPercent: number; peakEquityQuote: number }
  | { kind: 'invalidate_contract'; seenSha256: string };

export interface PilotJudgement {
  /** May the band correction reach the executor this cycle? */
  mayCorrect: boolean;
  hold: PilotHold | null;
  /** Must land BEFORE the correction may apply. A failed write means `mayCorrect` is false. */
  write: PilotWrite | null;
  /** One-shot, and only ever on the cycle its write lands. */
  alert: 'drawdown_40' | 'drawdown_50' | 'contract_invalidated' | null;
  drawdownPercent: number | null;
  peakEquityQuote: number | null;
  statusAfter: PilotStatus | null;
}

export interface PilotJudgeInput {
  mode: 'off' | 'observation' | 'application';
  /** The row as read. Null means the table is empty — no pilot has ever been activated. */
  identity: PilotIdentity | null;
  /** True when the read itself failed. Distinguished from "no pilot yet", which is not a failure. */
  identityReadFailed: boolean;
  contractSha256: string;
  contractVersion: string;
  /** The sovereign book's equity this cycle. The only equity there is. */
  equityQuote: number;
  drawdown: { alertPercent: number; stopPercent: number };
}

const hold = (reason: PilotHold): PilotJudgement => ({
  mayCorrect: false,
  hold: reason,
  write: null,
  alert: null,
  drawdownPercent: null,
  peakEquityQuote: null,
  statusAfter: null,
});

/**
 * THE ONE DECISION: may the band correction touch the orders this cycle, and what must be
 * written for that to be true.
 *
 * FAILS CLOSED at every step. An unreadable identity, an unwritable high-water mark, a
 * contract that no longer matches, a stopped pilot — each ends with the correction inert and a
 * NAMED reason. The v5 bot continues in every one of those cases: nothing here can stop the
 * strategy, refuse a cycle, or liquidate anything.
 *
 * The order of the checks is itself the contract. A diverged contract is judged BEFORE any
 * drawdown, because a contract we no longer recognise is one whose thresholds we cannot trust
 * either.
 */
export function judgePilot(input: PilotJudgeInput): PilotJudgement {
  if (input.mode !== 'application') return hold('mode_inactif');
  if (input.identityReadFailed) return hold('identite_illisible');
  if (!Number.isFinite(input.equityQuote) || input.equityQuote <= 0) return hold('equite_inutilisable');

  // ── No pilot yet: this cycle is the activation, and it happens exactly once ──────────
  if (input.identity == null) {
    return {
      mayCorrect: true,
      hold: null,
      write: { kind: 'activation', openingEquityQuote: input.equityQuote, peakEquityQuote: input.equityQuote },
      alert: null,
      // At activation the peak IS the opening, so the drawdown is zero by construction. Said
      // rather than left null: this is the instant the clock starts.
      drawdownPercent: 0,
      peakEquityQuote: input.equityQuote,
      statusAfter: 'active',
    };
  }

  const identity = input.identity;
  if (identity.status === 'stopped_drawdown') return hold('pilote_arrete_drawdown');
  if (identity.status === 'invalidated_contract') return hold('pilote_invalide_contrat');

  // ── The contract, judged before anything numeric ─────────────────────────────────────
  if (identity.contractSha256 !== input.contractSha256) {
    return {
      mayCorrect: false,
      hold: 'contrat_divergent',
      write: { kind: 'invalidate_contract', seenSha256: input.contractSha256 },
      alert: 'contract_invalidated',
      drawdownPercent: null,
      peakEquityQuote: identity.peakEquityQuote,
      statusAfter: 'invalidated_contract',
    };
  }

  // ── The high-water mark, and the drawdown measured from it ───────────────────────────
  //
  // The peak only ever rises, and it survives everything: a restart, a redeploy, a spell with
  // the mode switched off. A peak that reset would report a drawdown of zero the day after the
  // worst day of the pilot.
  const peak = Math.max(identity.peakEquityQuote, input.equityQuote);
  const drawdownPercent = peak <= 0 ? 0 : ((peak - input.equityQuote) / peak) * 100;

  // ── 50% — the circuit breaker. The BAND stops, and nothing else ──────────────────────
  //
  // No forced liquidation, no strategy verdict, no halt of the v5 bot: the experimental
  // correction is disarmed, persistently, and the book stays exactly where it is. The identity
  // can never re-arm itself afterwards.
  if (drawdownPercent >= input.drawdown.stopPercent) {
    return {
      mayCorrect: false,
      hold: 'pilote_arrete_drawdown',
      write: { kind: 'stop_drawdown', drawdownPercent, peakEquityQuote: peak },
      alert: 'drawdown_50',
      drawdownPercent,
      peakEquityQuote: peak,
      statusAfter: 'stopped_drawdown',
    };
  }

  // ── 40% — one alert and one photograph, once for this pilot ──────────────────────────
  //
  // The correction KEEPS APPLYING here. This rung is a warning, not a stop, and turning it
  // into one would disarm the experiment at the very moment its result becomes interesting.
  if (drawdownPercent >= input.drawdown.alertPercent && identity.alertDrawdownAt == null) {
    return {
      mayCorrect: true,
      hold: null,
      write: { kind: 'alert_drawdown', drawdownPercent, peakEquityQuote: peak },
      alert: 'drawdown_40',
      drawdownPercent,
      peakEquityQuote: peak,
      statusAfter: 'active',
    };
  }

  return {
    mayCorrect: true,
    hold: null,
    // A peak that has not moved needs no write, and a cycle that writes nothing cannot fail to
    // write. Most cycles land here.
    write: peak > identity.peakEquityQuote ? { kind: 'peak', peakEquityQuote: peak } : null,
    alert: null,
    drawdownPercent,
    peakEquityQuote: peak,
    statusAfter: 'active',
  };
}

// ── THE MEASUREMENT WINDOW — closed by the clock, never by the breaker ────────────────

/**
 * ARBITRATED, and the distinction is the whole point: **the code closes the MEASUREMENT
 * WINDOW, not the application of the band.**
 *
 * At eight weeks the window closes if the required coverage is met, and otherwise runs to
 * twelve, where it closes in every case with its coverage label. No cycle after that instant
 * enters the official results — C8 included.
 *
 * The correction KEEPS RUNNING after the closure, pending our decision. It disarms only at 50%
 * or on an invalid contract. Disarming on a date would rearrange the portfolio at an arbitrary
 * moment for a reason that has nothing to do with risk.
 *
 * A bar counts once, on the FIRST cycle that used it (§7's unit of analysis). Absent or
 * unclassifiable data is counted apart and never joins the non-constructive family: inflating
 * that family would move the stop date.
 */
export type WindowClosureLabel = 'couverture_atteinte' | 'couverture_de_contexte_insuffisante';

export interface WindowClosureInput {
  activatedAt: string;
  now: Date;
  minWeeks: number;
  maxWeeks: number;
  requiredBarsPerFamily: number;
  /** Distinct 4h bars since activation, by family. Gaps are NOT in either count. */
  constructiveBars: number;
  nonConstructiveBars: number;
}

export interface WindowClosure {
  closed: boolean;
  label: WindowClosureLabel | null;
  weeksElapsed: number;
  coverageMet: boolean;
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

export function judgeWindowClosure(input: WindowClosureInput): WindowClosure {
  const started = Date.parse(input.activatedAt);
  if (!Number.isFinite(started)) {
    return { closed: false, label: null, weeksElapsed: 0, coverageMet: false };
  }
  const weeksElapsed = (input.now.getTime() - started) / MS_PER_WEEK;
  const coverageMet =
    input.constructiveBars >= input.requiredBarsPerFamily &&
    input.nonConstructiveBars >= input.requiredBarsPerFamily;

  if (weeksElapsed >= input.maxWeeks) {
    return {
      closed: true,
      label: coverageMet ? 'couverture_atteinte' : 'couverture_de_contexte_insuffisante',
      weeksElapsed,
      coverageMet,
    };
  }
  if (weeksElapsed >= input.minWeeks && coverageMet) {
    return { closed: true, label: 'couverture_atteinte', weeksElapsed, coverageMet };
  }
  return { closed: false, label: null, weeksElapsed, coverageMet };
}

/**
 * THE CONTRACT, ASSEMBLED FROM THE RUNNING CONFIGURATION — one assembler, one digest.
 *
 * Structural rather than importing the config module, so this file keeps no dependency of its
 * own on production wiring and stays callable from a test with four literals. Two call sites
 * building the contract by hand is how the live digest and the replay's digest would come to
 * disagree about what the pilot promised.
 */
export interface PilotContractSource {
  exposureBand: {
    version: string;
    defensive: { lowPercent: number; highPercent: number };
    neutral: { lowPercent: number; highPercent: number };
    constructive: { lowPercent: number; highPercent: number };
  };
  exposurePilot: {
    contractVersion: string;
    alertDrawdownPercent: number;
    stopDrawdownPercent: number;
    minWeeks: number;
    maxWeeks: number;
    requiredBarsPerFamily: number;
  };
  execution: {
    feePercent: number;
    minMovementPercent: number;
    caps: { perAsset: Record<string, number>; defaultPerAsset: number; minCashPercent: number };
  };
}

export function pilotContractOf(source: PilotContractSource, universe: readonly string[]): PilotContract {
  return {
    contractVersion: source.exposurePilot.contractVersion,
    bandVersion: source.exposureBand.version,
    band: {
      defensive: source.exposureBand.defensive,
      neutral: source.exposureBand.neutral,
      constructive: source.exposureBand.constructive,
    },
    universe,
    caps: source.execution.caps,
    execution: {
      feePercent: source.execution.feePercent,
      minMovementPercent: source.execution.minMovementPercent,
    },
    drawdown: {
      alertPercent: source.exposurePilot.alertDrawdownPercent,
      stopPercent: source.exposurePilot.stopDrawdownPercent,
    },
    window: {
      minWeeks: source.exposurePilot.minWeeks,
      maxWeeks: source.exposurePilot.maxWeeks,
      requiredBarsPerFamily: source.exposurePilot.requiredBarsPerFamily,
    },
  };
}
