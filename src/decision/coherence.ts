import type { ActionType, PositionNote } from './schema.js';
import type { AppConfig, StrategyVersion } from '../config/index.js';
import { clampAllocation } from '../risk/clamp.js';
import type { Movement } from '../execution/movements.js';
import { mayWriteThesis } from '../portfolio/lifecycle.js';

/**
 * THE COHERENCE GUARD — structured against structured, never prose.
 *
 * Reordering the output contract (schema.ts) stops the model from posing its numbers
 * before it has thought. It does not stop a response whose parts contradict each other
 * from being executed. This module is the second half: it compares STRUCTURED elements
 * to STRUCTURED elements, before anything is persisted and before anything is executed.
 *
 * It never reads the reasoning, the notification or a thesis's text. Not as a style
 * preference — as the property that makes it safe to run in front of the executor. A
 * guard that parses prose is a guard that fails on a rephrasing, and a guard that fails
 * on a rephrasing turns every awkward sentence into a dead cycle.
 *
 * ── THE TWO TRAPS THIS FILE EXISTS TO NOT FALL INTO ──────────────────────────────
 *
 * 1. TARGET IS COMPARED TO THE PREVIOUS TARGET, NEVER TO THE VALUED BOOK. If the
 *    emitted target were compared to the current valuation, every hold would fail: BTC
 *    is worth 24.46% against a 25% target purely because the price moved. A model
 *    re-emitting 25 has changed nothing. This is the single most likely way to build a
 *    guard that kills the bot.
 *
 * 2. EXECUTABILITY IS THE OPPOSITE — it can only be judged against the book, because an
 *    order is born from the gap between the target and what is actually held. So rule 2
 *    takes the movements the real pipeline computed (clamp → computeMovements, 2% floor
 *    included) rather than re-deriving them. Two different references, on purpose: "did
 *    you change your mind" is a target-to-target question, "will anything happen" is a
 *    book question. Collapsing them into one comparison breaks one or the other.
 *
 * ── AND THE FALSE POSITIVE THAT COST THE MOST TO SEE ─────────────────────────────
 *
 * Rule 3 is the MIRROR of `mayWriteThesis`, not a rule rewritten beside it. Written
 * naively as "a note requires the line to move", it rejects cycle 879 — the very first
 * v5 cycle, which legitimately opened four theses on four untouched lines because none
 * of them had one yet. Reusing the predicate means the guard and the lifecycle cannot
 * drift: the guard refuses exactly what the lifecycle would silently drop.
 */

/** The rule identifiers, as persisted in `decision_guard_events.rules`. */
export type CoherenceRule =
  | 'hold_moved_target'
  | 'target_not_executable'
  | 'note_on_unmoved_line'
  | 'moved_line_without_note';

export interface CoherenceViolation {
  rule: CoherenceRule;
  /** The assets the violation is about. Empty when the rule is portfolio-wide. */
  assets: string[];
  /** One sentence, factual, quoting the structured values that disagree. */
  detail: string;
}

