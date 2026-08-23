import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSupabaseClient } from '../../persistence/supabase.js';
import { assertAnthropicConfigured, resolveModel, runDecision } from '../../decision/llm.js';
import { classifyLlmFailure } from '../../decision/llmFailure.js';
import { buildMandates, proveVariantProperty, MANDATE_IDS, type MandateId } from './variants.js';
import {
  EXPERIMENT_CONTEXTS,
  reconstructCycle,
  type ReconstructedCycle,
} from './reconstruct.js';
import { judgeResponse } from './pipeline.js';
import { analyze, evaluateGate2 } from './analyze.js';
import { buildReport } from './report.js';
import {
  EXPERIMENT_REPS,
  localThreshold,
  median,
  planMainCalls,
  type CallRecord,
  type PlannedCall,
  type Phase,
  type TransportReplay,
} from './records.js';

/**
 * THE EXPERIMENT RUNNER — brief « Harnais d'expérience sur le cadrage du mandat v5 ».
 *
 * SAFETY BY CONSTRUCTION, the probe's posture (src/probes/v5Behaviour.ts): this file
 * imports the prompt builders, the LLM client, the judgement pipeline and the
 * READ-ONLY loaders — and nothing else. No executor, no Telegram, no Healthchecks,
 * no insert of any kind. It cannot write a row or place an order because it has no
 * way to reach either.
 *
 * PHASES (the protocol's order, closed and arbitrated):
 *   0. variants built and PROVED, four contexts reconstructed — gate 1. Any failure
 *      stops before a single call.
 *   A. the control C, 4 contexts × 5 reps, context-interleaved — then gate 2.
 *   B. P/F/O, latin-square rotated per (round, context) — never a variant block.
 *   E. the negative control's extensions: an anomalous cell on 1494 gets +3 reps.
 *
 * Every call is appended to `out/mandate-experiment/calls.jsonl` the moment it
 * lands, so a crashed or interrupted run RESUMES: already-recorded (mandate,
 * context, rep) triples are never re-called, and their timestamps are preserved.
 *
 * Run: `npm run experiment:mandate` (flags: --reconstruct-only, --analyze-only).
 */

const OUT_DIR = path.join('out', 'mandate-experiment');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const CALLS_FILE = path.join(OUT_DIR, 'calls.jsonl');
const REPORT_FILE = path.join('docs', 'RAPPORT-EXPERIENCE-MANDAT-V5.md');

/** Production's decision model — verified against `decisions.model` on all four rows. */
const PRODUCTION_MODEL = 'claude-sonnet-4-6';
const REPS = EXPERIMENT_REPS;
const EXTENSION_REPS = 3;
/** Transport-family failures are replayed (brief §3.4); anything else aborts the run. */
const MAX_TRANSPORT_REPLAYS = 4;

const NEGATIVE_CONTROL = 1494;
const VARIANTS: readonly MandateId[] = ['P', 'F', 'O'];

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loadExistingCalls(): CallRecord[] {
  if (!existsSync(CALLS_FILE)) return [];
  return readFileSync(CALLS_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CallRecord);
}

