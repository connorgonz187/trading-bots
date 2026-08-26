<#
  setup-laptop.ps1 — recreate the trading-bot scheduling + power settings on a new machine.

  Run this FROM the Trading folder, in an ELEVATED PowerShell (Run as Administrator):
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\setup-laptop.ps1

  It registers up to 7 Windows scheduled tasks — 4 for the ORB bots B and C, the
  keep-awake guardian, and 2 for Bot E once swing\.env has real keys — pointed at THIS machine's
  copy of the bot folders, running as the current user via S4U (no stored password),
  and enables wake-from-sleep on AC power. It also UNREGISTERS the retired tasks.

  2026-07-28 — layout changed:
    * Bot A's ORB (long-only) is RETIRED. Two months of forward testing produced
      -$752 on 83 trades, PF 0.56, 36% win rate. See POSTMORTEM-BOT-A.md.
      Its ORB tasks are removed; the folder is archived at archive/bot-a-orb/.
    * The Coinbase crypto bot is RETIRED. Zero entries in 48 daily decisions and
      the route is no longer being explored. ClaudeTradingBot-Paper is removed;
      the code is archived at archive/crypto-donchian/. The backtesting toolkit
      it shared a folder with survives at backtest/ (stocks only by default).
    * Bot D is deleted. It never traded (placeholder API keys) and its premise came
      from a P&L pairing bug rather than a real result.
    * Bot E (swing/) added. Multi-day holds, so it needs its OWN paper account —
      B and C sweep any position open at the start of a session and would close
      its swings. Its two tasks are skipped unless swing\.env has real keys.

  PREREQS (do these first — see MIGRATION.md):
    1. Node.js LTS installed at C:\Program Files\nodejs\  (winget install OpenJS.NodeJS.LTS)
    2. npm install run inside bot b, bot c and swing
    3. Timezone set to US Eastern (tasks fire at 9:30 AM = market open, in LOCAL time)
#>

$ErrorActionPreference = 'Stop'

# --- locate things ----------------------------------------------------------
$Trading = $PSScriptRoot
$Node    = 'C:\Program Files\nodejs\node.exe'
$User    = "$env:COMPUTERNAME\$env:USERNAME"

if (-not (Test-Path $Node)) { throw "Node not found at $Node. Install Node LTS first." }
foreach ($b in 'bot b','bot c','swing') {
    if (-not (Test-Path (Join-Path $Trading $b))) { throw "Missing folder: $b under $Trading" }
}
Write-Host "Trading dir : $Trading"
Write-Host "Running as  : $User`n"

# --- shared task settings ---------------------------------------------------
# ExecutionTimeLimit matters more than it looks. These tasks default to
# MultipleInstances=IgnoreNew, so a single hung run BLOCKS every later repeat
# until it is killed - and the limit used to be the 72h default, which means one
# stuck cycle could silently take out three days of trading. A cycle does its
# work in seconds; ten minutes is generous and bounds the damage.
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest

function Register-BotTask {
    param([string]$Name, [string]$Cmd, $Trigger)
    $action = New-ScheduledTaskAction -Execute $Cmd -WorkingDirectory (Split-Path $Cmd)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "  registered: $Name"
}

# Same, for tasks that run a script through node directly rather than via a .cmd.
function Register-NodeTask {
    param([string]$Name, [string]$WorkDir, [string]$ScriptArgs, $Trigger, [string]$Description = '')
    $action = New-ScheduledTaskAction -Execute $Node -Argument $ScriptArgs -WorkingDirectory $WorkDir
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
        -Settings $settings -Principal $principal -Description $Description -Force | Out-Null
    Write-Host "  registered: $Name"
}

# Trigger helper: weekday intraday trigger that repeats every 5 min for 6h30m.
function New-IntradayTrigger {
    param([string]$At)
    $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
    $rep = (New-ScheduledTaskTrigger -Once -At $At `
              -RepetitionInterval (New-TimeSpan -Minutes 5) `
              -RepetitionDuration (New-TimeSpan -Hours 6 -Minutes 30)).Repetition
    $t.Repetition = $rep
    return $t
}
function New-WeekdayTrigger { param([string]$At)
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
}

# Bot E manages open positions on a slow cadence and only opens new ones in a
# 15-minute window late in the session, so it does not need the ORB bots' 5-min
# tick. Every 30 min from 9:45 covers reconciliation, the stop ratchet and the
# time stop, and still lands inside the 15:40-15:55 entry window.
function New-SwingTrigger {
    param([string]$At)
    $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
    $rep = (New-ScheduledTaskTrigger -Once -At $At `
              -RepetitionInterval (New-TimeSpan -Minutes 30) `
              -RepetitionDuration (New-TimeSpan -Hours 6 -Minutes 15)).Repetition
    $t.Repetition = $rep
    return $t
}

