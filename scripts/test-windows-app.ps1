param(
  [string]$Out = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Out) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Out = Join-Path $root "build\AgentLinkTray-$stamp.exe"
}
Write-Host "Building the AgentLink tray app (this never overwrites an existing build)..."
$SelfTest = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($Out), [System.IO.Path]::GetFileNameWithoutExtension($Out) + '-selftest.exe')
node (Join-Path $PSScriptRoot 'build-windows-app.mjs') $SelfTest --console
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

Write-Host "Running the no-UI self test (it must read real state through the shared runtime)..."
& $SelfTest --selftest
if ($LASTEXITCODE -ne 0) { throw 'Tray app self test failed' }

node (Join-Path $PSScriptRoot 'build-windows-app.mjs') $Out
if ($LASTEXITCODE -ne 0) { throw 'Native app build failed' }

Write-Host ""
Write-Host "OK. Launch it with:  & '$Out'"
Write-Host "It opens one window and stays in the notification area when closed."
