/**
 * Coinbase Advanced Trade — execution module (ES256 JWT auth).
 *
 * Read-only paths (accounts / balances) are fully wired and safe to test with
 * real keys via:  node bot.js --check-auth
 *
 * Order placement is BUILT but STUBBED: placeOrder() constructs the exact
 * request Coinbase expects, but unless COINBASE_LIVE_CONFIRM === "I_UNDERSTAND"
 * it refuses to send and instead returns the prepared request for inspection.
 * This is deliberate — the live order path has NOT been verified against a real
 * Coinbase account. Verify on a small sub-account before enabling.
 *
 * Auth reference: Coinbase CDP keys sign each request with a short-lived ES256
 * JWT. Header carries the key id; payload's `uri` binds the JWT to one
 * METHOD + host + path so it can't be replayed against a different endpoint.
 */

import crypto from "crypto";
import { readFileSync } from "fs";

const HOST = "api.coinbase.com";

// Load { name, privateKey } straight from the JSON file Coinbase has you
// download (cdp_api_key.json), so the secret never has to be pasted into .env.
export function loadCoinbaseCredsFromFile(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  const apiKeyName = j.name || j.id;
  const privateKey = j.privateKey || j.private_key;
  if (!apiKeyName || !privateKey) {
    throw new Error(`Coinbase key file ${path} is missing name/privateKey`);
  }
  return { apiKeyName, privateKey };
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Build a short-lived ES256 JWT bound to one request (method + path).
export function buildJwt(method, path, apiKeyName, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: apiKeyName,
    typ: "JWT",
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const payload = {
    sub: apiKeyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `${method} ${HOST}${path}`,
  };
  const signingInput =
    base64url(JSON.stringify(header)) +
    "." +
    base64url(JSON.stringify(payload));

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  // dsaEncoding "ieee-p1363" yields the raw r||s signature JOSE/ES256 requires
  // (Node defaults to DER, which Coinbase would reject).
  const signature = crypto.sign("SHA256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return signingInput + "." + base64url(signature);
}

export function makeCoinbaseClient({ apiKeyName, privateKey } = {}) {
  if (!apiKeyName || !privateKey) {
    throw new Error(
      "Coinbase client needs COINBASE_API_KEY_NAME and COINBASE_PRIVATE_KEY in .env",
    );
  }
  // .env stores the multi-line EC key as one line with literal \n — restore it.
  const pem = privateKey.includes("\\n")
    ? privateKey.replace(/\\n/g, "\n")
    : privateKey;

  async function request(method, path, body) {
    const jwt = buildJwt(method, path, apiKeyName, pem);
    const res = await fetch(`https://${HOST}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`Coinbase ${method} ${path} → ${res.status}: ${text}`);
    }
    return json;
  }

  // ── Read-only — safe to test with real keys ──────────────────────────────
  async function getAccounts() {
    return request("GET", "/api/v3/brokerage/accounts");
  }

  // ── Order placement — BUILT but STUBBED ──────────────────────────────────
  // When a stop-loss AND take-profit are supplied we submit a BRACKET order
  // (trigger_bracket_gtc): the protective stop/target live server-side at
  // Coinbase, so the stop is enforced even if the bot or PC is offline. Brackets
  // are sized in base currency (asset qty), so we always use base_size here.
  // Without SL/TP we fall back to a plain market order (BUY → quote_size USD,
  // SELL → base_size qty).
  //
  // The bracket field semantics are per Coinbase's API docs but have NOT been
  // verified against a live fill. Test on a funded sub-account before trusting
  // it with real money.
  function buildOrderRequest(symbol, side, sizeUSD, price, stopLoss, takeProfit) {
    const baseSize = (sizeUSD / price).toFixed(8);
    let config;
    if (stopLoss && takeProfit) {
      config = {
        trigger_bracket_gtc: {
          base_size: baseSize,
          limit_price: takeProfit.toFixed(2), // take-profit target
          stop_trigger_price: stopLoss.toFixed(2), // stop-loss trigger
        },
      };
    } else if (side.toLowerCase() === "buy") {
      config = { market_market_ioc: { quote_size: sizeUSD.toFixed(2) } };
    } else {
      config = { market_market_ioc: { base_size: baseSize } };
    }
    return {
      method: "POST",
      path: "/api/v3/brokerage/orders",
      body: {
        client_order_id: crypto.randomUUID(),
        product_id: symbol,
        side: side.toUpperCase(),
        order_configuration: config,
      },
    };
  }

  async function placeOrder(symbol, side, sizeUSD, price, stopLoss, takeProfit) {
    const prepared = buildOrderRequest(
      symbol,
      side,
      sizeUSD,
      price,
      stopLoss,
      takeProfit,
    );
    if (process.env.COINBASE_LIVE_CONFIRM !== "I_UNDERSTAND") {
      return {
        stubbed: true,
        message:
          "Coinbase live order NOT sent (stubbed). After verifying on a sub-account, set COINBASE_LIVE_CONFIRM=I_UNDERSTAND to enable real orders.",
        prepared,
      };
    }
    return request(prepared.method, prepared.path, prepared.body);
  }

  return { getAccounts, buildOrderRequest, placeOrder };
}
