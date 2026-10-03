param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$Project,
  [Parameter(Mandatory=$true)][string]$Config,
  [string]$TaskName = 'AgentLink-User-Supervisor'
)
$ErrorActionPreference = 'Stop'
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$Project = (Resolve-Path -LiteralPath $Project).Path
$Config = (Resolve-Path -LiteralPath $Config).Path
$Supervisor = Join-Path $Project 'dist\apps\node\supervisor.js'
if (!(Test-Path -LiteralPath $Supervisor -PathType Leaf)) { throw 'Build AgentLink before installing startup.' }
if ($NodeExe.Contains('"') -or $Supervisor.Contains('"') -or $Config.Contains('"')) { throw 'Invalid path.' }
$Arguments = '"' + $Supervisor + '" "' + $Config + '"'
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
  if ($Existing.Actions.Execute -ne $NodeExe -or $Existing.Actions.Arguments -ne $Arguments) {
    throw 'An existing startup task has different settings. It was preserved; choose a different TaskName or review it first.'
  }
  Write-Output 'Matching startup task already exists.'
} else {
  $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $Action = New-ScheduledTaskAction -Execute $NodeExe -Argument $Arguments -WorkingDirectory $Project
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'AgentLink supervisor in the signed-in user session. Does not unlock the desktop or change network rules.' | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'denied|拒绝|0x80070005') { throw }
    $Startup = [Environment]::GetFolderPath('Startup')
    $Link = Join-Path $Startup ($TaskName + '.lnk')
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($Link)
    if ((Test-Path -LiteralPath $Link) -and ($Shortcut.TargetPath -ne $NodeExe -or $Shortcut.Arguments -ne $Arguments)) { throw 'Existing startup shortcut differs; it was preserved.' }
    $Shortcut.TargetPath=$NodeExe
    $Shortcut.Arguments=$Arguments
    $Shortcut.WorkingDirectory=$Project
    $Shortcut.WindowStyle=7
    $Shortcut.Description='AgentLink user-session supervisor'
    $Shortcut.Save()
    Start-Process -FilePath $NodeExe -ArgumentList $Arguments -WorkingDirectory $Project -WindowStyle Hidden
    Write-Output ('StartupFolder installed: '+$Link)
    return
  }
}
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
