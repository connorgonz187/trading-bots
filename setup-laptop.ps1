<#
  setup-laptop.ps1 — recreate the trading-bot scheduling + power settings on a new machine.

  Run this FROM the Trading folder, in an ELEVATED PowerShell (Run as Administrator):
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\setup-laptop.ps1

  It registers the 6 Windows scheduled tasks (paper trading) pointed at THIS machine's
  copy of the bot folders, running as the current user via S4U (no stored password),
  and enables wake-from-sleep on AC power. It also UNREGISTERS the retired tasks.

  2026-07-28 — layout changed:
    * Bot A's ORB (long-only) is RETIRED. Two months of forward testing produced
      -$752 on 83 trades, PF 0.56, 36% win rate. See POSTMORTEM-BOT-A.md.
      Its ORB tasks are removed; the folder is archived at archive/bot-a-orb/.
    * The Coinbase crypto bot has moved out of "bot a" into its own crypto/ folder.
      ClaudeTradingBot-Paper now points there.
    * Bot D is deleted. It never traded (placeholder API keys) and its premise came
      from a P&L pairing bug rather than a real result.

  PREREQS (do these first — see MIGRATION.md):
    1. Node.js LTS installed at C:\Program Files\nodejs\  (winget install OpenJS.NodeJS.LTS)
    2. npm install run inside bot b, bot c, crypto
    3. Timezone set to US Eastern (tasks fire at 9:30 AM = market open, in LOCAL time)
#>

$ErrorActionPreference = 'Stop'

# --- locate things ----------------------------------------------------------
$Trading = $PSScriptRoot
$Node    = 'C:\Program Files\nodejs\node.exe'
$User    = "$env:COMPUTERNAME\$env:USERNAME"

if (-not (Test-Path $Node)) { throw "Node not found at $Node. Install Node LTS first." }
foreach ($b in 'bot b','bot c','crypto') {
    if (-not (Test-Path (Join-Path $Trading $b))) { throw "Missing folder: $b under $Trading" }
}
Write-Host "Trading dir : $Trading"
Write-Host "Running as  : $User`n"

# --- shared task settings ---------------------------------------------------
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest

function Register-BotTask {
    param([string]$Name, [string]$Cmd, $Trigger)
    $action = New-ScheduledTaskAction -Execute $Cmd -WorkingDirectory (Split-Path $Cmd)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
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

# --- remove retired tasks ----------------------------------------------------
# Bot A's ORB and every Bot D task. Safe to run repeatedly; ignores absent tasks.
Write-Host "Removing retired tasks..."
foreach ($t in 'ORB-Scan','ORB-Bot','ORB-Scan-D','ORB-Bot-D') {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "  removed: $t"
    }
}

# --- the 6 live tasks --------------------------------------------------------
Write-Host "`nRegistering tasks..."

# Crypto (Coinbase donchian) — every day at noon. Lives in crypto/ since 2026-07-28.
Register-BotTask 'ClaudeTradingBot-Paper' (Join-Path $Trading 'crypto\run-bot.cmd') `
    (New-ScheduledTaskTrigger -Daily -At 12:00pm)

# Account B (long+short+trailing)
Register-BotTask 'ORB-Scan-B' (Join-Path $Trading 'bot b\run-scan.cmd')     (New-WeekdayTrigger '9:00am')
Register-BotTask 'ORB-Bot-B'  (Join-Path $Trading 'bot b\run-stockbot.cmd') (New-IntradayTrigger '9:30am')

# Account C (short-only)
Register-BotTask 'ORB-Scan-C' (Join-Path $Trading 'bot c\run-scan.cmd')     (New-WeekdayTrigger '9:00am')
Register-BotTask 'ORB-Bot-C'  (Join-Path $Trading 'bot c\run-stockbot.cmd') (New-IntradayTrigger '9:30am')

# Keep-awake guardian: holds the laptop awake for the whole session (9:00am->16:05) so it
# never sleeps mid-session, then releases automatically (sleeps normally outside market hours).
# Relying on each task's WakeToRun alone is flaky and lets the laptop nap between the 5-min runs.
$kaScript = Join-Path $Trading 'keep-awake.ps1'
$kaAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$kaScript`" -Until 16:05" `
    -WorkingDirectory $Trading
$kaSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName 'KeepAwake-MarketHours' -Action $kaAction `
    -Trigger (New-WeekdayTrigger '9:00am') -Settings $kaSettings -Principal $principal `
    -Description 'Holds the laptop awake during the trading session, then releases so it sleeps normally.' -Force | Out-Null
Write-Host "  registered: KeepAwake-MarketHours"

# --- power: allow wake-from-sleep on AC and battery -------------------------
Write-Host "`nEnabling wake timers (AC + battery)..."
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /setactive SCHEME_CURRENT
# Laptop: do nothing when lid is closed while plugged in (so it can run with lid shut on AC)
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT

# --- OneDrive pin (only if the folders are under OneDrive) -------------------
if ($Trading -like '*OneDrive*') {
    Write-Host "Pinning bot folders always-local (OneDrive)..."
    foreach ($b in 'bot b','bot c','crypto') {
        attrib +P -U (Join-Path $Trading "$b\*") /s /d 2>$null
    }
}

Write-Host "`nDone. Verify with:  schtasks /query /tn ORB-Bot-B /v /fo LIST"
Write-Host "REMINDER: disable these 6 tasks on any OTHER PC so they don't double-run"
Write-Host "          against the same paper accounts and state files."
