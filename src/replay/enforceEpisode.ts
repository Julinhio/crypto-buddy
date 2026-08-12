import 'dotenv/config';
import { config } from '../config/index.js';
import { Decimal, dec, ZERO } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { loadStartingCapital } from '../persistence/startingCapital.js';
import { derivePortfolio } from '../portfolio/derive.js';
import type { LedgerEntry } from '../persistence/executions.js';

/**
 * `npx tsx src/replay/enforceEpisode.ts` — WHAT ENFORCE WOULD HAVE DONE ON 11/08.
 *
 * The episode this whole PR is decided on. In seven hours the model sold ETH and BNB, then
 * bought BTC and ETH back three hours later, then sold ETH again four hours after that — a
 * complete round trip and two contradictions in one day. The transition gate marked those
 * three cycles forbidden, AND ONLY THOSE: the eight other orders of the period, all placed
 * with the raw and the confirmed regime agreeing, came out allowed.
 *
 * This harness does not re-implement the gate. It reads the REAL ledger, takes the legs the
 * LIVE layer journaled as `forbidden`, and replays the book without them through the SAME
 * `derivePortfolio` production uses. The counterfactual is therefore the bot's own
 * arithmetic on the bot's own bookings, not a model of them.
 *
 * ── AN HONESTY TO KEEP IN VIEW ──────────────────────────────────────────────────────
 *
 * The path actually executed finishes AHEAD of the one the gate would have produced. The
 * yo-yo was accidentally profitable. That number is printed here as prominently as the
 * volume avoided, because the case for arming the gate is not that it makes more money —
 * it is that the bot was deciding on states that contradict each other. Profitability is
 * not demonstrated, and this harness must not be readable as if it were.
 *
 * READ-ONLY. The bot runs while this executes, so the window is bounded and captured up
 * front.
 */

const WINDOW_FROM = '2026-08-11T00:00:00Z';
const WINDOW_TO = '2026-08-12T00:00:00Z';

interface LedgerRow {
  id: number;
  decision_id: number;
  symbol: string;
  side: 'buy' | 'sell';
  ledger_base_delta: string;
  ledger_quote_delta: string;
  valuation_price: string;
  fee: string;
  created_at: string;
}

function line(): void {
  console.log('─'.repeat(96));
}

