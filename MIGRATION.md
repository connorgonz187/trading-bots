# Migrating the trading bots to a new machine

Everything here is **paper trading**. The bot files are portable; the Windows
scheduled tasks and power settings are machine-specific and must be recreated.

## What's in this folder
- `bot b/` — Alpaca ORB, **long+short+trailing** (account PA3ZJ1EX28BW)
- `bot c/` — Alpaca ORB, **short-only** (account PA3ZMXLQJZXX)
- `crypto/` — Coinbase donchian bot + the backtesting toolkit
- `archive/bot-a-orb/` — retired Bot A (long-only ORB); no tasks, nothing to migrate
- `cdp_api_key.json` — Coinbase API key (top level, NOT inside a bot folder)
- `alpacarecovery.txt` — Alpaca recovery UUID (a credential — keep it)
- Each bot folder has its own `.env` (API keys + per-account flags) — **hidden file, make sure it copied over**

> **Layout changed 2026-07-28.** The crypto bot moved out of `bot a/` into
> `crypto/`; Bot A's ORB was retired (see `POSTMORTEM-BOT-A.md`) and Bot D was
> deleted. If you are migrating from a machine that predates this, re-run
> `setup-laptop.ps1` — it unregisters the old `ORB-Scan` / `ORB-Bot` /
> `ORB-*-D` tasks as part of setup.

## Setup on the new machine

1. **Install Node.js LTS** to the default path (the `run-*.cmd` launchers hardcode
   `C:\Program Files\nodejs\node.exe`):
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Open a fresh terminal afterward.

2. **Set the timezone to US Eastern.** Scheduled tasks fire in *local* time and
   9:30 AM must equal market open. (Settings → Time & language → Date & time.)

3. **Reinstall dependencies** (don't trust a copied `node_modules`):
   ```powershell
   cd "<Trading>\bot b"; npm install
   cd "..\bot c"; npm install
   cd "..\crypto"; npm install
   ```

4. **Smoke-test before scheduling:**
   ```powershell
   cd "<Trading>\crypto"
   & "C:\Program Files\nodejs\node.exe" bot.js --check-auth   # Coinbase, expect 200
   & "C:\Program Files\nodejs\node.exe" bot.js --test-sms     # should send a Telegram alert
   cd "..\bot b"
   & "C:\Program Files\nodejs\node.exe" scan.js               # writes watchlist.csv
   ```
   (Coinbase has an IP allowlist. Same home network = same public IP = no change.
   New network → allowlist the new egress IP in the Coinbase developer portal.)

5. **Register the 6 scheduled tasks + power settings.** In an **elevated**
   PowerShell, from this folder:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\setup-laptop.ps1
   ```
   This creates: `ClaudeTradingBot-Paper` (crypto, daily noon), and for each of
   B/C an `ORB-Scan-*` (weekdays 9:00) + `ORB-Bot-*` (weekdays 9:30, repeat every
   5 min for 6h30m), plus `KeepAwake-MarketHours`. All run as the current user
   via S4U (logged on or off), with wake-from-sleep on AC enabled. It also
   unregisters the retired `ORB-Scan` / `ORB-Bot` (Bot A) and `ORB-*-D` tasks.

6. **Laptop power:** keep it on AC. Wake-from-sleep timers only work on AC, and a
   *powered-off* machine never runs. The script sets "do nothing on lid close
   (plugged in)" so it can run with the lid shut — verify in
   Settings → Power, or `powercfg /q`.

7. **⚠️ On the OLD PC, disable every task** so both machines don't run the same
   bots against the same paper accounts / state files:
   ```powershell
   foreach ($t in 'ClaudeTradingBot-Paper','ORB-Scan-B','ORB-Bot-B','ORB-Scan-C','ORB-Bot-C','KeepAwake-MarketHours',
                  'ORB-Scan','ORB-Bot','ORB-Scan-D','ORB-Bot-D') {   # last four are retired
       schtasks /change /tn $t /disable 2>$null
   }
   ```

## Verify
```powershell
schtasks /query /tn ORB-Bot-B /v /fo LIST      # check trigger + repetition
Get-ScheduledTask | Where TaskName -like '*ORB*' | ft TaskName,State
```
Then watch `bot b\stockbot.log` on the next weekday open.

## Notes / gotchas
- Live order paths are **latched off** (paper only). Live crypto also needs the
  portfolio funded — it isn't.
- Free Alpaca data is ~15 min delayed.
- If `Trading` is under OneDrive, the script pins the bot folders always-local.
- `bot b` and `bot c` share code (`alpaca.js`, `scan.js`, `stockbot.js`,
  `strategy.js`, `notify.js`, `flatten.js`) — only the two `.env` files differ.
  Keep the shared files byte-identical or the B-vs-C comparison is meaningless.
- Only ONE machine should be scheduled at a time. As of 2026-07-28 the tasks
  were not registered on the desktop — check `Get-ScheduledTask` on each PC
  before assuming where the bots are actually running.
