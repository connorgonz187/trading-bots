/**
 * Trade notifications via Telegram Bot API.
 *
 * Replaces the old email-to-SMS carrier gateway (Verizon @vtext.com), which
 * silently rate-limited / bounced bursts of trade alerts and is being sunset.
 * Telegram has no carrier throttling, delivers in real time, and its API
 * response actually confirms delivery (unlike SMTP, which only confirmed the
 * relay handoff — so the old "Text sent" log was misleading).
 *
 * One-time setup:
 *   1. In Telegram, message @BotFather -> /newbot -> copy the bot token.
 *   2. Send your new bot any message (e.g. "hi") so it has a chat with you.
 *   3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates and copy
 *      result[].message.chat.id  (a number; negative for groups).
 *   4. Put both in .env:
 *        TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
 *        TELEGRAM_CHAT_ID=987654321
 *
 * If the token/chat aren't set, sendSms() is a no-op — the bot runs fine
 * without it. Name kept as sendSms()/smsConfigured() so call sites don't change.
 */

import { basename } from "path";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000; // notifications must never hang the trading loop

// Label shown at the front of every message so you can tell the bots apart.
// Set BOT_NAME in .env (e.g. "Bot A"); falls back to the run folder's name.
function botName() {
  return process.env.BOT_NAME || basename(process.cwd()) || "bot";
}

export function smsConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// POST sendMessage once. Returns the parsed body, or throws on network/timeout.
async function postOnce(token, chatId, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Send a Telegram message. Never throws — a notification failure must not break
// trading. Every trade is sent in real time (no batching). If Telegram pushes
// back with 429 Too Many Requests, we WAIT the requested time and resend once
// rather than dropping the alert, so you still see every trade.
export async function sendSms(message) {
  if (!smsConfigured()) {
    console.log("   (Telegram not configured — skipping alert)");
    return false;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const text = `[${botName()}] ${message}`;

  try {
    let { status, body } = await postOnce(token, chatId, text);

    // Respect Telegram backpressure: wait the advised cooldown, then resend.
    if (status === 429) {
      const retryAfter = Number(body?.parameters?.retry_after) || 1;
      console.log(`   Telegram 429 — waiting ${retryAfter}s and resending…`);
      await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
      ({ status, body } = await postOnce(token, chatId, text));
    }

    if (body?.ok) {
      console.log("   Telegram alert delivered");
      return true;
    }
    console.log(
      `   Telegram send failed: ${status} ${body?.description || "unknown error"}`,
    );
    return false;
  } catch (err) {
    console.log(`   Telegram send failed: ${err.name === "AbortError" ? "timeout" : err.message}`);
    return false;
  }
}
