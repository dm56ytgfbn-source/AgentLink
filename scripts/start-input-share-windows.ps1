param(
 [Parameter(Mandatory=$true)][string]$NodeConfig,
 [string]$Layout,
 [int]$Port=7444,
 [int]$DurationSeconds=0
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$helper=Join-Path $root 'build\AgentLinkInput.exe'
if (-not (Test-Path $helper)) {
 & node (Join-Path $PSScriptRoot 'build-input-share.mjs') $helper
 if ($LASTEXITCODE -ne 0) { throw 'Native helper build failed' }
}
$shareArgs=@((Join-Path $root 'dist\apps\input-share\main.js'),'host','--node-config',$NodeConfig,'--helper',$helper,'--port',"$Port",'--enable')
if ($Layout) { $shareArgs+=@('--layout',$Layout) }
if ($DurationSeconds -gt 0) { $shareArgs+=@('--duration-seconds',"$DurationSeconds") }
Write-Host 'Input sharing: Mac is on the right by default. Ctrl+Alt+Escape stops sharing.'
& node @shareArgs
exit $LASTEXITCODE
