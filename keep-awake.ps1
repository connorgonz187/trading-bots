<#
  keep-awake.ps1 — hold the laptop awake during the trading session, then let it sleep.

  Uses the Win32 SetThreadExecutionState API to tell Windows "the system is in use"
  for as long as this process lives. Unlike toggling the global power scheme, this
  reverts the instant the process exits (or is killed), so the laptop sleeps normally
  outside market hours. Works on both AC and battery.

  Registered as the KeepAwake-MarketHours scheduled task (weekdays 9:00am), but you can
  also run it by hand:
      .\keep-awake.ps1                 # hold awake until 16:05 local today
      .\keep-awake.ps1 -Until 13:00    # hold awake until 1:00pm
      .\keep-awake.ps1 -Minutes 90     # hold awake for the next 90 minutes
#>
param(
    [string]$Until   = '16:05',   # local clock time to hold awake until (market close + buffer)
    [int]   $Minutes = 0          # if > 0, hold for N minutes from now instead of -Until
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'keep-awake.log'
function Log($m) { "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $m" | Add-Content -Path $log -Encoding utf8 }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Power {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

# ES_CONTINUOUS keeps the request in effect until reset; ES_SYSTEM_REQUIRED blocks sleep.
# (Display is allowed to turn off — we only care about the machine staying powered.)
$ES_CONTINUOUS      = [uint32]0x80000000L
$ES_SYSTEM_REQUIRED = [uint32]0x00000001L
$KEEP_AWAKE = [uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

# Work out when to release.
if ($Minutes -gt 0) {
    $end = (Get-Date).AddMinutes($Minutes)
} else {
    $t   = [datetime]::ParseExact($Until, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $end = (Get-Date).Date.Add($t.TimeOfDay)
}
if ((Get-Date) -ge $end) { Log "Target $end already passed; nothing to do."; return }

Log "ON  (pid $PID) holding awake until $($end.ToString('yyyy-MM-dd HH:mm'))"
try {
    while ((Get-Date) -lt $end) {
        # Re-assert every minute — cheap, and survives any odd state resets.
        [void][Power]::SetThreadExecutionState($KEEP_AWAKE)
        Start-Sleep -Seconds 60
    }
} finally {
    [void][Power]::SetThreadExecutionState($ES_CONTINUOUS)   # drop the lock; sleep allowed again
    Log "OFF (released)"
}
