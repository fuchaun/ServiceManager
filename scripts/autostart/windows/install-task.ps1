$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Resolve-Path (Join-Path $scriptDir "..\..\..")
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
  throw "node not found in PATH"
}

$taskName = "ServiceManager"
$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$argument = "-NoProfile -WindowStyle Hidden -Command `"`$env:CD = '$repoDir'; Set-Location '$repoDir'; & '$($nodeCmd.Source)' 'server.js'`""

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

Write-Host "Installed: $taskName"
Write-Host "If you want startup without login, change the trigger to At startup in Task Scheduler."
