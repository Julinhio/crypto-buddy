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
 * ── THE TWO QUESTIONS, AND THE TWO OPERANDS THEY NEED ────────────────────────────
 *
 * Rules 1 and 2 are not two rules about the same thing. They are two different questions:
 *
 *   rule 1  did the model CHANGE ITS MIND?      an INTENTION question
 *   rule 2  can that change REACH THE BOOK?     an EXECUTABILITY question
 *
 * They read different operands, and until this PR they did not. That is the defect this
 * file was rewritten to close.
 *
 * RULE 1 READS INTENTION AGAINST INTENTION, RAW, UNCLAMPED. `intentTarget` is what the
 * model just wrote; `intentReference` is what it last wrote, restated in this cycle's
 * universe by the one pipeline allowed to do so (`restateIntentReference`). Neither is
 * bounded by the caps, and that is the whole point:
 *
 *   - a BOUNDED reference is lossy when the policy RELAXES. Raise BTC's ceiling from 35
 *     to 40 and a reference stored at 35 is compared to a candidate the clamp now lets
 *     through at 40. The model's unchanged 40% ask reads as a moved target, the first
 *     attempt is rejected, and the retry pays for it every cycle for as long as the model
 *     keeps asking;
 *   - the symmetric case — a TIGHTENED policy — was an outright interlock, closed by
 *     PR #28 by clamping the reference too. Raw-against-raw closes BOTH at once and
 *     structurally, because a comparison between two unclamped intentions is invariant to
 *     the policy by construction. There is no coordinate system left to disagree about.
 *
 * RULE 2 IS THE OPPOSITE — it can only be judged against the book, because an order is
 * born from the gap between the target and what is actually held. So it takes the
 * movements the real pipeline computed (clamp → computeMovements, 2% floor included)
 * rather than re-deriving them.
 *
 * ── THE FIRST TRAP, AND IT STILL STANDS ──────────────────────────────────────────
 *
 * TARGET IS COMPARED TO THE PREVIOUS TARGET, NEVER TO THE VALUED BOOK. If the emitted
 * target were compared to the current valuation, every hold would fail: BTC is worth
 * 24.46% against a 25% target purely because the price moved. A model re-emitting 25 has
 * changed nothing. This is the single most likely way to build a guard that kills the bot.
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
   * cannot reach the book, are incoherent whatever the mandate.
   */
  strategy: StrategyVersion;
  actionType: ActionType;
  /**
   * THIS CYCLE'S INTENTION — the model's RAW emission, exactly as it wrote it.
   *
   * Raw, not clamped, and it must be the same KIND of value as `intentReference`. That
   * symmetry is what makes rule 1 policy-invariant: two unclamped intentions compared to
   * each other cannot land in two different coordinate systems, whichever way a cap moves
   * between the two cycles.
   */
  intentTarget: Record<string, number>;
  /**
   * THE LAST INTENTION THE GUARD ACCEPTED — read from the DB every cycle, never carried
   * in memory (the bot runs one process per wake-up under Cron Schedule, so there is no
   * memory to carry it in). Resolved from `intent_allocation`, falling back to the raw
   * proposal on rows predating migration 0027. Null only when no decision has ever been
   * recorded.
   *
   * ALREADY RESTATED, and this input is the reason `restateIntentReference` exists as a
   * single entry point: the caller hands over a value that is in this cycle's universe,
   * whose total has been verified, and which has NOT been clamped. Callers must not
   * normalise it themselves — two callers normalising separately is exactly how the
   * operands drifted apart in the first place.
   */
  intentReference: Record<string, number> | null;
  /**
   * The movements the real pipeline produced for THIS cycle's effective target. The 2%
   * floor already applied.
   */
  movements: Movement[];
  /**
   * THE COUNTERFACTUAL — the movements the PREVIOUS intention would produce, bounded by
   * TODAY's policy, against TODAY's book. Rule 2 reads it, and nothing else does.
   *
   * A decision reaches the book by creating an order, by modifying one, or BY CANCELLING
   * ONE. The third case was invisible while rule 2 looked only at the new plan: a decision
   * whose entire effect is "do not do what I was about to do" produces no movement of its
   * own and read as void. It is not void — it changes what happens.
   *
   * That case became reachable the day the transition gate started blocking. A refused
   * cycle advances the INTENTION and leaves the book where it was, so the standing
   * intention is a plan that has not executed; withdrawing it is a real decision with a
   * real effect, and rejecting it would trap the model inside a plan the gate will not let
   * through.
   *
   * COMPUTED BEFORE THE GATE, and that ordering is load-bearing. Computed after, a frozen
   * asset yields two empty plans — the old one and the new one both filtered out — and
   * rule 2 would reject a decision for being unexecutable when the only thing making it
   * unexecutable is the layer the guard is explicitly not marking the homework of.
   * `computeMovements` is pure and gate-blind, which is what makes "before" cheap.
   *
   * Empty is a legitimate value: there is no previous intention on the first decision on
   * record, and an intention that already executed produces nothing new against the book
   * it produced.
   */
  previousIntentMovements: Movement[];
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
 * The assets whose INTENTION moved, comparing ONLY the keys both allocations share.
 *
 * A key present in one and not the other is not comparable and is not a change of mind.
 * The universe restatement upstream has already removed the keys this cycle no longer
 * offers, so what reaches here is a genuine intersection rather than an accident of the
 * feed.
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
 * it the whole production corpus without touching the network.
 *
 * IT NO LONGER CLAMPS ANYTHING, and it no longer takes a risk policy. The bounding rule 2
 * needs happens upstream, where the movements are computed; the bounding rule 1 used to
 * need went away with the defect. A guard whose verdict depends on today's caps is a guard
 * that cannot answer an intention question, and rule 1 is an intention question.
 */