async function executeCall(
  planned: PlannedCall,
  cycle: ReconstructedCycle,
  systemPrompt: string,
  requestedModel: string,
): Promise<CallRecord> {
  const key = `${planned.mandate}_${planned.contextId}_r${planned.rep}`;
  const transportReplays: TransportReplay[] = [];
  const startedAt = nowIso();

  for (let attempt = 0; ; attempt += 1) {
    try {
      const llm = await runDecision({
        systemPrompt,
        userPrompt: cycle.userPrompt,
        assets: cycle.inputs.assets,
        strategy: 'v5',
        // NO retry parameter, ever: the experiment judges the PRIMARY response.
      });
      const judgement = judgeResponse(llm.rawResponse, cycle.inputs);

      const rawFile = `${key}.json`;
      writeFileSync(
        path.join(RAW_DIR, rawFile),
        JSON.stringify(
          {
            key,
            startedAt,
            rawResponse: llm.rawResponse,
            parseError: llm.parseError,
            stopReason: llm.stopReason,
            targetAllocation: judgement.decision?.targetAllocation ?? null,
            appliedAllocation: judgement.clamp?.applied ?? null,
            guardViolations: judgement.guard?.violations ?? [],
            movements: judgement.movements,
          },
          null,
          2,
        ),
      );

      return {
        key,
        orderIndex: planned.orderIndex,
        phase: planned.phase,
        mandate: planned.mandate,
        contextId: planned.contextId,
        rep: planned.rep,
        startedAt,
        finishedAt: nowIso(),
        requestedModel,
        returnedModel: llm.model,
        latencyMs: llm.latencyMs,
        inputTokens: llm.inputTokens,
        outputTokens: llm.outputTokens,
        stopReason: llm.stopReason,
        transportReplays,
        outcome: judgement.outcome,
        orderViolation: judgement.orderViolation,
        invalidReason: judgement.invalidReason,
        guardRules: judgement.guard?.violations.map((v) => v.rule) ?? [],
        requestedExposure: judgement.requestedExposure,
        appliedExposure: judgement.appliedExposure,
        clamped: judgement.clamp?.clamped ?? null,
        actionType: judgement.decision?.actionType ?? null,
        confidence: judgement.decision?.confidence ?? null,
        openedZeroLines: judgement.openedZeroLines,
        movements: judgement.movements,
        rawFile,
      };
    } catch (err) {
      const failure = classifyLlmFailure(err, { logicalAttempt: attempt + 1, elapsedMs: null });
      if (failure.failureClass === 'retryable_llm_transport' && attempt < MAX_TRANSPORT_REPLAYS) {
        const delayMs = 10_000 * 2 ** attempt;
        console.warn(
          `[transport] ${key}: ${failure.errorType} (${failure.message}) — replayed in ${delayMs / 1000}s ` +
            `(${attempt + 1}/${MAX_TRANSPORT_REPLAYS}); counted separately, never as an invalid response.`,
        );
        transportReplays.push({
          at: nowIso(),
          errorType: failure.errorType,
          failureClass: failure.failureClass,
          httpStatus: failure.httpStatus,
          message: failure.message,
        });
        await sleep(delayMs);
        continue;
      }
      // A non-transport failure (auth, bad request, unknown model…) is systemic: the
      // run stops with its state on disk, and resumes exactly where it was.
      throw new Error(
        `call ${key} failed outside the transport family (${failure.errorType}: ${failure.message}) — ` +
          'stopping the run; already-recorded calls are preserved and the run is resumable.',
        { cause: err },
      );
    }
  }
}

function appendCall(record: CallRecord): void {
  appendFileSync(CALLS_FILE, `${JSON.stringify(record)}\n`);
}

/** Anomaly rule for the negative control (preregistered, brief §6.3). */
function extensionTriggers(calls: CallRecord[]): Array<{ mandate: MandateId; reason: string }> {
  const controlExposures = calls
    .filter((c) => c.mandate === 'C' && c.contextId === NEGATIVE_CONTROL && c.outcome === 'accepted')
    .map((c) => c.requestedExposure)
    .filter((e): e is number => e != null);
  if (controlExposures.length === 0) return [];
  const controlMedian = median(controlExposures);
  const threshold = localThreshold(controlExposures);

  const triggers: Array<{ mandate: MandateId; reason: string }> = [];
  for (const mandate of VARIANTS) {
    const cell = calls.filter(
      (c) => c.mandate === mandate && c.contextId === NEGATIVE_CONTROL && c.phase !== 'extension',
    );
    const anomalous = cell.filter(
      (c) =>
        c.outcome === 'accepted' &&
        ((c.requestedExposure != null && c.requestedExposure >= controlMedian + threshold) ||
          c.openedZeroLines.length > 0),
    );
    if (anomalous.length > 0) {
      triggers.push({
        mandate,
        reason:
          `${anomalous.length} réponse(s) anormale(s) sur 1494 ` +
          `(exposition ≥ médiane C + seuil, ou ouverture d'une ligne à zéro) — +${EXTENSION_REPS} répétitions`,
      });
    }
  }
  return triggers;
}