export interface CoherenceInput {
  /**
   * WHICH CONTRACT the response was produced under. Rules 3 and 4 are about theses, and
   * a thesis is a v5 concept: the v4 schema has no `position_notes` at all, so
   * `validateDecision` can only ever hand back an empty array under v4.
   *
   * Without this, an armed guard is a TRADING FREEZE on v4. Every non-full-exit movement
   * trips rule 4 ("this line moved and supplied no note"), and the retry cannot fix it —
   * adding the field fails the v4 schema. Ordinary buys, partial sells and rebalances
   * would all be refused twice and journaled `guard_failed`.
   *
   * That is not a theoretical path. `STRATEGY_VERSION` absent resolves to v4 BY DESIGN —
   * it is the project's disaster-recovery posture, the thing that makes "an environment
   * that lost its variables comes back safe" true. Arming a guard that cannot be
   * satisfied under v4 would turn that fallback from "trades under the old mandate" into
   * "cannot trade at all", which is the opposite of a safety net.
   *
   * Rules 1 and 2 stay armed under both: a hold that moves its target, and a target that
   * cannot produce an order, are incoherent whatever the mandate.
   */
  strategy: StrategyVersion;
  actionType: ActionType;
  /**
   * This cycle's EFFECTIVE target — the risk-bounded allocation the chain will actually
   * pursue, not the model's raw emission.
   *
   * It must be the same KIND of value as `referenceTarget`, and that symmetry is the
   * whole point. The reference is read back from `applied_allocation`, so comparing a raw
   * proposal against it would reject an honest hold the moment the two diverge: a model
   * that re-emits an over-cap proposal unchanged would see raw 40% measured against
   * applied 35% and be told its "hold moved the target", when the book pursued 35% both
   * times. Effective on one side, effective on the other.
   *
   * Identical to the raw emission on the whole corpus (the clamp has never fired), which
   * is why this can be corrected now at zero behavioural cost.
   */
  effectiveTarget: Record<string, number>;
  /**
   * The last target the guard ACCEPTED — read from the DB every cycle, never carried
   * in memory (the bot runs one process per wake-up under Cron Schedule, so there is
   * no memory to carry it in). Resolved from `applied_allocation` (see
   * `resolveEffectiveTarget`). Null only when no decision has ever been recorded.
   *
   * Passed RAW, as stored. `checkCoherence` normalises it under `riskPolicy` before any
   * rule sees it — see the note there. Callers must not clamp it themselves: two callers
   * normalising separately is how the operands drift apart again.
   */
  referenceTarget: Record<string, number> | null;
  /**
   * The risk policy IN FORCE THIS CYCLE — the caps the clamp applies.
   *
   * A guard that took no config was the right shape until the reference became an
   * `applied_allocation`. A stored applied target was bounded by the policy of ITS day;
   * the candidate is bounded by today's. Tighten a cap and the two live in different
   * coordinate systems: a reference at 35% is compared to a candidate the clamp can no
   * longer take above 30%, every `hold` is rejected for "moving" 35 → 30, no `decided`
   * row is written, the reference never advances, and the risk-mandated reduction never
   * executes. An interlock, and a regression — before the reference became the applied
   * allocation, raw-versus-raw survived a cap change and the clamp quietly applied 30.
   *
   * So the policy is an INPUT to the judgement now. Passed in rather than imported, which
   * keeps the function pure and — the reason that actually matters — lets a test run it
   * under a synthetic tightened cap without touching the real configuration.
   */
  riskPolicy: AppConfig;
  /** The movements the real pipeline produced for this target. The 2% floor already applied. */
  movements: Movement[];
  /**
   * The reserve stable. Rule 2 needs it: cash moves on EVERY trade (it is the other side
   * of every leg) but is never traded directly — `computeMovements` skips it outright.
   * Counting it as an asset that should produce a movement would reject every real
   * rebalance the bot ever makes.
   */
  reserveAsset: string;
  /** The theses the model wants written this cycle. */
  notes: PositionNote[];
  /** Assets that already carry a stored thesis, as journaled in this cycle's context. */
  assetsWithStoredThesis: Set<string>;
}

export interface CoherenceVerdict {
  ok: boolean;
  violations: CoherenceViolation[];
}

/**
 * Below this, two targets are the same target. A model that deliberately changes an
 * allocation moves it by points, not by hundredths — the mandate asks for 5 to 10. So
 * this only ever absorbs a re-emission of the same number, never a real intent.
 */
const TARGET_EPSILON = 0.01;

