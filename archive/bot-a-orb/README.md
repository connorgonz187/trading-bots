# archive/bot-a-orb — retired 2026-07-28

Bot A, the **long-only Opening-Range Breakout** on Alpaca paper account
`PA3845CWKSIX`. Ran 2026-06-05 → 2026-07-27 (29 sessions, 83 positions) and
finished at **−$752.19**.

**The analysis is in [`../../POSTMORTEM-BOT-A.md`](../../POSTMORTEM-BOT-A.md).**
Read that first — this folder is just the evidence behind it.

## What's here

| File | |
|---|---|
| `stock-trades.csv` | Full trade log, 177 rows. Pair entries to exits **within a symbol-day**, never FIFO across days. |
| `stockbot.log`, `scan.log` | Complete run logs (6,776 and 263 lines) |
| `watchlist.csv` | Every name the scanner selected, with its selection metrics |
| `stock-state.json` | Final daily state |
| `stockbot.js`, `scan.js`, `flatten.js` | Code as it ran on the last day |
| `run-*.cmd` | The Task Scheduler launchers (tasks now unregistered) |
| `ORIGINAL-README.md` | The project README as it stood when Bot A hosted both the stock and crypto bots |

## Caveats if you re-analyse this

- **The trade log is not authoritative.** Reconstruct from Alpaca
  `/v2/account/activities/FILL` and reconcile against account equity. The CSV
  has 9 symbol-days where the logged exit quantity doesn't match the entry —
  mostly flatten failures — so any naive pairing will drift.
- **This code predates the 2026-07-28 fixes.** It has the original flatten
  behaviour (defers a failed close to the next run, no alert), no short-refusal
  caching, and no network retry. Don't copy it forward — take `bot b/` or
  `bot c/` instead.
- The account is still open and flat. It was unscheduled, not closed.
