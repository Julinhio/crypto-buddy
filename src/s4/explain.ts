import Anthropic from '@anthropic-ai/sdk';
import { fallbackExplanation, type S4Notification } from '../alerting/s4Activity.js';

/**
 * THE MODEL'S ONLY ROLE SINCE 06/11/2026: one or two sentences, in French, explaining an S4
 * movement that has ALREADY been decided by the code, booked and sent.
 *
 *   - called from `beat.ts`, after the cycle and outside its timeout — no order waits for it;
 *   - called only when something moved (`prepareS4Notification` returns null otherwise);
 *   - given the facts the code computed, and nothing else to work from;
 *   - any failure (no key, timeout, refusal, empty text) falls back to `fallbackExplanation`,
 *     the code's own sentence. The notification always leaves.
 *
 * The model is pinned here rather than read from ANTHROPIC_MODEL: that variable chose the old
 * DECISION model, and on Railway's Cron Schedule a variable change needs a manual redeploy.
 */

export const S4_EXPLAINER_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 15_000;
const MAX_TOKENS = 300;

const SYSTEM = [
  'Tu expliques à un particulier, en français, un mouvement de portefeuille DÉJÀ exécuté par une règle déterministe nommée S4.',
  'S4 : cible 100 % investie aux poids BTC 32,5 %, ETH 32,5 %, BNB 20 %, XRP 15 % ; un actif sort entièrement quand sa clôture journalière tombe à 20 % ou plus sous son plus-haut depuis l\'entrée, sa part reste alors en cash ; il est racheté après au moins 10 jours hors marché, quand sa clôture repasse au-dessus de sa moyenne 50 jours après être passée dessous ; entre deux décisions, une ligne qui dérive de plus de 2 % est ramenée à sa cible.',
  'Règles : une ou deux phrases, pas plus. Utilise uniquement les faits fournis, n\'invente aucun chiffre, aucune prévision, aucun conseil. Pas de titre, pas de liste, pas d\'emoji.',
].join('\n');

export interface ExplainResult {
  text: string;
  source: 'model' | 'fallback';
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

export async function explainS4(
  n: S4Notification,
  deps: { client?: Pick<Anthropic, 'messages'> | null } = {},
): Promise<ExplainResult> {
  const fallback = (error: string): ExplainResult => ({
    text: fallbackExplanation(n), source: 'fallback', model: null, inputTokens: null, outputTokens: null, error,
  });
  if (n.movements.length === 0) return fallback('aucun mouvement');
  let client = deps.client ?? null;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return fallback('ANTHROPIC_API_KEY absente');
    client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  }
  const facts = {
    premier_cycle_du_pilote: n.firstCycle,
    mouvements: n.movements.map((m) => ({
      actif: m.asset,
      sens: m.side === 'buy' ? 'achat' : 'vente',
      montant_usd: Math.round(m.usd * 100) / 100,
      cause: m.reason,
      etat_s4: m.status === 'in' ? 'en marché' : 'hors marché',
      cloture_journaliere: m.close,
      moyenne_50j: m.sma50,
      plus_haut_depuis_entree: m.high,
      seuil_de_sortie: m.exitThreshold,
      date_entree: m.entryDate,
      date_sortie: m.exitDate,
      jours_hors_marche: m.daysOut,
      cible_pourcent: m.targetPercent,
    })),
  };
  try {
    const message = await client.messages.create(
      {
        model: S4_EXPLAINER_MODEL,
        max_tokens: MAX_TOKENS,
        // A one-shot description: no reasoning needed. Disabled thinking is accepted on Haiku
        // 5.5 at its default effort.
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Faits du mouvement (JSON) :\n${JSON.stringify(facts)}` }],
      },
      { timeout: TIMEOUT_MS },
    );
    if (message.stop_reason === 'refusal') return fallback('refus du modèle');
    const text = message.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') return fallback('réponse vide');
    return {
      text: text.length > 600 ? `${text.slice(0, 600)}…` : text,
      source: 'model',
      model: message.model ?? S4_EXPLAINER_MODEL,
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
      error: null,
    };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}