# --- remove retired tasks ----------------------------------------------------
# Bot A's ORB, every Bot D task, and the Coinbase crypto bot. Safe to run
# repeatedly; ignores absent tasks.
Write-Host "Removing retired tasks..."
foreach ($t in 'ORB-Scan','ORB-Bot','ORB-Scan-D','ORB-Bot-D','ClaudeTradingBot-Paper') {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "  removed: $t"
    }
}

# --- the live tasks ----------------------------------------------------------
Write-Host "`nRegistering tasks..."

# Shared pre-market direction call. ONE task for all accounts: the stance is a
# property of the market, not of an account, so B and C must read the same file
# for their comparison to stay meaningful. Runs before the 9:00 scanners.
Register-BotTask 'ORB-Regime' (Join-Path $Trading 'run-regime.cmd') (New-WeekdayTrigger '8:55am')

# Account B (long+short+trailing)
Register-BotTask 'ORB-Scan-B' (Join-Path $Trading 'bot b\run-scan.cmd')     (New-WeekdayTrigger '9:00am')
Register-BotTask 'ORB-Bot-B'  (Join-Path $Trading 'bot b\run-stockbot.cmd') (New-IntradayTrigger '9:30am')

# Account C (short-only)
Register-BotTask 'ORB-Scan-C' (Join-Path $Trading 'bot c\run-scan.cmd')     (New-WeekdayTrigger '9:00am')
Register-BotTask 'ORB-Bot-C'  (Join-Path $Trading 'bot c\run-stockbot.cmd') (New-IntradayTrigger '9:30am')

# Account E (multi-day swing). Registered ONLY once swing\.env has real keys:
# Bot E holds overnight, so pointing it at B's or C's account would let their
# stranded-position sweep close its swings at the next open. Refusing to
# schedule a keyless Bot E is safer than scheduling one that no-ops all day and
# looks healthy in the task list.
$SwingEnv = Join-Path $Trading 'swing\.env'
$SwingReady = (Test-Path $SwingEnv) -and
              ((Get-Content $SwingEnv | Where-Object { $_ -match '^\s*APCA_API_KEY_ID\s*=\s*\S' }).Count -gt 0)
if ($SwingReady) {
    Register-BotTask 'Swing-Scan-E' (Join-Path $Trading 'swing\run-swing-scan.cmd') (New-WeekdayTrigger '9:00am')
    Register-BotTask 'Swing-Bot-E'  (Join-Path $Trading 'swing\run-swingbot.cmd')   (New-SwingTrigger '9:45am')
} else {
    Write-Host "  SKIPPED: Swing-Scan-E / Swing-Bot-E - swing\.env has no APCA_API_KEY_ID." -ForegroundColor Yellow
    Write-Host "           Bot E needs its OWN paper account (see swing\README.md), then re-run this script."
    foreach ($t in 'Swing-Scan-E','Swing-Bot-E') {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "  removed stale task: $t"
        }
    }
}

# --- EOD flatten backstop ----------------------------------------------------
# stockbot.js flattens at 15:55 from inside its own 5-minute loop, which means
# the flatten only happens if that loop is still alive at 15:55. Over
# 2026-07-29..08-25 it often was not: the machine slept mid-session on 08-03,
# 08-05 and 08-24, the last cycle those days was 14:35, 13:35 and 14:30, and the
# book was left open overnight. The 08-24 carry cost Bot C $189 on a single
# gap (MRNA +19.5% against a short) and Bot B $67.
#
# So the flatten gets its own task, independent of the trading loop. It fires
# twice - once after the bot's own attempt, once as a last chance before the
# close - and is a no-op when the account is already flat, which is the normal
# case. flatten.js refuses to run outside regular hours, so a catch-up run in
# the evening cannot fire market orders into a closed book.
$flattenTriggers = @((New-WeekdayTrigger '3:57pm'), (New-WeekdayTrigger '3:59pm'))
Register-NodeTask 'ORB-Flatten-B' (Join-Path $Trading 'bot b') 'flatten.js' $flattenTriggers `
    'Backstop: cancel resting orders and flatten Bot B before the close, in case the trading loop died mid-session.'
Register-NodeTask 'ORB-Flatten-C' (Join-Path $Trading 'bot c') 'flatten.js' $flattenTriggers `
    'Backstop: cancel resting orders and flatten Bot C before the close, in case the trading loop died mid-session.'

