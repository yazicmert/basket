# Starts the built app the way a user does (no test switch) and checks the whole life cycle:
# the launcher starts the backend, opens the app window with its own browser profile, and
# when that window is closed the launcher and the backend both quit. Also checks that the
# Windows-only readers work on this machine's real Start Menu and Store folders, and that
# the file-dialog and update scripts are valid Windows PowerShell.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root 'dist\ArtifactAtlas'
$Exe = Join-Path $App 'ArtifactAtlas.exe'
$Node = Join-Path $App 'runtime\node.exe'
$DataDir = Join-Path $env:LOCALAPPDATA 'ArtifactAtlas'
$UrlFile = Join-Path $DataDir 'window-url.txt'
$WindowProfile = Join-Path $DataDir 'window'

Write-Host '==> [Launch 1/4] PowerShell scripts the app writes parse under Windows PowerShell'
$Check = Join-Path ([System.IO.Path]::GetTempPath()) ('atlas-scripts-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Check | Out-Null
$Src = ([System.Uri](Join-Path $Root 'src\platform')).AbsoluteUri
@"
import fs from 'node:fs';
import { windowsPickerScript } from '$Src/windows-picker.js';
import { windowsSwapScript } from '$Src/self-update-windows.js';
fs.writeFileSync(process.argv[2] + '/pick-app.ps1', windowsPickerScript('app', { startMenuDir: 'C:\\Start Menu' }));
fs.writeFileSync(process.argv[2] + '/pick-folder.ps1', windowsPickerScript('folder'));
fs.writeFileSync(process.argv[2] + '/swap.ps1', windowsSwapScript());
"@ | Set-Content -LiteralPath (Join-Path $Check 'write.mjs') -Encoding UTF8
& $Node (Join-Path $Check 'write.mjs') $Check
foreach ($f in Get-ChildItem $Check -Filter *.ps1) {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) { throw "$($f.Name) does not parse: $($errors[0].Message)" }
  Write-Host "  $($f.Name) parses"
}
Remove-Item -LiteralPath $Check -Recurse -Force

Write-Host '==> [Launch 2/4] Real Start Menu, program icons and Store folders of this machine'
& $Node (Join-Path $Root 'scripts\probe-windows.mjs') $Exe
if ($LASTEXITCODE -ne 0) { throw 'the Windows readers found nothing on this machine' }

Write-Host '==> [Launch 3/4] Starting ArtifactAtlas.exe as a user would'
Remove-Item -LiteralPath $UrlFile -Force -ErrorAction SilentlyContinue
$Launcher = Start-Process -FilePath $Exe -PassThru
$Url = $null
for ($i = 0; $i -lt 600 -and -not $Url; $i++) {
  if (Test-Path $UrlFile) { $Url = (Get-Content $UrlFile -Raw).Trim() }
  else { Start-Sleep -Milliseconds 100 }
}
if (-not $Url) { throw 'the launcher did not start the backend' }
$Health = Invoke-RestMethod -Uri "$Url/api/health"
Write-Host "  backend at $Url, status $($Health.status)"
$Window = $null
for ($i = 0; $i -lt 300 -and -not $Window; $i++) {
  $Window = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--app=') -and $_.CommandLine.Contains($WindowProfile) } | Select-Object -First 1
  if (-not $Window) { Start-Sleep -Milliseconds 100 }
}
if (-not $Window) { throw 'no app window was opened' }
Write-Host "  window: $($Window.Name) (pid $($Window.ProcessId))"
$Backend = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $Node } | Select-Object -First 1
if (-not $Backend) { throw 'the backend process was not found' }

Write-Host '==> [Launch 4/4] Closing the window quits the launcher and the backend'
# All browser processes of this profile, as when the user closes the window
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($WindowProfile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $Launcher.WaitForExit(20000)) { throw 'the launcher kept running after its window closed' }
for ($i = 0; $i -lt 100 -and (Get-Process -Id $Backend.ProcessId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
if (Get-Process -Id $Backend.ProcessId -ErrorAction SilentlyContinue) { throw 'the backend kept running after the app quit' }
if (Test-Path $UrlFile) { throw 'window-url.txt was left behind' }
Write-Host 'WINDOWS_LAUNCH_VERIFIED: OK'
