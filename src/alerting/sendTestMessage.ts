import 'dotenv/config';
import { sendTelegram } from './telegram.js';

/**
 * `npm run notify:test` — proves the Telegram bot works end to end (token + chat id),
 * without waiting for a real alert condition. Sends one fixed message and reports
 * whether Telegram accepted it. Exits non-zero on failure so it's CI/script-friendly.
 */
async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const ok = await sendTelegram(
    `✅ crypto-buddy — test d'alerte\n` +
      `Si tu vois ce message, le bot Telegram fonctionne de bout en bout (token + chat_id).\n` +
      `🕑 ${timestamp}`,
  );
  if (ok) {
    console.log('Test message sent — check Telegram.');
    process.exit(0);
  }
  console.error('Test message NOT sent — see the warning above (token / chat_id set in .env?).');
  process.exit(1);
}

main().catch((err: unknown) => {
  // sendTelegram never throws, so reaching here is unexpected — surface it loudly.
  console.error('notify:test failed unexpectedly:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