export function checkCoherence(input: CoherenceInput): CoherenceVerdict {
  const {
    strategy,
    actionType,
    intentTarget,
    intentReference,
    movements,
    previousIntentMovements,
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

  // THE INTENTION COMPARISON. One derivation, read by rules 1 and 2 — rules 3 and 4 are
  // about theses and never touch it, so there is no rule left that could hold a different
  // notion of "moved".
  const intentMoved = intentReference ? movedAssets(intentTarget, intentReference) : [];
  const intentChanged = intentMoved.length > 0;

  // ── Rule 1 — a hold cannot modify the reference intention ─────────────────────
  //
  // The cycle-987 family, in the direction that loses a trade: the model reasons its way
  // to a move and labels it a hold, or reasons its way to a hold and leaves a moved
  // target behind. Either way the two halves disagree and one of them is silently
  // discarded downstream.
  //
  // Not evaluated at all when there is no reference (the very first decision on record):
  // there is nothing to have modified.
  if (actionType === 'hold' && intentChanged && intentReference) {
    violations.push({
      rule: 'hold_moved_target',
      assets: intentMoved,
      detail:
        `action_type is "hold" but the target moved on ${intentMoved.join(', ')}: ` +
        `reference [${fmt(intentReference)}] → emitted [${fmt(intentTarget)}]. ` +
        'A hold keeps the reference target; a changed target is not a hold.',
    });
  }

  // ── Rule 2 — an intention that cannot reach the book is an invalid intention ───
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
  // ASKED IN COUNTERFACTUAL, and this is what changed. The question is not "does the new
  // plan trade this line" but "does this line's fate DIFFER because of the decision" —
  // which is answered by replaying BOTH intentions against the same book. A decision that
  // cancels an order the standing intention would have fired reaches the book just as
  // surely as one that places a new order, and is refused only when NEITHER plan can touch
  // the lines it claims to move. Judging on the new plan alone was too strict in exactly
  // the case a blocking gate creates: an intention that never executed stays standing, and
  // withdrawing it is a real decision.
  //
  // TWO deliberate calibrations, both unchanged:
  //   - the RESERVE is excluded. Cash moves on every trade (it is the other side of
  //     every leg) and is never traded directly, so requiring a movement for it would
  //     reject every legitimate rebalance;
  //   - "at least one" moved coin must be reachable, not "all of them". A target that
  //     moves BNB by 6 points and ETH by 1 does execute the decision; the sub-floor ETH
  //     leg is the documented, measured residual of the 2% floor (see isBelowFloor), not
  //     an incoherence. Demanding all of them would fight a rail the project accepted on
  //     purpose.
  const movedCoins = intentMoved.filter((asset) => asset !== reserveAsset);
  const tradedAssets = new Set(movements.map((m) => m.asset));
  const previouslyTradedAssets = new Set(previousIntentMovements.map((m) => m.asset));
  const reachable = (asset: string): boolean =>
    tradedAssets.has(asset) || previouslyTradedAssets.has(asset);
  if (intentChanged && movedCoins.length > 0 && !movedCoins.some(reachable)) {
    violations.push({
      rule: 'target_not_executable',
      assets: movedCoins,
      detail:
        `the target moved on ${movedCoins.join(', ')} but neither this target nor the reference ` +
        'one produces an executable order on those lines against the current book (each sits ' +
        'under the 2% plumbing floor, whichever of the two is replayed)' +
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
  //
  // Judged on the REAL movements, never on the counterfactual: a thesis records why a line
  // is being traded NOW, and a line only the withdrawn plan would have touched is not
  // being traded at all.
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
 *
 * The "reference target" option 2 names is the REFERENCE INTENTION, quoted verbatim in
 * the rule-1 detail above. That is the amendment this PR makes explicit to PR #27's
 * contract: the model's intention may be reread by the guard and by its rejection
 * messages, as immutable history. Never as an execution target, and never as a
 * description of the book — `applied_allocation` remains the only allocation an
 * operational path reads.
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