async function main(): Promise<number> {
  const reconstructOnly = process.argv.includes('--reconstruct-only');
  const analyzeOnly = process.argv.includes('--analyze-only');

  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(path.join(OUT_DIR, 'prompts'), { recursive: true });

  // ── Phase 0a — the four mandates, and the proof of the hard constraint ─────────
  const mandates = buildMandates();
  const proofs = proveVariantProperty(mandates);
  writeFileSync(
    path.join(OUT_DIR, 'variants.json'),
    JSON.stringify(
      MANDATE_IDS.map((id) => ({
        id,
        sha256: mandates[id].sha256,
        insertion: mandates[id].insertion,
        insertedAfterLine: mandates[id].insertedAfterLine,
        proof: proofs.find((p) => p.id === id),
      })),
      null,
      2,
    ),
  );
  for (const id of MANDATE_IDS) {
    writeFileSync(path.join(OUT_DIR, 'prompts', `system_${id}.txt`), mandates[id].prompt);
  }
  if (!proofs.every((p) => p.ok)) {
    console.error('[STOP] la preuve de la contrainte dure a échoué — voir variants.json.');
    return 1;
  }
  console.log('[variants] 4 mandats construits, contrainte dure prouvée.');
  for (const id of MANDATE_IDS) console.log(`  ${id}: ${mandates[id].sha256}`);

  // ── Phase 0b — reconstruction and gate 1 ───────────────────────────────────────
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[STOP] Supabase non configuré — la reconstruction est impossible.');
    return 1;
  }
  const cycles: ReconstructedCycle[] = [];
  for (const spec of EXPERIMENT_CONTEXTS) {
    const cycle = await reconstructCycle(supabase, spec);
    cycles.push(cycle);
    writeFileSync(path.join(OUT_DIR, 'prompts', `user_${spec.decisionId}.txt`), cycle.userPrompt);
    console.log(
      `[porte 1] décision ${spec.decisionId} (${spec.role}) : ${cycle.gate1.ok ? 'OK' : 'ARRÊT'}`,
    );
    for (const check of cycle.gate1.checks) {
      console.log(`   ${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
    }
  }
  writeFileSync(
    path.join(OUT_DIR, 'reconstruction.json'),
    JSON.stringify(
      cycles.map((c) => ({
        decisionId: c.spec.decisionId,
        role: c.spec.role,
        createdAt: c.row.created_at,
        lastSignificantId: c.lastSignificant?.id ?? null,
        guardReferenceId: c.guardReferenceId,
        fingerprints: c.fingerprints,
        gate1: c.gate1,
      })),
      null,
      2,
    ),
  );

  const requestedModel = ((): string => {
    process.env.ANTHROPIC_MODEL = PRODUCTION_MODEL;
    return resolveModel();
  })();

  const writeReportFile = (calls: CallRecord[], aborted: string | null): void => {
    const gate2 = evaluateGate2(calls);
    const report = buildReport({
      generatedAt: nowIso(),
      requestedModel,
      mandates,
      proofs,
      cycles,
      gate2,
      plan: fullPlan,
      calls,
      analysis: aborted == null && calls.length > 0 ? analyze(calls) : null,
      aborted,
    });
    mkdirSync('docs', { recursive: true });
    writeFileSync(REPORT_FILE, report);
    console.log(`[rapport] écrit dans ${REPORT_FILE}`);
  };

  const fullPlan = planMainCalls(EXPERIMENT_CONTEXTS.map((s) => s.decisionId));
  writeFileSync(path.join(OUT_DIR, 'order.json'), JSON.stringify(fullPlan, null, 2));

  if (!cycles.every((c) => c.gate1.ok)) {
    writeReportFile([], 'La porte 1 a tiré : au moins un contexte ne se reconstruit pas fidèlement. Aucun appel effectué.');
    console.error('[STOP] porte 1 — reconstruction divergente. Retour à Julien avec l\'état.');
    return 1;
  }
  if (reconstructOnly) {
    console.log('[ok] --reconstruct-only : porte 1 validée, aucun appel effectué.');
    return 0;
  }

  // ── THE RUN MANIFEST — what makes a resumed corpus provably THIS experiment ───
  //
  // `calls.jsonl` survives code, prompt, config and model changes, and a resumed run
  // skips every key it finds there. Without this check, responses produced under a
  // DIFFERENT experiment would be silently republished under the freshly computed
  // hashes — mixed corpora wearing one manifest. So the identity of the experiment
  // (mandate hashes, reconstructed user-prompt hashes, model, plan shape) is frozen
  // in a manifest next to the corpus: a mismatch refuses the stale artefacts rather
  // than absorbing them. A pre-manifest corpus is admitted once — its provenance is
  // still checked record-by-record on `requestedModel` below, and the manifest
  // written now freezes it for every later run.
  const manifest = {
    schemaVersion: 1,
    requestedModel,
    mandateSha256: Object.fromEntries(MANDATE_IDS.map((id) => [id, mandates[id].sha256])),
    userPromptSha256: Object.fromEntries(
      cycles.map((c) => [String(c.spec.decisionId), c.fingerprints.userPromptSha256]),
    ),
    reps: REPS,
    contexts: EXPERIMENT_CONTEXTS.map((s) => s.decisionId),
  };
  const manifestFile = path.join(OUT_DIR, 'manifest.json');
  if (existsSync(manifestFile)) {
    const stored = readFileSync(manifestFile, 'utf8');
    if (stored !== JSON.stringify(manifest, null, 2)) {
      console.error(
        '[STOP] le manifeste du corpus existant ne correspond pas à l\'expérience courante ' +
          '(prompts, contextes, modèle ou plan modifiés depuis les appels enregistrés). ' +
          `Déplacer ou supprimer ${OUT_DIR} pour repartir d'un corpus propre — les appels ` +
          'existants ne seront pas mélangés à une expérience différente.',
      );
      return 1;
    }
  } else {
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }

  const cycleOf = new Map(cycles.map((c) => [c.spec.decisionId, c]));
  const existing = loadExistingCalls();
  const wrongModel = existing.filter((c) => c.requestedModel !== requestedModel);
  if (wrongModel.length > 0) {
    console.error(
      `[STOP] ${wrongModel.length} appel(s) enregistré(s) avec un autre modèle demandé ` +
        `(${[...new Set(wrongModel.map((c) => c.requestedModel))].join(', ')} ≠ ${requestedModel}) — ` +
        `corpus mélangé, déplacer ou supprimer ${OUT_DIR}.`,
    );
    return 1;
  }
  // Duplicates are detected HERE, on the raw journal, BEFORE the Map collapses them —
  // collapsed, they would be invisible to every later check while the exactly-once
  // requirement silently kept an arbitrary one of the two responses. Two concurrent
  // runner processes are the realistic way to produce this.
  const dupKeys = [...new Set(existing.map((c) => c.key).filter((k, i, arr) => arr.indexOf(k) !== i))];
  if (dupKeys.length > 0) {
    console.error(
      `[STOP] ${dupKeys.length} clé(s) en double dans calls.jsonl (${dupKeys.join(', ')}) — ` +
        'deux processus ont probablement écrit le même corpus. Aucune des deux réponses n\'est ' +
        `choisie en silence : déplacer ou supprimer ${OUT_DIR} et relancer.`,
    );
    return 1;
  }

  // ── RE-JUDGE the stored corpus — the manifest's blind spot, closed ────────────
  //
  // The manifest freezes the prompts, the contexts and the model; it says nothing
  // about the JUDGMENT code (schema, clamp, movements, coherence guard). A change
  // there would leave the manifest identical while the stored verdicts describe a
  // pipeline that no longer exists — and §6.4 makes refusal counts eliminatory, so a
  // stale verdict is a stale conclusion. Rather than fingerprinting source files,
  // the check is BEHAVIOURAL: every stored raw response is re-judged by the current
  // pipeline (pure CPU, no network) and must reproduce its recorded verdict exactly.
  const misjudged: string[] = [];
  for (const record of existing) {
    const rawPath = path.join(RAW_DIR, record.rawFile);
    if (!existsSync(rawPath)) {
      misjudged.push(`${record.key} (réponse brute absente: ${record.rawFile})`);
      continue;
    }
    const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as { rawResponse: string };
    const cycle = cycleOf.get(record.contextId);
    if (!cycle) {
      misjudged.push(`${record.key} (contexte ${record.contextId} inconnu de l'expérience courante)`);
      continue;
    }
    const rejudged = judgeResponse(raw.rawResponse, cycle.inputs);
    const same =
      rejudged.outcome === record.outcome &&
      (rejudged.requestedExposure ?? null) === (record.requestedExposure ?? null) &&
      JSON.stringify(rejudged.guard?.violations.map((v) => v.rule) ?? []) === JSON.stringify(record.guardRules) &&
      JSON.stringify(rejudged.openedZeroLines) === JSON.stringify(record.openedZeroLines);
    if (!same) misjudged.push(record.key);
  }
  if (misjudged.length > 0) {
    console.error(
      `[STOP] ${misjudged.length} appel(s) enregistré(s) dont le verdict ne se reproduit plus avec le ` +
        `pipeline courant : ${misjudged.slice(0, 10).join(', ')}${misjudged.length > 10 ? '…' : ''}. ` +
        'Le code de jugement a changé depuis le corpus — les conclusions stockées décrivent un autre ' +
        `pipeline. Déplacer ou supprimer ${OUT_DIR} et relancer l'expérience entière.`,
    );
    return 1;
  }
  if (existing.length > 0) {
    console.log(`[reprise] ${existing.length} appel(s) existant(s) — verdicts re-jugés et reproduits à l'identique.`);
  }

  const done = new Map(existing.map((c) => [c.key, c]));
  const calls: CallRecord[] = [...done.values()];

  if (!analyzeOnly) {
    assertAnthropicConfigured();

    const run = async (planned: PlannedCall): Promise<void> => {
      const key = `${planned.mandate}_${planned.contextId}_r${planned.rep}`;
      if (done.has(key)) return;
      const cycle = cycleOf.get(planned.contextId)!;
      const record = await executeCall(planned, cycle, mandates[planned.mandate].prompt, requestedModel);
      appendCall(record);
      done.set(key, record);
      calls.push(record);
      console.log(
        `[appel ${record.orderIndex}] ${key}: ${record.outcome}` +
          (record.requestedExposure != null ? `, exposition demandée ${record.requestedExposure.toFixed(1)}%` : '') +
          ` (${(record.latencyMs / 1000).toFixed(1)}s)`,
      );
    };

    // Phase A — the control, then gate 2 before any variant call.
    for (const planned of fullPlan.filter((p) => p.phase === 'control')) await run(planned);

    const gate2 = evaluateGate2(calls);
    writeFileSync(path.join(OUT_DIR, 'gate2.json'), JSON.stringify(gate2, null, 2));
    for (const g of gate2) console.log(`[porte 2] ${g.contextId}: ${g.ok ? 'OK' : 'ARRÊT'} — ${g.detail}`);
    if (!gate2.some((g) => !g.ok)) {
      console.log('[porte 2] validée sur les quatre contextes — phase variantes.');
    } else {
      writeReportFile(
        calls,
        'La porte 2 a tiré : le contrôle C ne reproduit pas la réponse historique dans le seuil ' +
          'local sur au moins un contexte. Les variantes n\'ont pas été exécutées.',
      );
      console.error('[STOP] porte 2 — arrêt complet. Retour à Julien avec l\'état.');
      return 1;
    }

    // Phase B — the variants, interleaved.
    for (const planned of fullPlan.filter((p) => p.phase === 'variants')) await run(planned);

    // Phase E — the negative control's extensions.
    const triggers = extensionTriggers(calls);
    let orderIndex = fullPlan.length;
    for (const trigger of triggers) {
      console.log(`[extension] ${trigger.mandate}@${NEGATIVE_CONTROL} : ${trigger.reason}`);
      for (let i = 1; i <= EXTENSION_REPS; i += 1) {
        const planned: PlannedCall = {
          orderIndex: orderIndex++,
          phase: 'extension' as Phase,
          mandate: trigger.mandate,
          contextId: NEGATIVE_CONTROL,
          rep: REPS + i,
        };
        await run(planned);
      }
    }
    if (triggers.length > 0) {
      writeFileSync(path.join(OUT_DIR, 'extensions.json'), JSON.stringify(triggers, null, 2));
    }
  }

  // ── Analysis + committed report ────────────────────────────────────────────────
  if (calls.length === 0) {
    console.error('[STOP] aucun appel enregistré — rien à analyser.');
    return 1;
  }

  // THE COMPLETENESS GATE. `--analyze-only` (and any interrupted run) can hand this
  // point a partial corpus, and a missing cell would read as a null median that the
  // mechanical synthesis renders as "pas d'effet" — a conclusion manufactured by
  // absence. So the final report is only ever produced from a corpus holding EVERY
  // planned call exactly once, plus every extension the recorded data itself demands.
  const expectedKeys = new Set(fullPlan.map((p) => `${p.mandate}_${p.contextId}_r${p.rep}`));
  for (const trigger of extensionTriggers(calls)) {
    for (let i = 1; i <= EXTENSION_REPS; i += 1) {
      expectedKeys.add(`${trigger.mandate}_${NEGATIVE_CONTROL}_r${REPS + i}`);
    }
  }
  // THE JOURNAL IS RE-READ FROM DISK before anything is published. The load-time
  // duplicate check ran on a snapshot: two fresh processes started together both see
  // an empty journal, both pass it, and both append — each one's in-memory `calls`
  // stays exactly-once while the shared file holds every key twice. Only the file
  // knows, so the file is what gets checked.
  const onDisk = loadExistingCalls();
  const diskKeys = onDisk.map((c) => c.key);
  const diskDups = [...new Set(diskKeys.filter((k, i, arr) => arr.indexOf(k) !== i))];
  if (diskDups.length > 0) {
    console.error(
      `[STOP] ${diskDups.length} clé(s) en double dans le journal SUR DISQUE (${diskDups.join(', ')}) — ` +
        'un autre processus a écrit calls.jsonl pendant ce run. Aucun rapport produit ; ' +
        `déplacer ou supprimer ${OUT_DIR} et relancer une seule instance.`,
    );
    return 1;
  }
  if ([...diskKeys].sort().join('|') !== calls.map((c) => c.key).sort().join('|')) {
    console.error(
      '[STOP] le journal sur disque ne correspond plus au corpus de ce processus — écriture ' +
        'concurrente probable. Aucun rapport produit ; relancer une seule instance.',
    );
    return 1;
  }

  // What can still be wrong is coverage — a call the plan expects and the corpus
  // lacks (interrupted run under --analyze-only), or one the plan does not know.
  const presentKeys = calls.map((c) => c.key);
  const missing = [...expectedKeys].filter((k) => !presentKeys.includes(k));
  const unexpected = presentKeys.filter((k) => !expectedKeys.has(k));
  if (missing.length > 0 || unexpected.length > 0) {
    console.error(
      '[STOP] corpus incomplet ou incohérent — aucun rapport final produit.\n' +
        `  manquants (${missing.length}) : ${missing.join(', ') || '—'}\n` +
        `  inattendus (${unexpected.length}) : ${unexpected.join(', ') || '—'}\n` +
        'Relancer `npm run experiment:mandate` pour compléter les appels manquants.',
    );
    return 1;
  }

  const analysis = analyze(calls);
  writeFileSync(path.join(OUT_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2));
  writeReportFile(calls, null);
  console.log(`[ok] ${calls.length} appels analysés — expérience terminée.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('[STOP] le harnais s\'est arrêté sur une erreur :');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
