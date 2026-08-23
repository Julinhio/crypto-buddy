import type { Analysis, Gate2Result } from './analyze.js';
import type { ReconstructedCycle } from './reconstruct.js';
import type { CallRecord, PlannedCall } from './records.js';
import type { MandateId, MandatePrompt, VariantProof } from './variants.js';

/**
 * The COMMITTED report — aggregates, fingerprints and verdicts only.
 *
 * What deliberately never lands here (brief §9): the model's prose (reasoning,
 * theses, notifications), the per-asset allocations, any payload. Those live in
 * `out/mandate-experiment/` (gitignored). The requested TOTAL exposure per call is
 * the experiment's measurand and appears; the book's composition does not.
 */

const fmt = (n: number | null | undefined, digits = 2): string =>
  n == null || Number.isNaN(n) ? '—' : n.toFixed(digits);

const confLine = (c: Record<string, number>): string =>
  ['low', 'medium', 'high'].map((k) => `${k} ${c[k] ?? 0}`).join(' / ');

export function buildReport(params: {
  generatedAt: string;
  requestedModel: string;
  mandates: Record<MandateId, MandatePrompt>;
  proofs: VariantProof[];
  cycles: ReconstructedCycle[];
  gate2: Gate2Result[];
  plan: PlannedCall[];
  calls: CallRecord[];
  analysis: Analysis | null;
  aborted: string | null;
}): string {
  const { mandates, proofs, cycles, gate2, plan, calls, analysis, aborted } = params;
  const lines: string[] = [];
  const push = (...l: string[]): void => {
    lines.push(...l);
  };

  push(
    '# Expérience — le cadrage du mandat v5 influence-t-il l\'exposition totale demandée ?',
    '',
    `Généré le ${params.generatedAt} par \`npm run experiment:mandate\`. Rapport entièrement`,
    'produit par le harnais à partir des artefacts de run — aucune valeur saisie à la main.',
    '',
    '## Question et cadre',
    '',
    'Quatre mandats sur quatre contextes de production rejoués à l\'identique (contexte,',
    'livre, mémoire et plomberie strictement identiques), cinq répétitions par cellule :',
    '',
    '- **C** — contrôle : le prompt v5 de production, byte-identique ;',
    '- **P** — placebo : instruction saillante sur la confiance, sans contenu d\'exposition ;',
    '- **F** — clarification du plancher de cash (limite de sécurité, pas une cible) ;',
    '- **O** — propriété explicite de l\'exposition totale au niveau portefeuille.',
    '',
    'Réponse PRIMAIRE uniquement (pas de relance du garde). Les erreurs de transport sont',
    'rejouées et comptées à part. Lecture préenregistrée dans `src/experiment/mandate/analyze.ts`.',
    `Modèle demandé pour chaque appel : \`${params.requestedModel}\`.`,
    '',
    '## Les quatre mandats — empreintes et preuve de la contrainte dure',
    '',
    '| Mandat | SHA-256 du system prompt | Ajout |',
    '|---|---|---|',
  );
  for (const id of ['C', 'P', 'F', 'O'] as const) {
    const m = mandates[id];
    const what =
      m.insertion == null
        ? 'aucun (prompt de production)'
        : `${m.insertion.lines.filter((l) => l !== '').length} ligne(s) insérée(s) après « ${m.insertion.anchorLine.trim().slice(0, 60)}… »`;
    push(`| ${id} | \`${m.sha256}\` | ${what} |`);
  }
  push('', '**Preuve** : retirer les lignes insérées de chaque variante restitue le contrôle byte-identique.', '');
  for (const p of proofs) {
    push(`- ${p.id} : ${p.ok ? 'OK' : 'ÉCHEC'} — ${p.detail}`);
  }

  push('', '## Porte 1 — reconstruction des quatre contextes', '');
  for (const c of cycles) {
    const failed = c.gate1.checks.filter((x) => !x.ok);
    push(
      `### Décision ${c.spec.decisionId} — ${c.spec.role}`,
      '',
      `- verdict : **${c.gate1.ok ? 'OK' : 'ARRÊT'}** (${c.gate1.checks.length} contrôles, ${failed.length} échec(s))`,
      `- mémoire : décision significative ${c.lastSignificant?.id ?? 'aucune'} ; référence du garde : ${c.guardReferenceId ?? 'aucune'}`,
      `- empreintes : contexte stocké \`${c.fingerprints.storedContextSha256.slice(0, 16)}…\`, mémoire \`${(c.fingerprints.memorySha256 ?? '—').slice(0, 16)}…\`, user prompt \`${c.fingerprints.userPromptSha256.slice(0, 16)}…\``,
      '',
    );
    for (const check of c.gate1.checks) {
      push(`- ${check.ok ? '✓' : '✗'} \`${check.name}\` — ${check.detail}`);
    }
    push('');
  }
  push(
    '**Limite connue, arbitrée par la porte 2** : `market_context` est une colonne `jsonb`,',
    'qui ne préserve pas l\'ordre des clés. Le user prompt reconstruit contient exactement',
    'les clés et valeurs que la production a envoyées, dans l\'ordre (déterministe) de la',
    'colonne plutôt que dans l\'ordre de sérialisation d\'origine, qu\'aucun store n\'a retenu.',
    'Si cet ordre comptait pour le modèle, C ne reproduirait pas l\'historique — c\'est',
    'exactement ce que la porte 2 mesure.',
    '',
    '## Porte 2 — validité du contrôle',
    '',
    '| Contexte | Rôle | Historique | Médiane C | MAD | Étendue | Seuil local | Écart | Verdict |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const g of gate2) {
    push(
      `| ${g.contextId} | ${g.role} | ${g.historical} | ${fmt(g.medianC)} | ${fmt(g.madC)} | ${fmt(g.rangeC)} | ${fmt(g.threshold)} | ${fmt(g.gap)} | ${g.ok ? 'OK' : 'ARRÊT'} |`,
    );
  }

  if (aborted != null) {
    push('', `## ARRÊT DE L'EXPÉRIENCE`, '', aborted, '');
    return lines.join('\n');
  }

  push(
    '',
    '## Ordre d\'entrelacement (déterministe, publié avant exécution)',
    '',
    'Phase de validité : C sur les quatre contextes, entrelacé par contexte (5 tours).',
    'Phase variantes : par tour et par contexte, rotation en carré latin de P/F/O — jamais',
    'un bloc complet par variante. Les extensions éventuelles (contrôle négatif) suivent.',
    '',
    '```',
  );
  const orderLine = plan.map((p) => `${p.orderIndex}:${p.mandate}@${p.contextId}r${p.rep}`);
  for (let i = 0; i < orderLine.length; i += 8) {
    push(orderLine.slice(i, i + 8).join('  '));
  }
  push(
    '```',
    '',
    '## Journal des appels',
    '',
    'Exposition = exposition totale DEMANDÉE (100 − cash demandé), la grandeur mesurée.',
    'Le détail par actif et la prose du modèle restent dans les artefacts locaux ignorés par Git.',
    '',
    '| # | Mandat | Contexte | Rép. | Horodatage (UTC) | Issue | Expo. demandée | Action | Confiance | Modèle retourné | Rejeux transport |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of [...calls].sort((a, b) => a.orderIndex - b.orderIndex)) {
    push(
      `| ${c.orderIndex} | ${c.mandate} | ${c.contextId} | ${c.rep} | ${c.startedAt} | ${c.outcome} | ${fmt(c.requestedExposure, 1)} | ${c.actionType ?? '—'} | ${c.confidence ?? '—'} | ${c.returnedModel} | ${c.transportReplays.length} |`,
    );
  }

  if (analysis != null) {
    push(
      '',
      '## Cellules — agrégats',
      '',
      '| Mandat | Contexte | Appels | Acceptées | Invalides | Garde refusé | Contrat de sortie | Rejeux transport | Médiane expo. | MAD | Étendue | Confiance (l/m/h) | Ouvertures ligne à zéro |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const cell of analysis.cells) {
      push(
        `| ${cell.mandate} | ${cell.contextId} | ${cell.calls}${cell.extended ? ' (étendue)' : ''} | ${cell.accepted} | ${cell.invalid} | ${cell.guardRefused} | ${cell.orderViolations} | ${cell.transportReplays} | ${fmt(cell.median)} | ${fmt(cell.mad)} | ${fmt(cell.range)} | ${confLine(cell.confidence)} | ${cell.zeroLineOpenings} |`,
      );
    }

    push(
      '',
      '## Lecture préenregistrée',
      '',
      '### Porte placebo',
      '',
    );
    for (const [ctx, moved] of Object.entries(analysis.placeboMovedExposure)) {
      push(
        `- contexte ${ctx} : P déplace l'exposition d'au moins le seuil : **${moved ? 'OUI — F et O non interprétables causalement sur ce contexte' : 'non'}** ; ` +
          `P déplace la confiance : ${analysis.placeboMovedConfidence[Number(ctx)] ? 'oui' : 'non'}`,
      );
    }
    push(
      '',
      `Placebo inerte (ne déplace ni l'exposition ni la confiance nulle part) : **${analysis.placeboInert ? 'OUI — la porte placebo n\'a rien testé, le placebo est raté' : 'non'}**`,
      '',
      '### Contextes favorables (1297, 1433, 1368)',
      '',
      '| Mandat | Contexte | Effet (pts) | Seuil | ≥ seuil | Reproduit par P | Majorité au-dessus | Validité | **Effet retenu** |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const e of analysis.effects) {
      push(
        `| ${e.mandate} | ${e.contextId} | ${fmt(e.effectSize)} | ${fmt(e.threshold)} | ${e.clearsThreshold ? 'oui' : 'non'} | ${e.reproducedByPlacebo ? 'oui' : 'non'} | ${e.majorityAbove ? 'oui' : 'non'} | ${e.validityHolds ? 'oui' : 'non'} | **${e.isEffect ? 'OUI' : 'non'}** |`,
      );
    }
    push(
      '',
      '### Contrôle négatif (1494)',
      '',
      '| Mandat | Dégradation médiane (pts) | Seuil | Éliminé (médiane) | Ouvertures ligne à zéro | Éliminé (ouvertures) |',
      '|---|---|---|---|---|---|',
    );
    for (const n of analysis.negativeControl) {
      push(
        `| ${n.mandate} | ${fmt(n.degradation)} | ${fmt(n.threshold)} | ${n.eliminatedOnMedian ? 'OUI' : 'non'} | ${n.zeroLineOpenings}/${n.acceptedResponses} | ${n.eliminatedOnZeroLines ? 'OUI' : 'non'} |`,
      );
    }
    push(
      '',
      '### Cycles morts',
      '',
      `Réponses primaires invalides ou refusées, total sur les quatre contextes — contrôle : ${
        analysis.cells.filter((c) => c.mandate === 'C').reduce((n, c) => n + c.invalid + c.guardRefused + c.orderViolations, 0)
      }.`,
      '',
    );
    for (const d of analysis.deadCycles) {
      push(`- ${d.mandate} : ${d.failedPrimaries} — ${d.eliminated ? '**ÉLIMINÉ** (davantage de cycles morts que le contrôle)' : 'acceptable'}`);
    }
    push(
      '',
      '### Distribution de `confidence` par mandat (toutes cellules)',
      '',
    );
    for (const [mandate, dist] of Object.entries(analysis.confidenceByMandate)) {
      push(`- ${mandate} : ${confLine(dist)}`);
    }

    // Mechanical synthesis — flags only, no interpretation beyond the preregistered rules.
    push('', '## Synthèse (mécanique, depuis les règles préenregistrées)', '');
    for (const mandate of ['F', 'O'] as const) {
      const dead = analysis.deadCycles.find((d) => d.mandate === mandate)!;
      const neg = analysis.negativeControl.find((n) => n.mandate === mandate)!;
      const wins = analysis.effects.filter((e) => e.mandate === mandate && e.isEffect);
      const blocked = analysis.effects.filter(
        (e) => e.mandate === mandate && e.clearsThreshold && e.reproducedByPlacebo,
      );
      // AN INERT PLACEBO QUALIFIES EVERY CAUSAL SENTENCE BELOW, in both directions.
      // P not shown to be read means the experiment cannot distinguish "read but
      // ineffective" from "ignored" for ANY of the additions — so a null result stays
      // a measured fact about the emitted exposure, but stops short of "this framing
      // is not the cause"; and a retained effect would lose its salience control,
      // since an unread placebo rules nothing out.
      const inertCaveat = analysis.placeboInert
        ? ' Réserve (placebo inerte) : P n\'ayant été montré ni sur l\'exposition ni sur la' +
          ' confiance, l\'expérience ne distingue pas « lu mais sans effet » de « ignoré » —' +
          ' la conclusion se limite au fait mesuré : cet ajout, tel que formulé, ne déplace' +
          ' pas l\'exposition demandée sur ces contextes.'
        : '';
      if (dead.eliminated) {
        push(`- **${mandate} : éliminé** — augmente les réponses primaires invalides ou refusées.`);
      } else if (neg.eliminatedOnMedian || neg.eliminatedOnZeroLines) {
        push(`- **${mandate} : éliminé** — dégrade le contrôle négatif 1494.`);
      } else if (wins.length > 0) {
        push(
          `- **${mandate} : effet retenu** sur ${wins.map((w) => w.contextId).join(', ')} ` +
            `(${wins.map((w) => `+${fmt(w.effectSize)} pts`).join(', ')}), non reproduit par le placebo.` +
            (analysis.placeboInert
              ? ' Réserve : le placebo étant inerte, la condition « non reproduit par P » est' +
                ' satisfaite trivialement et ne contrôle pas l\'effet générique d\'une instruction' +
                ' saillante — l\'effet est mesuré, sa lecture causale reste à confirmer.'
              : ''),
        );
      } else if (blocked.length > 0) {
        push(
          `- **${mandate} : non interprétable** — le déplacement observé est reproduit par le placebo ` +
            `(contextes ${blocked.map((b) => b.contextId).join(', ')}) : une instruction saillante quelconque déplace l'exposition.`,
        );
      } else {
        push(
          `- **${mandate} : aucun déplacement au sens préenregistré** — médiane égale au contrôle` +
            ' sur les trois contextes favorables, au seuil local près. Une absence d\'effet est un' +
            ' résultat valide.' +
            inertCaveat,
        );
      }
    }
  }

  push(
    '',
    '## Hors périmètre, rappel',
    '',
    'Aucune modification du prompt actif, aucune écriture en base, aucun ordre. Ce résultat',
    'mesure un levier comportemental ; il ne dit rien du rendement, et même un résultat',
    'positif ne déclenche aucune modification de production.',
    '',
  );
  return lines.join('\n');
}
