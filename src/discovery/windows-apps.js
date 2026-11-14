import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows applications, found without running anything.
 *
 * Windows has no application bundle. An application is named by what the user sees: a Start
 * Menu shortcut, a program file, or the folder it is installed in. Only names and the
 * shortcut's stored target path are read; no program is started and no registry tool is run.
 */

/**
 * Reads the target path stored in a Windows shortcut (.lnk, MS-SHLLINK). Returns null when
 * the shortcut stores none (Store apps, advertised shortcuts) or is not a shortcut.
 */
export function parseWindowsShortcutTarget(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 0x4c || buffer.readUInt32LE(0) !== 0x4c) {
      return null;
    }
    const flags = buffer.readUInt32LE(0x14);
    let offset = 0x4c;
    if (flags & 0x1) {
      offset += 2 + buffer.readUInt16LE(offset); // LinkTargetIDList
    }
    if (!(flags & 0x2) || offset + 28 > buffer.length) {
      return null; // No LinkInfo
    }
    const size = buffer.readUInt32LE(offset);
    const headerSize = buffer.readUInt32LE(offset + 4);
    const infoFlags = buffer.readUInt32LE(offset + 8);
    if (!(infoFlags & 0x1) || offset + size > buffer.length) {
      return null; // No local base path (a network target)
    }
    const end = offset + size;
    const readAnsi = (start) => {
      let stop = start;
      while (stop < end && buffer[stop] !== 0) stop += 1;
      return buffer.toString('latin1', start, stop);
    };
    const readUnicode = (start) => {
      let stop = start;
      while (stop + 1 < end && buffer.readUInt16LE(stop) !== 0) stop += 2;
      return buffer.toString('utf16le', start, stop);
    };
    let base;
    let suffix;
    if (headerSize >= 0x24) {
      base = readUnicode(offset + buffer.readUInt32LE(offset + 28));
      suffix = readUnicode(offset + buffer.readUInt32LE(offset + 32));
    } else {
      base = readAnsi(offset + buffer.readUInt32LE(offset + 16));
      suffix = readAnsi(offset + buffer.readUInt32LE(offset + 24));
    }
    const target = `${base}${suffix}`;
    return /^[A-Za-z]:\\/.test(target) ? target : null;
  } catch {
    return null;
  }
}

/** Shortcut names that are not applications (uninstallers, manuals, links to web sites). */
const NOT_AN_APP = /\b(uninstall|uninstaller|readme|read me|help|manual|documentation|license|website|web site|release notes|changelog)\b/i;

/** Shortcuts to web links and documents are not applications. */
const DOCUMENT_TARGET = /\.(url|html?|chm|pdf|txt|rtf)$/i;
function pointsToDocument(shortcutPath) {
  try {
    const target = parseWindowsShortcutTarget(fs.readFileSync(shortcutPath));
    return Boolean(target && DOCUMENT_TARGET.test(target));
  } catch {
    return false;
  }
}

/**
 * Lists Start Menu shortcuts by name. `startMenuDirs` are the per-user and all-users
 * "Programs" folders; they are walked two folders deep and never followed through links.
 */
export function listStartMenuApplications(startMenuDirs) {
  const found = new Map();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
      } else if (entry.isFile() && /\.lnk$/i.test(entry.name)) {
        const name = entry.name.replace(/\.lnk$/i, '');
        const key = name.toLowerCase();
        if (!NOT_AN_APP.test(name) && !found.has(key) && !pointsToDocument(full)) {
          found.set(key, { name, shortcutPath: full });
        }
      }
    }
  };
  for (const dir of startMenuDirs) {
    walk(dir, 0);
  }
  return Array.from(found.values());
}

/**
 * Describes what a Windows application reference points at: a shortcut, a program file or
 * an installation folder. Nothing is executed; a shortcut is only parsed for its target.
 */
export function describeWindowsApplication(reference) {
  const resolved = path.resolve(reference);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`Application not found at path: ${resolved}`);
  }
  const base = path.basename(resolved);
  if (stat.isFile() && /\.lnk$/i.test(base)) {
    let target = null;
    try {
      target = parseWindowsShortcutTarget(fs.readFileSync(resolved));
    } catch {
      target = null;
    }
    return {
      name: base.replace(/\.lnk$/i, ''),
      executablePath: target && /\.exe$/i.test(target) ? target : null,
      programFileName: target ? path.win32.basename(target).replace(/\.exe$/i, '') : null
    };
  }
  if (stat.isFile() && /\.exe$/i.test(base)) {
    const name = base.replace(/\.exe$/i, '');
    return { name, executablePath: resolved, programFileName: name };
  }
  if (stat.isDirectory()) {
    return { name: base, executablePath: null, programFileName: null };
  }
  throw new Error(`Expected a program (.exe), a shortcut (.lnk) or its folder, got: ${base}`);
}

/**
 * Microsoft Store applications have no Start Menu shortcut file; each keeps its data in a
 * folder under %LOCALAPPDATA%\Packages named `<Publisher>.<Name>_<publisher hash>`. Only
 * these folder names are read. Returns the names an application may be known by, lowercase:
 * "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0" -> ["openai.chatgpt-desktop", "chatgpt-desktop", "chatgpt"].
 */
export function storePackageNames(folderName) {
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*)_[a-z0-9]{13}$/.exec(String(folderName || ''));
  if (!match) return [];
  const family = match[1].toLowerCase();
  const names = new Set([family]);
  const short = family.includes('.') ? family.slice(family.lastIndexOf('.') + 1) : family;
  names.add(short);
  const stripped = short.replace(/-?(desktop|app|beta|preview)$/, '');
  if (stripped.length >= 3) names.add(stripped);
  return Array.from(names);
}

/** Lists Store application data folders by name; nothing inside them is read. */
export function listStoreApplications(packagesDir) {
  let entries;
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const names = storePackageNames(entry.name);
    if (names.length > 0) {
      found.push({ packageName: entry.name, names, path: path.join(packagesDir, entry.name) });
    }
  }
  return found;
}
