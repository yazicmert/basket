import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { parseVersion } from './update-check.js';

/**
 * In-place update on Windows, when the user asks for it.
 *
 * The same steps as on macOS (see self-update.js): the release ZIP is downloaded from the
 * project's GitHub release and kept only if it matches the SHA-256 published with it. It is
 * unpacked with the tar.exe that ships with Windows 10 and 11, and checked to hold this
 * application (package name artifact-atlas, the launcher, the runtime and the app) at the
 * expected version. Windows builds carry no code signature, so these checks and the digest
 * stand in for codesign. A helper outside the install folder waits for the running copy to
 * quit, moves the app's own entries aside, puts the new ones in place, restores the old
 * ones if anything fails, and starts the app again. Nothing is installed without a click.
 */

export const WINDOWS_ZIP_ASSET_NAME = 'ArtifactAtlas-Windows.zip';
export const WINDOWS_PACKAGE_NAME = 'artifact-atlas';
/** What the app's install folder holds. Only these are ever replaced; the folder is kept. */
export const WINDOWS_INSTALL_ENTRIES = ['ArtifactAtlas.exe', 'runtime', 'app', 'README.txt', 'LICENSE.txt'];

/** The install folder (the one holding ArtifactAtlas.exe) this backend runs from, or null. */
export function findRunningWindowsInstall(modulePath) {
  const value = String(modulePath || '');
  const match = /^(.*)[\\/]app[\\/]src[\\/]ui[\\/]server\.js$/i.exec(value);
  if (!match) return null;
  const root = match[1];
  return fs.existsSync(path.join(root, 'ArtifactAtlas.exe')) ? root : null;
}

