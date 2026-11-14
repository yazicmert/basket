// Runs the Windows-only readers on the machine it runs on and prints what they find:
// Start Menu shortcuts and their stored targets, program icons, Store app data folders.
// Used in CI to check these readers against a real Windows installation, not only fixtures.
// Reads names, shortcut targets and icon resources only; nothing is run.
import fs from 'node:fs';
import path from 'node:path';
import { listStartMenuApplications, parseWindowsShortcutTarget, listStoreApplications } from '../src/discovery/windows-apps.js';
import { readWindowsAppIconPng, readExeIconPng } from '../src/discovery/windows-icon.js';

const home = process.env.USERPROFILE;
const dirs = [
  path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
];
const apps = listStartMenuApplications(dirs);
let withTarget = 0;
let withIcon = 0;
for (const app of apps) {
  const target = parseWindowsShortcutTarget(fs.readFileSync(app.shortcutPath));
  if (target) withTarget += 1;
  const icon = readWindowsAppIconPng(app.shortcutPath);
  if (icon) withIcon += 1;
  console.log(`${app.name.padEnd(40)} target: ${target || '-'} icon: ${icon ? icon.length + ' bytes' : '-'}`);
}
console.log(`START_MENU shortcuts=${apps.length} targets=${withTarget} icons=${withIcon}`);

const own = process.argv[2];
if (own) {
  const png = readExeIconPng(own);
  console.log(`OWN_ICON ${own}: ${png ? `PNG ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : 'none'}`);
  if (!png) process.exitCode = 1;
}
const store = listStoreApplications(path.join(home, 'AppData', 'Local', 'Packages'));
console.log(`STORE_PACKAGES ${store.length}: ${store.slice(0, 20).map((s) => s.packageName).join(', ')}`);
if (apps.length === 0 || withTarget === 0) process.exitCode = 1;
