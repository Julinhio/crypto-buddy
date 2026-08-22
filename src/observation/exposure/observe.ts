import 'dotenv/config';
import { REGIME_VERSION } from '../../market/regime.js';
import { buildExperimentConfig, experimentConfigSha256 } from '../../calibration/exposure/config.js';
import {
  canonicalJson,
  currentDepsLockSha,
  currentGitCommit,
  currentSourceTreeSha,
  gitIsDirty,
  sha256Of,
  writeArtefact,
  type WrittenFile,
} from '../../provenance/artefacts.js';
import { getSupabaseClient } from '../../persistence/supabase.js';
import { controllerUniverse } from './context.js';
import { readWindow } from './read.js';
import { buildSnapshot, SCHEMA_VERSION, type SnapshotSummary } from './snapshot.js';
import { parseOutDir, parseWindow, USAGE, WindowError, type ObservationWindow } from './window.js';

/**
 * PASSIVE OBSERVATION OF THE EXPOSURE — the offline reader.
 *
 * Reads the live journal, in READ-ONLY, over an explicit half-open window, and writes three
 * canonical artefacts: the cycles, the summary, and the manifest that certifies both.
 *
 * IT CHANGES NOTHING. No migration, no table, no scheduler, no prompt, no allocation, no
 * order, no LLM call, not one write. Nothing in production imports this directory — a test
 * greps the whole tree to keep that true — so the bot cannot read what this produces, and
 * this cannot reach the bot.
 *
 * NO WALL CLOCK REACHES THE ARTEFACTS. Durations and the run's own timestamp go to stdout;
 * the files carry the cutoff and nothing else time-shaped, which is what lets two runs on the
 * same cutoff be compared byte for byte instead of "looking the same".
 */

export interface ObservationManifestInput {
  window: ObservationWindow;
  universe: readonly string[];
  summary: SnapshotSummary;
  outputs: WrittenFile[];
}

/**
 * The certificate. Records what produced the artefacts and hashes every one of them.
 *
 * It does NOT hash itself — same discipline as the calibration harness: a file containing its
 * own digest is either lying or impossible to produce. It carries no band either, and that is
 * structural rather than careful: this module never imports `arms.ts`, so there is nothing
 * band-shaped to record.
 */
export function buildObservationManifest(input: ObservationManifestInput): unknown {
  const outputs = [...input.outputs].sort((a, b) => (a.file < b.file ? -1 : 1));
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'exposure-observation',
    window: { from: input.window.from, to_exclusive: input.window.toExclusive },
    crypto_buddy_commit: currentGitCommit(),
    crypto_buddy_tree_dirty: gitIsDirty(),
    crypto_buddy_src_tree_sha: currentSourceTreeSha(),
    crypto_buddy_deps_lock_sha: currentDepsLockSha(),
    regime_version: REGIME_VERSION,
    /**
     * The controller configuration the context was read under — the same digest the
     * calibration harness stamps, so a reader can tell whether a live context and a calibrated
     * one were produced under the same caps, the same universe and the same rules.
     */
    controller_config_sha256: experimentConfigSha256(buildExperimentConfig()),
    universe: {
      controller: [...input.universe],
      reserves: input.summary.universe.reserves,
      journal_only: input.summary.universe.journal_only,
    },
    population: input.summary.population,
    checks: input.summary.checks.map((c) => ({ name: c.name, ok: c.ok })),
    /** THE FINGERPRINT: one digest over the digests, so a run is one string to compare. */
    snapshot_sha256: sha256Of(canonicalJson(Object.fromEntries(outputs.map((o) => [o.file, o.sha256])))),
    outputs,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let window: ObservationWindow;
  let outDir: string;
  try {
    window = parseWindow(argv, Date.now());
    outDir = parseOutDir(argv);
  } catch (err) {
    if (err instanceof WindowError) {
      console.error(`[observe] ${err.message}`);
      console.error(`[observe] ${USAGE}`);
      return 2;
    }
    throw err;
  }

  const universe = controllerUniverse();
  console.log(`[observe] window   [${window.from}, ${window.toExclusive})`);
  console.log(`[observe] universe ${universe.join(', ')}`);

  const startedAt = Date.now();
  const raw = await readWindow(getSupabaseClient(), window);
  const readMs = Date.now() - startedAt;
  console.log(
    `[observe] read     ${raw.decisions.length} decision(s), ${raw.observations.length} transition ` +
      `verdict(s), ${raw.executions.length} execution row(s) in ${readMs} ms`,
  );

  if (raw.decisions.length === 0) {
    console.error('[observe] the window holds no cycle — nothing to snapshot. Widen it, or check the cutoff.');
    return 1;
  }

  const snapshot = buildSnapshot(raw, window, universe);
  const outputs = [
    writeArtefact(outDir, 'cycles.json', snapshot.cycles),
    writeArtefact(outDir, 'summary.json', snapshot.summary),
  ];
  const manifest = buildObservationManifest({ window, universe, summary: snapshot.summary, outputs });
  const manifestFile = writeArtefact(outDir, 'manifest.json', manifest);

  const p = snapshot.summary.population;
  console.log(
    `[observe] cycles   ${p.cycles} (${Object.entries(p.by_status)
      .map(([status, count]) => `${status}=${count}`)
      .join(', ')})`,
  );
  console.log(
    `[observe] bars     ${p.bars} 4h bar(s), ${p.bars_with_multiple_cycles} with more than one wake-up ` +
      `(cycles per bar: ${Object.entries(p.cycles_per_bar)
        .map(([n, count]) => `${n}x${count}`)
        .join(' ')})`,
  );
  console.log(
    `[observe] model    ${p.cycles_with_target} cycle(s) with a target, ${p.cycles_without_target} without ` +
      '(kept in the population)',
  );
  console.log(
    `[observe] stops    ${snapshot.summary.stops.armed_verdicts} armed verdict(s), ` +
      `${snapshot.summary.stops.would_fire_verdicts} fired, ${snapshot.summary.stops.episodes.length} episode(s)`,
  );
  console.log(
    `[observe] moves    ${p.movements_booked} booked, ${p.movements_rejected_or_failed} not booked`,
  );

  console.log('[observe] checks:');
  let failed = 0;
  for (const check of snapshot.summary.checks) {
    if (!check.ok) failed += 1;
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name} — ${check.detail}`);
  }

  console.log('[observe] artefacts:');
  for (const file of [...outputs, manifestFile]) {
    console.log(`  ${file.file}  ${file.sha256}  ${file.bytes} bytes`);
  }
  const fingerprint = (manifest as { snapshot_sha256: string }).snapshot_sha256;
  console.log(`[observe] fingerprint ${fingerprint}`);
  console.log(`[observe] total ${Date.now() - startedAt} ms`);

  if (failed > 0) {
    console.error(
      `[observe] ${failed} integrity check(s) FAILED — the artefacts were written so the failure can be ` +
        'inspected, but nothing in them may be quoted until it is understood.',
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('[observe] the observation failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
