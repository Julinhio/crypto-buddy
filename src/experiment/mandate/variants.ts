import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import { buildSystemPromptV5 } from '../../decision/promptV5.js';

/**
 * THE FOUR MANDATES of the framing experiment — control, placebo, floor
 * clarification, global ownership.
 *
 * The hard constraint (brief §3.1): each variant differs from the CONTROL by its
 * authorised addition and by NOTHING else. That property is not promised, it is
 * PROVED: every variant is built by inserting lines into the control's line array,
 * and `proveVariantProperty` re-derives the control from the variant by removing
 * exactly those lines and compares byte-for-byte. The proof, the anchors and the
 * SHA-256 fingerprints are published in the run artefacts.
 *
 * The control is the PRODUCTION prompt: `buildSystemPromptV5(config, 'enforce')`.
 * The mode is not a guess — all four persisted contexts of the experiment carry the
 * `actionable` field that only the enforce payload has (checked by gate 1 in
 * reconstruct.ts). The prompt-feeding config values (caps, thresholds, floor,
 * minMovementPercent, tradable pairs) are code constants, not env-overridable, and
 * `promptV5.ts` / `schema.ts` / `context.ts` are unchanged since commit 41259c0
 * (12/08) — before the earliest decision replayed here. Byte-identity with what
 * production sent is therefore established by git, and restated as a hash.
 */

export type MandateId = 'C' | 'P' | 'F' | 'O';

export const MANDATE_IDS: readonly MandateId[] = ['C', 'P', 'F', 'O'] as const;

interface Insertion {
  /** Exact line of the CONTROL prompt the addition is inserted AFTER. Must match exactly one line. */
  anchorLine: string;
  /** The inserted lines, verbatim (joined with '\n' like the rest of the prompt). */
  lines: string[];
}

/**
 * The authorised additions, frozen from the brief. P and O share the temperament
 * anchor on purpose: P is the saliency placebo, so it sits where O sits — same
 * position, same paragraph shape, same length class — and differs only in content.
 * F is anchored to the cash-floor line, as the brief requires ("à proximité du
 * plancher de cash"). No addition prescribes any exposure number anywhere.
 */
const TEMPERAMENT_ANCHOR = 'legitimate when nothing warrants acting; it is not the default posture.';

const INSERTIONS: Record<Exclude<MandateId, 'C'>, Insertion> = {
  P: {
    anchorLine: TEMPERAMENT_ANCHOR,
    lines: [
      '',
      'Confidence is a portfolio-level judgment. Choose it explicitly from the strength',
      'of the evidence, rather than letting it emerge accidentally from the number of',
      'signals.',
    ],
  },
  F: {
    anchorLine: `  this bounds total deployed capital to at most ${100 - config.execution.caps.minCashPercent}%.`,
    lines: [
      '',
      `The ${config.execution.caps.minCashPercent}% cash floor is a safety limit, not a recommended allocation or a cash`,
      'target.',
    ],
  },
  O: {
    anchorLine: TEMPERAMENT_ANCHOR,
    lines: [
      '',
      'Total deployed exposure is a portfolio-level decision, not merely the sum of',
      'per-asset decisions. Make that choice explicitly and intentionally.',
    ],
  },
};

export interface MandatePrompt {
  id: MandateId;
  prompt: string;
  sha256: string;
  /** Null for the control; the applied insertion otherwise. */
  insertion: Insertion | null;
  /** Line index (0-based, in the control's line array) after which the lines were inserted. */
  insertedAfterLine: number | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function insertAfterAnchor(controlLines: string[], insertion: Insertion): { lines: string[]; at: number } {
  const matches = controlLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line === insertion.anchorLine);
  if (matches.length !== 1) {
    throw new Error(
      `variant anchor matched ${matches.length} line(s) instead of exactly 1: "${insertion.anchorLine}" — ` +
        'the control prompt no longer contains the anchor this experiment was frozen against. ' +
        'Stop and re-verify the variants against the current prompt; do not guess a position.',
    );
  }
  const at = matches[0]!.i;
  return { lines: [...controlLines.slice(0, at + 1), ...insertion.lines, ...controlLines.slice(at + 1)], at };
}

/** Builds all four mandates from the production prompt. Throws on any anchor problem. */
export function buildMandates(): Record<MandateId, MandatePrompt> {
  const control = buildSystemPromptV5(config, 'enforce');
  const controlLines = control.split('\n');

  const result = {
    C: { id: 'C', prompt: control, sha256: sha256(control), insertion: null, insertedAfterLine: null },
  } as Record<MandateId, MandatePrompt>;

  for (const id of ['P', 'F', 'O'] as const) {
    const insertion = INSERTIONS[id];
    const { lines, at } = insertAfterAnchor(controlLines, insertion);
    const prompt = lines.join('\n');
    result[id] = { id, prompt, sha256: sha256(prompt), insertion, insertedAfterLine: at };
  }
  return result;
}

export interface VariantProof {
  id: MandateId;
  ok: boolean;
  detail: string;
}

/**
 * THE PROOF of the hard constraint: removing exactly the inserted lines from the
 * variant, at exactly the recorded position, yields the control byte-for-byte.
 * Anything else — a stray edit, a drifted anchor, an accidental double insertion —
 * fails loudly here, before a single call is made.
 */
export function proveVariantProperty(mandates: Record<MandateId, MandatePrompt>): VariantProof[] {
  const control = mandates.C.prompt;
  const proofs: VariantProof[] = [
    { id: 'C', ok: true, detail: 'control — the production prompt itself, no addition to prove.' },
  ];
  for (const id of ['P', 'F', 'O'] as const) {
    const m = mandates[id];
    if (m.insertion == null || m.insertedAfterLine == null) {
      proofs.push({ id, ok: false, detail: 'variant carries no insertion record — cannot prove anything.' });
      continue;
    }
    const lines = m.prompt.split('\n');
    const start = m.insertedAfterLine + 1;
    const removed = lines.slice(start, start + m.insertion.lines.length);
    const rest = [...lines.slice(0, start), ...lines.slice(start + m.insertion.lines.length)].join('\n');
    const removedMatch = JSON.stringify(removed) === JSON.stringify(m.insertion.lines);
    const ok = removedMatch && rest === control;
    proofs.push({
      id,
      ok,
      detail: ok
        ? `removing the ${m.insertion.lines.length} inserted line(s) after line ${m.insertedAfterLine} ` +
          'restores the control byte-for-byte.'
        : 'removing the recorded insertion does NOT restore the control — the variant differs by more than its addition.',
    });
  }
  return proofs;
}
