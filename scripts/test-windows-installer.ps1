$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $root 'build\releases'
$installers = @(Get-ChildItem -Path $releaseRoot -Filter 'AgentLink-Setup-*-windows-x64.exe' -Recurse -File)
if ($installers.Count -ne 1) { throw "Expected exactly one installer; found $($installers.Count)" }
$installer = $installers[0].FullName
$target = Join-Path $env:RUNNER_TEMP "AgentLink-Install-Smoke-$env:GITHUB_RUN_ID"
if (Test-Path $target) { throw "Test install path already exists; preserved: $target" }

function Install-Preview {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$target")
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer returned $($process.ExitCode)" }
}

Install-Preview
$app = Join-Path $target 'AgentLink.exe'
$node = Join-Path $target 'runtime\node\node.exe'
$cli = Join-Path $target 'runtime\dist\apps\runtime\cli.js'
foreach ($file in @($app, $node, $cli)) {
    if (-not (Test-Path $file -PathType Leaf)) { throw "Missing installed file: $file" }
}
$selftest = Start-Process -FilePath $app -ArgumentList '--selftest' -Wait -PassThru
if ($selftest.ExitCode -ne 0) { throw "Installed app self-test failed: $($selftest.ExitCode)" }
& $node $cli help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Bundled Node runtime failed' }

# An upgrade must leave the private pairing area intact. This is a harmless CI-only marker.
$private = Join-Path $env:USERPROFILE '.agentlink-node'
New-Item -ItemType Directory -Path $private -Force | Out-Null
$marker = Join-Path $private "installer-smoke-$env:GITHUB_RUN_ID.txt"
if (Test-Path $marker) { throw "Private marker already exists; preserved: $marker" }
Set-Content -Path $marker -Value 'preserve-pairing-area' -NoNewline
Install-Preview
if ((Get-Content $marker -Raw) -ne 'preserve-pairing-area') { throw 'Upgrade changed private pairing area' }
$selftest = Start-Process -FilePath $app -ArgumentList '--selftest' -Wait -PassThru
if ($selftest.ExitCode -ne 0) { throw "Upgraded app self-test failed: $($selftest.ExitCode)" }
Write-Output 'INSTALLER_SMOKE_OK: install, bundled runtime, upgrade and private data preservation'