# --- dead-man alerts ---------------------------------------------------------
# A task that never fires produces no log line, no exit code and no alert. Four
# sessions (08-07, 08-13, 08-18, 08-19) passed with zero market-hours activity
# and nothing said a word. watchdog.js looks for the ABSENCE: one check after
# the open, one after the close (which also asks the broker whether B and C are
# actually flat). Silent unless something is wrong.
Register-NodeTask 'Watchdog-Open'  $Trading 'watchdog.js open'  (New-WeekdayTrigger '9:40am') `
    'Alerts if a bot logged no cycle after the open.'
Register-NodeTask 'Watchdog-Close' $Trading 'watchdog.js close' (New-WeekdayTrigger '4:05pm') `
    'Alerts if a bot stopped before the close, or if B/C still hold positions after it.'

# Keep-awake guardian: holds the machine awake for the whole session (8:30am->16:05) so it
# never sleeps mid-session, then releases automatically (sleeps normally outside market hours).
# Relying on each task's WakeToRun alone is flaky and lets the machine nap between the 5-min runs.
#
# Starts at 8:30, NOT 9:00, and the half hour matters. It has to be awake BEFORE
# the first job it is protecting, otherwise it cannot prevent the oversleep that
# delays its own start. On 2026-08-04 it was still on the 9:00 trigger: the
# machine slept through the night, everything (8:55 regime + all three 9:00
# scanners + keep-awake itself) fired together at 09:01:33 on catch-up, the
# scanners hit a network that was not up yet, and both ORB bots ran the whole
# session with no watchlist. 8:30 puts it ahead of the 8:55 regime call.
$kaScript = Join-Path $Trading 'keep-awake.ps1'
$kaAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$kaScript`" -Until 16:05" `
    -WorkingDirectory $Trading
$kaSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName 'KeepAwake-MarketHours' -Action $kaAction `
    -Trigger (New-WeekdayTrigger '8:30am') -Settings $kaSettings -Principal $principal `
    -Description 'Holds the laptop awake during the trading session, then releases so it sleeps normally.' -Force | Out-Null
Write-Host "  registered: KeepAwake-MarketHours"

# --- power: allow wake-from-sleep on AC and battery -------------------------
Write-Host "`nEnabling wake timers (AC + battery)..."
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
# On AC this machine was set to sleep after FIVE minutes idle. keep-awake.ps1
# holds it up from 8:30, but only if it is awake at 8:30 to run - and once it
# releases at 16:05, a five-minute idle timer means the next morning's 8:55
# regime call is already racing a sleeping machine. A desktop that runs a
# trading schedule should not sleep on mains power at all.
powercfg /change standby-timeout-ac 0
powercfg /setactive SCHEME_CURRENT

# Read it back. Setting it is not the same as it sticking: on 2026-08-04 this was
# found Disabled on both AC and DC despite this script having set it, so a
# Windows update or a power-plan switch had silently reverted it. With wake
# timers off, every -WakeToRun above is inert and the whole schedule slides to
# whenever someone happens to open the lid. Fail loudly rather than pretend.
$rtc = (powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE) -join "`n"
$ac  = [regex]::Match($rtc, 'Current AC Power Setting Index:\s*(0x[0-9a-f]+)').Groups[1].Value
$dc  = [regex]::Match($rtc, 'Current DC Power Setting Index:\s*(0x[0-9a-f]+)').Groups[1].Value
if ($ac -eq '0x00000000' -or $dc -eq '0x00000000') {
    Write-Host "  WARNING: wake timers still disabled (AC=$ac DC=$dc) - tasks will NOT wake this machine." -ForegroundColor Red
} else {
    Write-Host "  wake timers enabled (AC=$ac DC=$dc)"
}
# Laptop: do nothing when lid is closed while plugged in (so it can run with lid shut on AC)
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT

# --- OneDrive pin (only if the folders are under OneDrive) -------------------
if ($Trading -like '*OneDrive*') {
    Write-Host "Pinning bot folders always-local (OneDrive)..."
    foreach ($b in 'bot b','bot c','swing') {
        attrib +P -U (Join-Path $Trading "$b\*") /s /d 2>$null
    }
}

Write-Host "`nDone. Verify with:  schtasks /query /tn ORB-Bot-B /v /fo LIST"
Write-Host "REMINDER: disable these tasks on any OTHER PC so they don't double-run"
Write-Host "          against the same paper accounts and state files."
