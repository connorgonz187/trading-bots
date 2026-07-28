# Tradex — local trading dashboard

A single laptop dashboard for the paper-trading bots. **Read-only** — it only
ever issues `GET` requests to Alpaca and reads files on disk. It cannot place,
cancel, or modify an order.

Bots B and C are the two it tracks. Bot A, Bot D and the Coinbase crypto bot are
retired and deliberately absent — this is a live monitor, and a retired
strategy's frozen account is noise. Their history lives under `archive/`.

## What it shows

A header roll-up (combined equity across the Alpaca paper accounts with a
30-day equity curve, day P&L, total open positions, market clock) and one card
per bot:

- **Health pill** — LIVE / STALE TICK / MARKET CLOSED / API DOWN, from log
  freshness + the market clock.
- **Equity / Day P&L / Cash** — live from each bot's own Alpaca paper account.
- **Equity curve** — 30-day daily equity sparkline from Alpaca's
  `portfolio/history` (real history, not just since the dashboard started).
- **Performance** — realized P&L, win rate, and 30-day P&L. Realized P&L and win
  rate are computed by pairing ENTRY→EXIT round-trips in `stock-trades.csv`
  (respects the `Side` column when present; falls back to each bot's configured
  side for legacy rows — C=short). Shown alongside **Net (broker)**, which is
  equity minus starting capital and cannot drift; when the two disagree, the
  broker figure is the true one.
- **Open positions** — live, with unrealized P&L per position.
- **Today's trades** — entries/exits parsed from `stock-trades.csv`.
- **Watchlist** — the latest pre-market scan from `watchlist.csv`.

Top-right **Fullscreen** button toggles a borderless full-screen view.

## Run it

```powershell
cd "<Trading>\dashboard"
& "C:\Program Files\nodejs\node.exe" server.js
```

Then open <http://localhost:4000>. Or just double-click **`run-dashboard.cmd`**,
which starts the server and opens the browser for you.

The page auto-refreshes every 10 s. Use a different port with
`PORT=4100 node server.js`.

## How it gets data

- **Live (Alpaca paper API):** for each bot it reads that bot's own
  `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` from its `.env` and calls
  `/v2/account`, `/v2/positions`, `/v2/orders`, `/v2/clock`. Each account is
  independent, so one set of bad keys only greys out that one card.
- **Local files:** `stock-trades.csv`, `watchlist.csv`, and the `*.log` mtimes
  for the health pill.

No dependencies — pure Node (needs Node 18+ for global `fetch`; you have v24).

## Always-on display (kiosk)

Double-click **`run-dashboard-kiosk.cmd`** to start the server and open the
dashboard in a dedicated, borderless **fullscreen** Brave window (no tabs or
address bar) — ideal for leaving on a spare monitor. Alt+F4 closes the window.
Edit the `brave.exe` path on the last line if you prefer a different browser.

## Launch on login (already set up)

A shortcut **`TradingDashboard.lnk`** has been placed in your Startup folder:

```
%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\TradingDashboard.lnk
```

On login it runs `run-dashboard.cmd` (server window minimized) and opens the
dashboard in your browser.

- **To use the kiosk fullscreen window on login instead:** edit the shortcut's
  *Target* to point at `run-dashboard-kiosk.cmd`.
- **To disable auto-launch:** delete that `.lnk`, or turn it off under
  Settings → Apps → Startup.

