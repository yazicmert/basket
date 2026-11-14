import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Windows file and folder dialogs for choosing an application or a project folder, the
 * counterpart of the Mac app's Open panels. The window of the Windows app is drawn by a
 * browser, which never reveals a full path, so the backend shows the system dialog itself
 * with Windows PowerShell. The dialog only returns the path the user picked: nothing is
 * opened or run, and shortcuts are returned as shortcuts (their target is read later).
 */

export const PICK_KINDS = ['app', 'folder'];

export function windowsPickerScript(kind, { startMenuDir = '' } = {}) {
  if (!PICK_KINDS.includes(kind)) {
    throw new Error(`Unknown picker: ${kind}`);
  }
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const dialog =
    kind === 'app'
      ? [
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          "$d.Title = 'Choose an app to scan'",
          "$d.Filter = 'Programs and shortcuts (*.exe;*.lnk)|*.exe;*.lnk'",
          // Keep a shortcut as a shortcut: its name is the app's name
          '$d.DereferenceLinks = $false',
          `if (${quote(startMenuDir)} -and (Test-Path -LiteralPath ${quote(startMenuDir)})) { $d.InitialDirectory = ${quote(startMenuDir)} }`,
          "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }"
        ]
      : [
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$d.Description = 'Choose a project folder to include in the scan'",
          '$d.ShowNewFolderButton = $false',
          "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
        ];
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    // An invisible topmost owner keeps the dialog in front of the app's window
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Opacity = 0',
    "$owner.StartPosition = 'CenterScreen'",
    '$owner.Show()',
    '$owner.Activate()',
    ...dialog,
    '$owner.Close()'
  ].join('\n');
}

/** Shows the dialog and resolves to the chosen path, or null when it was cancelled. */
export function pickWithWindowsDialog(kind, { startMenuDir = '', execFileImpl = execFile } = {}) {
  const script = windowsPickerScript(kind, { startMenuDir });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFileImpl(
      powershell,
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          reject(new Error('The Windows dialog could not be shown.'));
          return;
        }
        const picked = String(stdout || '').trim();
        resolve(/^[A-Za-z]:\\/.test(picked) || /^\\\\/.test(picked) ? picked : null);
      }
    );
  });
}