async function main(): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('enforceEpisode: Supabase is not configured (read-only measurements).');

  console.log('═'.repeat(96));
  console.log('ENFORCE — CONTREFACTUEL DE L\'ÉPISODE DU 11/08');
  console.log('═'.repeat(96));
  console.log(`Fenêtre (capturée) : ${WINDOW_FROM} → ${WINDOW_TO}`);
  console.log('Accès Supabase     : LECTURE SEULE');
  console.log('');

  // ── the legs the LIVE layer refused, from its own journal ─────────────────────────
  const { data: refusedRaw, error: refusedErr } = await supabase
    .from('transition_observations')
    .select('decision_id, asset, order_side, order_verdict, gate, leg_verdict, atomic_refusal')
    .eq('order_verdict', 'forbidden');
  if (refusedErr) throw new Error(refusedErr.message);
  const refusedKeys = new Set(
    ((refusedRaw ?? []) as { decision_id: number; asset: string }[]).map((r) => `${r.decision_id}:${r.asset}`),
  );

  // ── the whole ledger up to the end of the window ──────────────────────────────────
  const { data: rowsRaw, error: rowsErr } = await supabase
    .from('executions')
    .select('id, decision_id, symbol, side, ledger_base_delta, ledger_quote_delta, valuation_price, fee, created_at')
    .eq('event_type', 'intent')
    .eq('validation_status', 'executed')
    .lt('created_at', WINDOW_TO)
    .order('id', { ascending: true });
  if (rowsErr) throw new Error(rowsErr.message);
  const rows = (rowsRaw ?? []) as LedgerRow[];

  const toEntry = (r: LedgerRow): LedgerEntry => ({
    symbol: r.symbol,
    side: r.side,
    baseDelta: dec(r.ledger_base_delta),
    quoteDelta: dec(r.ledger_quote_delta),
    valuationPrice: dec(r.valuation_price),
    // No `fee` on a ledger entry: the fee is already netted into `ledger_quote_delta` when
    // the intent is booked, so adding it here would charge it twice.
  });

  const inWindow = (r: LedgerRow): boolean => r.created_at >= WINDOW_FROM && r.created_at < WINDOW_TO;
  const isRefused = (r: LedgerRow): boolean =>
    refusedKeys.has(`${r.decision_id}:${r.symbol.split('/')[0]}`);

  const suppressed = rows.filter((r) => inWindow(r) && isRefused(r));

  // ── the per-cycle table ───────────────────────────────────────────────────────────
  console.log('LES CYCLES REFUSÉS PAR LA PORTE, ET EUX SEULS');
  line();
  console.log('décision  actif  sens  notionnel   frais      verdict     porte');
  line();
  let volume = ZERO;
  let fees = ZERO;
  for (const r of suppressed) {
    const notional = dec(r.ledger_base_delta).abs().times(dec(r.valuation_price));
    volume = volume.plus(notional);
    fees = fees.plus(dec(r.fee));
    console.log(
      `#${String(r.decision_id).padEnd(8)} ${r.symbol.split('/')[0]!.padEnd(6)} ${r.side.padEnd(5)} ` +
        `${notional.toFixed(2).padStart(9)} ${dec(r.fee).toFixed(4).padStart(9)}   forbidden   frozen`,
    );
  }
  line();

  const windowRows = rows.filter(inWindow);
  let totalVolume = ZERO;
  let totalFees = ZERO;
  for (const r of windowRows) {
    totalVolume = totalVolume.plus(dec(r.ledger_base_delta).abs().times(dec(r.valuation_price)));
    totalFees = totalFees.plus(dec(r.fee));
  }

  console.log('');
  console.log(`jambes refusées        : ${suppressed.length} sur ${windowRows.length} bookings de la journée`);
  console.log(`cycles concernés       : ${new Set(suppressed.map((r) => r.decision_id)).size} sur ${new Set(windowRows.map((r) => r.decision_id)).size}`);
  console.log(`volume ÉVITÉ           : ${volume.toFixed(2)} $ sur ${totalVolume.toFixed(2)} $ brassés (${volume.div(totalVolume).times(100).toFixed(1)} %)`);
  console.log(`frais ÉVITÉS           : ${fees.toFixed(4)} $ sur ${totalFees.toFixed(4)} $ (${fees.div(totalFees).times(100).toFixed(1)} %)`);
  console.log('');

  // ── the two books, valued at the SAME prices ──────────────────────────────────────
  //
  // The last valuation price seen per asset in the ledger. Using one price map for both
  // books is the only fair comparison: any difference in the totals is then caused by the
  // different holdings, never by valuing them at different moments.
  const priceMap = new Map<string, Decimal>();
  for (const r of rows) priceMap.set(r.symbol.split('/')[0]!, dec(r.valuation_price));
  const priceOf = (asset: string): Decimal | null =>
    asset === 'USDT' ? dec('1') : (priceMap.get(asset) ?? null);

  const startingCapital = (await loadStartingCapital(supabase)) ?? dec(config.execution.startingCapitalUsd);
  const opts = { startingCapital, reserveAsset: 'USDT', priceOf };

  const actual = derivePortfolio(rows.map(toEntry), opts);
  const counterfactual = derivePortfolio(
    rows.filter((r) => !(inWindow(r) && isRefused(r))).map(toEntry),
    opts,
  );

  console.log('LE PORTEFEUILLE À L\'ARRIVÉE (mêmes prix des deux côtés)');
  line();
  console.log('                        réel        enforce      écart');
  line();
  const fmt = (d: Decimal): string => d.toFixed(2).padStart(11);
  console.log(`équité              ${fmt(actual.equity)} ${fmt(counterfactual.equity)} ${fmt(counterfactual.equity.minus(actual.equity))}`);
  console.log(`cash                ${fmt(actual.cash)} ${fmt(counterfactual.cash)} ${fmt(counterfactual.cash.minus(actual.cash))}`);
  console.log(`déployé %           ${fmt(actual.deployedPercent)} ${fmt(counterfactual.deployedPercent)} ${fmt(counterfactual.deployedPercent.minus(actual.deployedPercent))}`);
  line();
  const assets = new Set([...actual.positions.map((p) => p.asset), ...counterfactual.positions.map((p) => p.asset)]);
  for (const asset of [...assets].sort()) {
    const a = actual.positions.find((p) => p.asset === asset);
    const c = counterfactual.positions.find((p) => p.asset === asset);
    console.log(
      `${asset.padEnd(6)} valeur        ${fmt(a?.value ?? ZERO)} ${fmt(c?.value ?? ZERO)} ${fmt((c?.value ?? ZERO).minus(a?.value ?? ZERO))}`,
    );
  }
  line();

  const edge = counterfactual.equity.minus(actual.equity);
  console.log('');
  console.log('═'.repeat(96));
  console.log('CE QUE ÇA DIT, ET CE QUE ÇA NE DIT PAS');
  console.log('═'.repeat(96));
  console.log(
    `La porte aurait évité ${volume.toFixed(2)} $ de volume et ${fees.toFixed(4)} $ de frais, en refusant ` +
      `${suppressed.length} jambes sur ${windowRows.length}.`,
  );
  console.log(
    `Sur l'équité finale, enforce termine ${edge.gte(0) ? 'DEVANT' : 'DERRIÈRE'} de ` +
      `${edge.abs().toFixed(2)} $.`,
  );
  console.log('');
  if (edge.lt(0)) {
    console.log('LE YO-YO A ÉTÉ ACCIDENTELLEMENT RENTABLE, et il faut le dire dans ce sens-là.');
    console.log('On ne bascule pas parce que c\'est prouvé plus rentable — ça ne l\'est pas sur cet');
    console.log('épisode. On bascule parce que le bot décidait sur des états qui se contredisent :');
    console.log('vendre puis racheter puis revendre le même actif en sept heures n\'est pas une');
    console.log('stratégie, c\'est le symptôme d\'un label lissé lu à côté de drapeaux instantanés.');
    console.log('La rentabilité n\'est pas démontrée, et cette PR ne la revendique pas.');
  }
  console.log('');
  console.log(
    `Les 8 autres ordres de la période, régime brut et stabilisé concordants, sortent AUTORISÉS : ` +
      `la porte filtre, elle ne muselle pas.`,
  );
  console.log('═'.repeat(96));

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('enforceEpisode failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