/** Writing a file is the reliable test on Windows; access() ignores folder ACLs. */
function canWriteIn(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.atlas-write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where an update is installed: the running copy's folder, or, when that cannot be written
 * (for example under Program Files), the user's own programs folder. Returns
 * { ok, reason, targetPath, relocates }.
 */
export function resolveWindowsInstallTarget({ installDir, localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') }) {
  if (!installDir) return { ok: false, reason: 'NOT_PACKAGED', targetPath: null, relocates: false };
  if (canWriteIn(installDir)) return { ok: true, reason: null, targetPath: installDir, relocates: false };
  const fallback = path.join(localAppData, 'Programs', 'ArtifactAtlas');
  if (path.resolve(fallback).toLowerCase() !== path.resolve(installDir).toLowerCase() && canWriteIn(fallback)) {
    return { ok: true, reason: 'FOLDER_NOT_WRITABLE', targetPath: fallback, relocates: true };
  }
  return { ok: false, reason: 'FOLDER_NOT_WRITABLE', targetPath: null, relocates: false };
}

function tarPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * Unpacks a verified ZIP and checks it is this application at the expected version.
 * Returns the staged folder (the one holding ArtifactAtlas.exe).
 */
export function stageVerifiedWindowsPackage({ zipPath, stagingDir, expectedVersion, tar = tarPath() }) {
  const unpackDir = path.join(stagingDir, 'unpacked');
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.mkdirSync(unpackDir, { recursive: true });
  execFileSync(tar, ['-xf', zipPath, '-C', unpackDir], { stdio: 'ignore', windowsHide: true });
  return checkStagedWindowsPackage(path.join(unpackDir, 'ArtifactAtlas'), expectedVersion);
}

/** The checks that stand in for a code signature on Windows. */
export function checkStagedWindowsPackage(staged, expectedVersion) {
  for (const entry of ['ArtifactAtlas.exe', path.join('runtime', 'node.exe'), path.join('app', 'src', 'cli.js'), path.join('app', 'package.json')]) {
    const st = fs.lstatSync(path.join(staged, entry), { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Error('UPDATE_PACKAGE_INCOMPLETE');
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(staged, 'app', 'package.json'), 'utf8'));
  } catch {
    throw new Error('UPDATE_PACKAGE_INCOMPLETE');
  }
  if (pkg.name !== WINDOWS_PACKAGE_NAME) throw new Error('UPDATE_PACKAGE_NAME_MISMATCH');
  const want = parseVersion(expectedVersion);
  const got = parseVersion(pkg.version);
  if (!want || !got || want.join('.') !== got.join('.')) throw new Error('UPDATE_VERSION_MISMATCH');
  return staged;
}

/**
 * The helper that swaps the app once it has quit. Written for Windows PowerShell 5.1, which
 * every Windows 10 and 11 has. It only touches the app's own entries in the install folder
 * and the staging folder, keeps the old entries until the new ones are in place, and puts
 * them back if anything fails.
 */
export function windowsSwapScript() {
  return `# Artifact Atlas update helper (Windows PowerShell 5.1)
param([string]$InstallDir, [string]$StagedDir, [int]$AppPid, [string]$Staging, [string]$Relaunch, [string]$RunningDir)
$ErrorActionPreference = 'Stop'
$Log = Join-Path $Staging 'update.log'
function Write-Log([string]$Line) { Add-Content -LiteralPath $Log -Value $Line -Encoding UTF8 }
Write-Log ("update started " + (Get-Date -Format o))

$Entries = @(${WINDOWS_INSTALL_ENTRIES.map((e) => `'${e}'`).join(', ')})
$StagingFull = [System.IO.Path]::GetFullPath($Staging).TrimEnd('\\') + '\\'
$StagedFull = [System.IO.Path]::GetFullPath($StagedDir)
if (-not $StagedFull.StartsWith($StagingFull, [System.StringComparison]::OrdinalIgnoreCase)) { Write-Log 'refusing: unexpected staged path'; exit 2 }
if (-not (Test-Path -LiteralPath (Join-Path $StagedDir 'ArtifactAtlas.exe'))) { Write-Log 'refusing: staged package missing'; exit 2 }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { Write-Log 'refusing: no install folder'; exit 2 }
if (Test-Path -LiteralPath $InstallDir) {
  $Existing = Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -ExpandProperty Name
  if ($Existing.Count -gt 0 -and -not ($Existing -contains 'ArtifactAtlas.exe')) { Write-Log 'refusing: the install folder does not hold Artifact Atlas'; exit 2 }
}
if (-not $RunningDir) { $RunningDir = $InstallDir }

# Wait for the app to quit (the window closes itself), then make sure it and its runtime are gone
for ($i = 0; $i -lt 300; $i++) { if (-not (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100 }
Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
$Runtime = Join-Path $RunningDir 'runtime\\node.exe'
for ($i = 0; $i -lt 100; $i++) {
  $Left = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $Runtime) })
  if ($Left.Count -eq 0) { break }
  if ($i -eq 50) { $Left | Stop-Process -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 300

$Previous = Join-Path $Staging 'previous'
if (Test-Path -LiteralPath $Previous) { Remove-Item -LiteralPath $Previous -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Previous | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Moved = @()
$Status = 0
try {
  foreach ($Entry in $Entries) {
    $Current = Join-Path $InstallDir $Entry
    if (Test-Path -LiteralPath $Current) { Move-Item -LiteralPath $Current -Destination (Join-Path $Previous $Entry); $Moved += $Entry }
  }
  foreach ($Entry in $Entries) {
    $New = Join-Path $StagedDir $Entry
    if (Test-Path -LiteralPath $New) { Copy-Item -LiteralPath $New -Destination (Join-Path $InstallDir $Entry) -Recurse -Force }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'ArtifactAtlas.exe'))) { throw 'the new launcher is missing after the copy' }
  Write-Log 'installed'
} catch {
  Write-Log ('failed: ' + $_.Exception.Message + ' Restoring the previous version.')
  foreach ($Entry in $Entries) {
    $Target = Join-Path $InstallDir $Entry
    if (Test-Path -LiteralPath (Join-Path $Previous $Entry)) {
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item -LiteralPath (Join-Path $Previous $Entry) -Destination $Target -ErrorAction SilentlyContinue
    }
  }
  $Status = 1
}
if ($Relaunch -eq '1') {
  $Exe = if ($Status -eq 0) { Join-Path $InstallDir 'ArtifactAtlas.exe' } else { Join-Path $RunningDir 'ArtifactAtlas.exe' }
  if (Test-Path -LiteralPath $Exe) { Start-Process -FilePath $Exe }
}
if ($Status -eq 0) {
  Remove-Item -LiteralPath $Previous -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $Staging 'unpacked') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $Staging '${WINDOWS_ZIP_ASSET_NAME}') -Force -ErrorAction SilentlyContinue
}
Write-Log ("update finished with status " + $Status)
exit $Status
`;
}

/** Starts the swap helper detached from this process, which is about to be stopped. */
export function launchWindowsSwap({ installDir, stagedDir, appPid, stagingDir, relaunch = true, runningDir = null }) {
  const scriptPath = path.join(stagingDir, 'swap.ps1');
  // A byte-order mark keeps Windows PowerShell 5.1 reading the script as UTF-8
  fs.writeFileSync(scriptPath, '\ufeff' + windowsSwapScript(), 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(
    powershell,
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath,
      '-InstallDir', installDir, '-StagedDir', stagedDir, '-AppPid', String(appPid), '-Staging', stagingDir,
      '-Relaunch', relaunch ? '1' : '0', '-RunningDir', runningDir || installDir
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  return scriptPath;
}
