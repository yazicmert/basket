# End-to-end check of the in-place updater on Windows, with the freshly built package in
# dist\. Runs under Windows PowerShell 5.1, which is what users have. No network is used:
# the "download" is the local ZIP and the "running app" is a sleeping process. Verifies that
# the ZIP unpacks with the system tar.exe, that the staged package is checked, that the swap
# replaces only the app's own entries, that the swapped copy starts, and that a bad request
# changes nothing.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root 'dist'
$Node = Join-Path $Dist 'ArtifactAtlas\runtime\node.exe'
$Version = (Get-Content (Join-Path $Dist 'ArtifactAtlas\app\package.json') -Raw | ConvertFrom-Json).version
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('Atlas Update ' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)), version under test $Version"

try {
  Write-Host '==> [Update 1/5] Installing a copy to replace, with a file of the user beside it'
  $Install = Join-Path $Work 'Programs\ArtifactAtlas'
  New-Item -ItemType Directory -Force -Path (Split-Path $Install) | Out-Null
  Copy-Item -LiteralPath (Join-Path $Dist 'ArtifactAtlas') -Destination $Install -Recurse
  Set-Content -LiteralPath (Join-Path $Install 'app\OLD_COPY_MARKER') -Value 'old'
  Set-Content -LiteralPath (Join-Path $Install 'my-notes.txt') -Value 'not part of the app'
  $Staging = Join-Path $Work 'staging'
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null
  Copy-Item -LiteralPath (Join-Path $Dist 'ArtifactAtlas-Windows.zip') -Destination $Staging

  $Fake = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 300' -PassThru -WindowStyle Hidden

  Write-Host '==> [Update 2/5] Unpacking with tar.exe, checking name and version, starting the helper'
  $Runner = Join-Path $Work 'run-update.mjs'
  $Src = ([System.Uri](Join-Path $Dist 'ArtifactAtlas\app\src\platform\self-update-windows.js')).AbsoluteUri
  @"
import { stageVerifiedWindowsPackage, launchWindowsSwap } from '$Src';
const [zip, staging, install, pid, version] = process.argv.slice(2);
let refused = false;
try { stageVerifiedWindowsPackage({ zipPath: zip, stagingDir: staging, expectedVersion: '99.0.0' }); }
catch (err) { refused = /UPDATE_VERSION_MISMATCH/.test(err.message); }
if (!refused) { console.error('a wrong version was not refused'); process.exit(1); }
const staged = stageVerifiedWindowsPackage({ zipPath: zip, stagingDir: staging, expectedVersion: version });
console.log('staged', staged);
launchWindowsSwap({ installDir: install, stagedDir: staged, appPid: Number(pid), stagingDir: staging, relaunch: false });
"@ | Set-Content -LiteralPath $Runner -Encoding UTF8
  & $Node $Runner (Join-Path $Staging 'ArtifactAtlas-Windows.zip') $Staging $Install $Fake.Id $Version
  if ($LASTEXITCODE -ne 0) { throw "staging failed ($LASTEXITCODE)" }

  Write-Host '==> [Update 3/5] Waiting for the helper'
  $Log = Join-Path $Staging 'update.log'
  for ($i = 0; $i -lt 600; $i++) {
    if ((Test-Path $Log) -and (Select-String -Path $Log -Pattern 'update finished' -Quiet)) { break }
    Start-Sleep -Milliseconds 100
  }
  if (Test-Path $Log) { Get-Content $Log } else { Write-Host 'no update.log was written' }
  $Output = Join-Path $Staging 'helper-output.txt'
  if (Test-Path $Output) { Write-Host '--- helper output ---'; Get-Content $Output }
  if (-not (Test-Path $Log)) {
    Write-Host '--- running the helper in the foreground to show why ---'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Staging 'swap.ps1') -InstallDir $Install -StagedDir (Join-Path $Staging 'unpacked\ArtifactAtlas') -AppPid $Fake.Id -Staging $Staging -Relaunch 0 -RunningDir $Install
    Write-Host "foreground exit code $LASTEXITCODE"
    if (Test-Path $Log) { Get-Content $Log }
  }
  if (-not (Test-Path $Log) -or -not (Select-String -Path $Log -Pattern 'update finished with status 0' -Quiet)) { throw 'the helper did not finish with status 0' }
  if (Get-Process -Id $Fake.Id -ErrorAction SilentlyContinue) { throw 'the running app was not stopped' }
  if (Test-Path (Join-Path $Install 'app\OLD_COPY_MARKER')) { throw 'the old copy is still installed' }
  if (-not (Test-Path (Join-Path $Install 'my-notes.txt'))) { throw 'a file that is not part of the app was removed' }
  if (Test-Path (Join-Path $Staging 'previous')) { throw 'the previous copy was not cleaned up' }

  Write-Host '==> [Update 4/5] Starting the swapped copy (smoke test)'
  $Smoke = Start-Process -FilePath (Join-Path $Install 'ArtifactAtlas.exe') -ArgumentList '--smoke-test' -Wait -PassThru
  if ($Smoke.ExitCode -ne 0) { throw "the swapped copy did not start (exit code $($Smoke.ExitCode))" }

  Write-Host '==> [Update 5/5] A staged path outside the staging folder must change nothing'
  Set-Content -LiteralPath (Join-Path $Install 'app\NEW_COPY_MARKER') -Value 'new'
  $Script = Join-Path $Staging 'swap.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script -InstallDir $Install -StagedDir (Join-Path $Work 'Elsewhere\ArtifactAtlas') -AppPid 999999 -Staging $Staging -Relaunch 0
  if ($LASTEXITCODE -ne 2) { throw "an unexpected staged path was accepted (exit code $LASTEXITCODE)" }
  if (-not (Test-Path (Join-Path $Install 'app\NEW_COPY_MARKER'))) { throw 'a refused request changed the install' }

  Write-Host 'WINDOWS_IN_PLACE_UPDATE_VERIFIED: OK'
}
finally {
  if ($Fake) { Stop-Process -Id $Fake.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
