# Checks the Windows ZIP the way a user gets it: matches its SHA-256, extracts it to a new
# folder with a space in its name, runs the app's end-to-end check on sample data, and starts
# ArtifactAtlas.exe in smoke-test mode (starts the local service, asks it for its health,
# stops it; no window is opened).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root 'dist'
$ZipPath = Join-Path $Dist 'ArtifactAtlas-Windows.zip'

$Listed = (Get-Content (Join-Path $Dist 'SHA256SUMS-Windows.txt') -Raw).Trim().Split(' ')[0]
$Actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
if ($Listed -ne $Actual) { throw "SHA-256 mismatch: listed $Listed, actual $Actual" }
Write-Host "SHA-256 matches: $Actual"

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("Atlas Verify " + [System.Guid]::NewGuid().ToString('N'))
Expand-Archive $ZipPath -DestinationPath $Work
$App = Join-Path $Work 'ArtifactAtlas'
try {
  foreach ($Required in 'ArtifactAtlas.exe', 'runtime\node.exe', 'app\src\cli.js', 'app\package.json', 'LICENSE.txt', 'README.txt') {
    if (-not (Test-Path (Join-Path $App $Required))) { throw "Missing from the ZIP: $Required" }
  }
  $Version = (Get-Content (Join-Path $App 'app\package.json') -Raw | ConvertFrom-Json).version
  Write-Host "Packaged version: $Version"
  if ($env:APP_VERSION -and (($env:APP_VERSION -replace '^v', '') -ne $Version)) { throw "Packaged version $Version does not match $($env:APP_VERSION)" }

  & (Join-Path $App 'runtime\node.exe') (Join-Path $App 'app\src\cli.js') demo
  if ($LASTEXITCODE -ne 0) { throw "End-to-end check failed (exit code $LASTEXITCODE)" }

  $Launcher = Start-Process -FilePath (Join-Path $App 'ArtifactAtlas.exe') -ArgumentList '--smoke-test' -Wait -PassThru
  if ($Launcher.ExitCode -ne 0) { throw "ArtifactAtlas.exe smoke test failed (exit code $($Launcher.ExitCode))" }
  Write-Host 'WINDOWS_PACKAGE_VERIFIED: OK'
}
finally {
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
