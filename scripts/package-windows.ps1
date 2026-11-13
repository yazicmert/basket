# ==============================================================================
# Artifact Atlas - Windows packager
# Produces:
#   dist\ArtifactAtlas\                 the application folder
#   dist\ArtifactAtlas-Windows.zip      that folder, zipped
#   dist\SHA256SUMS-Windows.txt         SHA-256 of the ZIP
#
# The folder holds ArtifactAtlas.exe (a small launcher compiled here from
# packaging\windows\Launcher.cs), the official Node.js runtime, and the app's source.
# ==============================================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$AppVersion = if ($env:APP_VERSION) { $env:APP_VERSION -replace '^v', '' } else { $Package.version }
$NodeVersion = if ($env:BUNDLED_NODE_VERSION) { $env:BUNDLED_NODE_VERSION } else { 'v22.14.0' }
$NodeArch = if ($env:TARGET_ARCH -eq 'arm64') { 'arm64' } else { 'x64' }

$Dist = Join-Path $Root 'dist'
$AppDir = Join-Path $Dist 'ArtifactAtlas'
$ZipPath = Join-Path $Dist 'ArtifactAtlas-Windows.zip'

Write-Host "==> [1/6] Cleaning $Dist"
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'runtime'), (Join-Path $AppDir 'app') | Out-Null

Write-Host "==> [2/6] Downloading the Node.js $NodeVersion runtime ($NodeArch) and checking its SHA-256"
$NodeZipName = "node-$NodeVersion-win-$NodeArch.zip"
$Download = Join-Path ([System.IO.Path]::GetTempPath()) ("atlas-node-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Download | Out-Null
Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$NodeZipName" -OutFile (Join-Path $Download $NodeZipName)
Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $Download 'SHASUMS256.txt')
$Expected = (Select-String -Path (Join-Path $Download 'SHASUMS256.txt') -Pattern ([regex]::Escape($NodeZipName) + '$')).Line.Split(' ')[0]
$Actual = (Get-FileHash (Join-Path $Download $NodeZipName) -Algorithm SHA256).Hash.ToLower()
if (-not $Expected -or $Expected -ne $Actual) { throw "Node.js download does not match its published SHA-256 ($Actual)" }
Expand-Archive (Join-Path $Download $NodeZipName) -DestinationPath $Download
Copy-Item (Join-Path $Download "node-$NodeVersion-win-$NodeArch\node.exe") (Join-Path $AppDir 'runtime\node.exe')
Copy-Item (Join-Path $Download "node-$NodeVersion-win-$NodeArch\LICENSE") (Join-Path $AppDir 'runtime\NODE-LICENSE.txt')
Remove-Item $Download -Recurse -Force

Write-Host "==> [3/6] Copying the app (version $AppVersion)"
Copy-Item (Join-Path $Root 'src') (Join-Path $AppDir 'app\src') -Recurse
# The app reports this file's version when it checks for updates
$Package.version = $AppVersion
$PackageJson = $Package | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path $AppDir 'app\package.json'), $PackageJson)
Copy-Item (Join-Path $Root 'LICENSE') (Join-Path $AppDir 'LICENSE.txt')
Copy-Item (Join-Path $Root 'packaging\windows\README.txt') (Join-Path $AppDir 'README.txt')

Write-Host "==> [4/6] Compiling ArtifactAtlas.exe"
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $Csc)) { $Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $Csc)) { throw 'The .NET Framework C# compiler (csc.exe) was not found.' }
$NumericVersion = (($AppVersion -replace '[^0-9.].*$', '').Split('.') + @('0', '0', '0', '0'))[0..3] -join '.'
$AssemblyInfo = Join-Path $Dist 'AssemblyInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("Artifact Atlas")]
[assembly: AssemblyProduct("Artifact Atlas")]
[assembly: AssemblyDescription("See what an application left behind, and remove it safely.")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Artifact Atlas Contributors. MIT License.")]
[assembly: AssemblyVersion("$NumericVersion")]
[assembly: AssemblyFileVersion("$NumericVersion")]
[assembly: AssemblyInformationalVersion("$AppVersion")]
"@ | Set-Content -Path $AssemblyInfo -Encoding UTF8
& $Csc /nologo /target:winexe /optimize+ /platform:anycpu `
  "/win32icon:$(Join-Path $Root 'packaging\windows\ArtifactAtlas.ico')" `
  /reference:System.Windows.Forms.dll `
  "/out:$(Join-Path $AppDir 'ArtifactAtlas.exe')" `
  (Join-Path $Root 'packaging\windows\Launcher.cs') $AssemblyInfo
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
Remove-Item $AssemblyInfo

Write-Host "==> [5/6] Checking the packaged app end to end (sample data)"
& (Join-Path $AppDir 'runtime\node.exe') (Join-Path $AppDir 'app\src\cli.js') demo
if ($LASTEXITCODE -ne 0) { throw "The packaged app failed its end-to-end check (exit code $LASTEXITCODE)" }

Write-Host "==> [6/6] Creating ArtifactAtlas-Windows.zip and its SHA-256"
Compress-Archive -Path $AppDir -DestinationPath $ZipPath -CompressionLevel Optimal
$ZipHash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
# Same line format as shasum, with a Unix line ending, so the lists can be joined
[System.IO.File]::WriteAllText((Join-Path $Dist 'SHA256SUMS-Windows.txt'), "$ZipHash  ArtifactAtlas-Windows.zip`n")

Write-Host '==================================================================='
Write-Host '  Windows packaging complete'
Write-Host '==================================================================='
Get-ChildItem $Dist | Format-Table Name, Length
Get-Content (Join-Path $Dist 'SHA256SUMS-Windows.txt')