/**
 * The reference, RESTATED in this cycle's universe.
 *
 * This cycle's allocatable universe comes from the pairs that actually returned data, so
 * an asset can vanish between two wake-ups when its feed drops. Two things then happen at
 * once, and only handling the first is a trap:
 *
 *   1. the vanished key is absent from the target. Comparing over the union would read
 *      that as the model changing its mind — handled by comparing the intersection;
 *
 *   2. THE VANISHED ASSET'S WEIGHT HAS TO GO SOMEWHERE. The schema is strict and still
 *      requires the remaining allocations to sum to 100, so a line that was at 8% leaves
 *      8 points that the model MUST reassign. The neutral place is cash. Compared
 *      naively, the reserve then looks like it moved by 8 points, rule 1 rejects a
 *      perfectly genuine hold, and the retry cannot fix it either — re-emitting the old
 *      target is impossible, its key is now forbidden. Every cycle would die for as long
 *      as the feed stayed down.
 *
 * So the dropped weight is credited to the reserve before comparing: parking an orphaned
 * line's weight in cash is what the code itself would do, and it is not a decision. Note
 * what this deliberately does NOT absolve — a model that reassigns that weight into
 * another COIN has made a real allocation choice, the coin still reads as moved, and a
 * `hold` claiming otherwise is still rejected.
 */
function referenceInCurrentUniverse(
  target: Record<string, number>,
  reference: Record<string, number>,
  reserveAsset: string,
): Record<string, number> {
  const orphanedWeight = Object.entries(reference)
    .filter(([asset]) => !(asset in target))
    .reduce((sum, [, value]) => sum + value, 0);
  if (orphanedWeight === 0) return reference;

  const restated: Record<string, number> = { ...reference };
  restated[reserveAsset] = (restated[reserveAsset] ?? 0) + orphanedWeight;
  return restated;
}

/** The assets whose target moved, comparing ONLY the keys both allocations share. */
function movedAssets(
  target: Record<string, number>,
  reference: Record<string, number>,
): string[] {
  const moved: string[] = [];
  for (const [asset, value] of Object.entries(target)) {
    const before = reference[asset];
    if (before == null) continue; // not in both → not comparable, not a change of mind
    if (Math.abs(value - before) > TARGET_EPSILON) moved.push(asset);
  }
  return moved;
}

const fmt = (allocation: Record<string, number>): string =>
  Object.entries(allocation)
    .map(([asset, value]) => `${asset} ${value}%`)
    .join(', ');

/**
 * Checks one candidate decision. Pure: no I/O, no clock, no config lookup — every input
 * is passed in, so every rule below is directly testable and the replay harness can feed
 * it 139 real production responses without touching the network.
 */
