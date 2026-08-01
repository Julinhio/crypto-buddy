import type { ActionType, PositionNote } from './schema.js';
import type { StrategyVersion } from '../config/index.js';
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
  /** The allocation the model emitted this cycle. */
  targetAllocation: Record<string, number>;
  /**
   * The last target the guard ACCEPTED — read from the DB every cycle, never carried
   * in memory (the bot runs one process per wake-up under Cron Schedule, so there is
   * no memory to carry it in). Null only when no decision has ever been recorded.
   */
  referenceTarget: Record<string, number> | null;
  /** The movements the real pipeline produced for this target. The 2% floor already applied. */
  movements: Movement[];
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
 * The assets whose target moved, comparing ONLY the keys both allocations share.
 *
 * The intersection matters. This cycle's universe is derived from the pairs that
 * actually returned data, so an asset can legitimately disappear between two wake-ups
 * (a dropped feed). Comparing over the union would then read the code's own universe
 * change as the model changing its mind, and every hold in that window would be
 * rejected — a false positive caused entirely by us.
 */
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
    targetAllocation,
    referenceTarget,
    movements,
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

  const moved = referenceTarget ? movedAssets(targetAllocation, referenceTarget) : [];
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
  if (actionType === 'hold' && targetChanged && referenceTarget) {
    violations.push({
      rule: 'hold_moved_target',
      assets: moved,
      detail:
        `action_type is "hold" but the target moved on ${moved.join(', ')}: ` +
        `reference [${fmt(referenceTarget)}] → emitted [${fmt(targetAllocation)}]. ` +
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
  if (targetChanged && movements.length === 0) {
    violations.push({
      rule: 'target_not_executable',
      assets: moved,
      detail:
        `the target moved on ${moved.join(', ')} but produces no executable order ` +
        '(every leg sits under the 2% plumbing floor). A target that cannot move the book ' +
        'is an invalid target, not a hold — say what you mean, or re-emit the reference.',
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