export function checkCoherence(input: CoherenceInput): CoherenceVerdict {
  const {
    strategy,
    actionType,
    effectiveTarget,
    referenceTarget,
    riskPolicy,
    movements,
    reserveAsset,
    notes,
    assetsWithStoredThesis,
  } = input;
  const violations: CoherenceViolation[] = [];
  // Theses only exist under v5 — see the field's documentation above for why arming
  // rules 3 and 4 under v4 would freeze trading rather than protect it.
  const thesisRulesApply = strategy === 'v5';

  // Which lines actually move this cycle, per the real pipeline. `movements` is computed
  // from the RISK-BOUNDED target against the book, which is exactly what the executor
  // will be handed — so the guard and the executor cannot disagree about what "moves".
  const movingAssets = new Set(movements.map((m) => m.asset));
  // A full exit is exempt from rule 4 — see below.
  const fullExitAssets = new Set(movements.filter((m) => m.fullExit).map((m) => m.asset));

  // THE REFERENCE, PUT IN THIS CYCLE'S FRAME. Two corrections, in this order, and then
  // every rule below reads the SAME result — none of them clamps, and none of them ever
  // sees the raw value.
  //
  //   1. THE UNIVERSE. A feed that dropped an asset forces its weight to be reassigned,
  //      and that reassignment is the code's doing, not the model's.
  //   2. THE RISK POLICY. The reference is a stored `applied_allocation`, bounded by the
  //      caps of its day; the candidate is bounded by today's. Comparing them across a
  //      cap change compares two different coordinate systems — see `riskPolicy`.
  //
  // Restate THEN clamp, so the two operands are built the same way: the candidate is the
  // clamp of an allocation expressed in this cycle's universe, and now so is the
  // reference. Idempotent while the policy holds still — clamping an already-bounded
  // allocation under the same caps returns it unchanged — which is why this corrects the
  // interlock without moving a single verdict on the existing corpus.
  //
  // Only ONE place derives `reference`, and rules 1 and 2 both read it from here. Rules 3
  // and 4 are about theses and never touch the reference at all, so there is no rule left
  // that could read an unnormalised value.
  const reference = referenceTarget
    ? clampAllocation(
        referenceInCurrentUniverse(effectiveTarget, referenceTarget, reserveAsset),
        reserveAsset,
        riskPolicy,
      ).applied
    : null;
  const moved = reference ? movedAssets(effectiveTarget, reference) : [];
  const targetChanged = moved.length > 0;

  // ── Rule 1 — a hold cannot modify the reference target ────────────────────────
  //
  // The cycle-987 family, in the direction that loses a trade: the model reasons its way
  // to a move and labels it a hold, or reasons its way to a hold and leaves a moved
  // target behind. Either way the two halves disagree and one of them is silently
  // discarded downstream.
  //
  // Not evaluated at all when there is no reference (the very first decision on record):
  // there is nothing to have modified.
  if (actionType === 'hold' && targetChanged && reference) {
    violations.push({
      rule: 'hold_moved_target',
      assets: moved,
      detail:
        `action_type is "hold" but the target moved on ${moved.join(', ')}: ` +
        `reference [${fmt(reference)}] → emitted [${fmt(effectiveTarget)}]. ` +
        'A hold keeps the reference target; a changed target is not a hold.',
    });
  }

  // ── Rule 2 — a moved target that cannot produce an order is an invalid target ──
  //
  // Cycles 946, 948 and 957: the emitted allocation proposes BNB at 11% while the
  // standing reference is 12%. One point on a ~$1000 book is ~$10, under the 2% plumbing
  // floor, so no order was ever going to be created. The reasoning of those cycles then
  // concludes it should stay at 12%.
  //
  // The point of stating this separately from rule 1 is what it catches when the label
  // is NOT hold: a `rebalance` that moves the target by one point is equally void, and
  // rule 1 would let it through.
  //
  // ASKED PER MOVED ASSET, NOT PORTFOLIO-WIDE. "Is there any movement at all" is a
  // different question and the wrong one: the book drifts on its own, so an UNCHANGED
  // BTC target can produce a drift order while the one-point BNB change the model
  // actually intended silently produces nothing. The decision would be accepted, only
  // BTC would trade, and the intent would be lost — the exact class of silent discard
  // this guard exists to stop.
  //
  // TWO deliberate calibrations:
  //   - the RESERVE is excluded. Cash moves on every trade (it is the other side of
  //     every leg) and is never traded directly, so requiring a movement for it would
  //     reject every legitimate rebalance;
  //   - "at least one" moved coin must trade, not "all of them". A target that moves BNB
  //     by 6 points and ETH by 1 does execute the decision; the sub-floor ETH leg is the
  //     documented, measured residual of the 2% floor (see isBelowFloor), not an
  //     incoherence. Demanding all of them would fight a rail the project accepted on
  //     purpose.
  const movedCoins = moved.filter((asset) => asset !== reserveAsset);
  const tradedAssets = new Set(movements.map((m) => m.asset));
  if (targetChanged && movedCoins.length > 0 && !movedCoins.some((asset) => tradedAssets.has(asset))) {
    violations.push({
      rule: 'target_not_executable',
      assets: movedCoins,
      detail:
        `the target moved on ${movedCoins.join(', ')} but not one of those lines produces an ` +
        'executable order (each sits under the 2% plumbing floor)' +
        (movements.length > 0
          ? `. The ${[...tradedAssets].join(', ')} movement this cycle comes from book drift on an ` +
            'UNCHANGED target — it is not the decision you just wrote'
          : '') +
        '. A target that cannot move the lines it claims to move is an invalid target, not a ' +
        'hold — say what you mean, or re-emit the reference.',
    });
  }

  // ── Rule 3 — a note on an existing position requires that position to move ────
  //
  // THE MIRROR of `mayWriteThesis`, deliberately reusing the predicate rather than
  // restating it. This is what fired on 987 and 1000 and produced nothing but a
  // console.log. The refusal was right; it just never survived the process.
  //
  // Reusing the predicate is also what keeps cycle 879 passing: four theses on four
  // untouched lines, every one of them legitimate because no line had a thesis yet.
  const refusedNotes = !thesisRulesApply
    ? []
    : notes.filter(
        (note) =>
          !mayWriteThesis({
            booked: movingAssets.has(note.asset),
            hasStoredThesis: assetsWithStoredThesis.has(note.asset),
          }),
      );
  if (refusedNotes.length > 0) {
    const assets = refusedNotes.map((n) => n.asset);
    violations.push({
      rule: 'note_on_unmoved_line',
      assets,
      detail:
        `position_notes rewrites the thesis of ${assets.join(', ')}, which already has one ` +
        'and does not move this cycle — the code would drop it. If the thesis is worth ' +
        'rewriting the position is worth trading; otherwise leave the asset out entirely.',
    });
  }

  // ── Rule 4 — a position that moves must supply its note ──────────────────────
  //
  // The symmetric hole: a line trades and leaves no record of why, so the stored thesis
  // keeps describing the position as it was before the trade.
  //
  // FULL EXITS ARE EXEMPT, and that is not an oversight. `nextPositionState` clears the
  // thesis and its invalidation on a full exit by design — "a thesis about a position
  // that no longer exists is not a thesis". Demanding a note there would demand output
  // the code is contractually about to discard, and rule 4's purpose (no move without a
  // recorded rationale) has no target: there is no line left to record it against. The
  // rationale still lands in what_changed and reasoning, as on any cycle.
  const movedWithoutNote = !thesisRulesApply
    ? []
    : [...movingAssets]
        .filter((asset) => !fullExitAssets.has(asset))
        .filter((asset) => !notes.some((n) => n.asset === asset));
  if (movedWithoutNote.length > 0) {
    violations.push({
      rule: 'moved_line_without_note',
      assets: movedWithoutNote,
      detail:
        `${movedWithoutNote.join(', ')} moves this cycle but carries no entry in ` +
        'position_notes. A line you trade must say what it is now betting on.',
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * The retry message. It NAMES THE VALID WAYS OUT, and that is the load-bearing part.
 *
 * A relaunch that only says "you were incoherent" invites the model to re-emit the same
 * shape, and the cycle dies on the second attempt. In particular the third option below
 * is what keeps cycle 1000 alive: its only fault is a note on an immobile line, and
 * without being told that dropping the note is a legitimate answer, the model tries to
 * justify the note instead. A failed cycle is zero trading — we already carry one
 * failure mode of that family since PR #20 and are not adding a second.
 */
export function buildRetryPrompt(violations: CoherenceViolation[]): string {
  return [
    'Your previous response was REJECTED by the coherence check before anything was',
    'executed. Nothing was ordered and nothing was recorded. Here is exactly what',
    'disagreed with what:',
    '',
    ...violations.map((v) => `- [${v.rule}] ${v.detail}`),
    '',
    'Answer again, in full, with the SAME output format. Three ways out are valid, and',
    'you should pick whichever matches what you actually concluded:',
    '',
    '1. CORRECT THE DECISION — keep the move you reasoned your way to, and make the',
    '   target say it. A real move is worth at least 2% of total capital (below that the',
    '   code discards it and nothing happens) and at least 25% of the position it',
    '   touches. If you are moving a line, give it its position_notes entry.',
    '',
    '2. ABSTAIN — produce a genuine hold: re-emit the reference target UNCHANGED, with',
    '   action_type "hold". Deciding not to act is a legitimate decision; it just has to',
    '   be the one your target expresses.',
    '',
    '3. DROP THE NOTE AND HOLD CLEANLY — if the only problem is a thesis written for a',
    '   line that is not moving, remove that entry from position_notes and return an',
    '   otherwise unchanged hold. An existing thesis PERSISTS on its own; leaving an',
    '   asset out of position_notes keeps its thesis exactly as it is. This is a correct',
    '   and expected answer, not a fallback.',
    '',
    'Do not explain the rejection back to us and do not apologise — just return the',
    'corrected JSON object.',
  ].join('\n');
}
