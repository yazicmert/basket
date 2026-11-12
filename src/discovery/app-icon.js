import fs from 'node:fs';
import path from 'node:path';
import { parseMacOSBinaryPlist, parseMacOSPlistXml } from './application-discovery.js';

/**
 * Reads an application's own icon out of its bundle so the UI can show it.
 *
 * This is static inspection only: Contents/Info.plist names the icon file, and the PNG
 * image is copied out of that .icns container. Nothing inside the bundle is executed, and
 * the icon file must be a regular file that resolves inside the bundle.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ICNS_BYTES = 24 * 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

// Entry types that normally hold PNG data, best fit for a small UI tile first
// (128, 256, 256, 64, 512, 512, 32, 1024 px).
const PREFERRED_ENTRY_TYPES = ['ic07', 'ic13', 'ic08', 'ic12', 'ic14', 'ic09', 'ic11', 'ic10'];

/**
 * Returns the best PNG image stored in an .icns buffer, or null when it holds none
 * (older icons store raw or JPEG 2000 data, which is not converted).
 */
export function extractPngFromIcns(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'icns') {
    return null;
  }
  const declaredLength = buffer.readUInt32BE(4);
  const end = Math.min(buffer.length, declaredLength || buffer.length);
  const found = new Map();
  let offset = 8;
  while (offset + 8 <= end) {
    const type = buffer.toString('latin1', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > end) {
      break;
    }
    const data = buffer.subarray(offset + 8, offset + length);
    if (
      data.length > PNG_SIGNATURE.length &&
      data.length <= MAX_PNG_BYTES &&
      data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
      !found.has(type)
    ) {
      found.set(type, data);
    }
    offset += length;
  }
  for (const type of PREFERRED_ENTRY_TYPES) {
    if (found.has(type)) {
      return Buffer.from(found.get(type));
    }
  }
  const first = found.values().next();
  return first.done ? null : Buffer.from(first.value);
}

function readInfoPlist(contentsDir) {
  const infoPlistPath = path.join(contentsDir, 'Info.plist');
  const stat = fs.lstatSync(infoPlistPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return {};
  }
  const raw = fs.readFileSync(infoPlistPath);
  return raw.toString('latin1', 0, 6) === 'bplist'
    ? parseMacOSBinaryPlist(raw)
    : parseMacOSPlistXml(raw.toString('utf8'));
}

/**
 * Returns the application's icon as a PNG buffer, or null when the bundle has no icon
 * that can be read this way (for example icons that exist only in an asset catalog).
 */
export function readAppIconPng(bundlePath) {
  try {
    const resolvedBundlePath = path.resolve(String(bundlePath || ''));
    if (!resolvedBundlePath.endsWith('.app')) {
      return null;
    }
    const bundleStat = fs.lstatSync(resolvedBundlePath, { throwIfNoEntry: false });
    if (!bundleStat || !bundleStat.isDirectory()) {
      return null;
    }

    const contentsDir = path.join(resolvedBundlePath, 'Contents');
    const plist = readInfoPlist(contentsDir);
    const iconName = plist.CFBundleIconFile;
    if (typeof iconName !== 'string' || !iconName || iconName !== path.basename(iconName)) {
      return null;
    }
    const fileName = iconName.toLowerCase().endsWith('.icns') ? iconName : `${iconName}.icns`;
    const iconPath = path.join(contentsDir, 'Resources', fileName);

    const iconStat = fs.lstatSync(iconPath, { throwIfNoEntry: false });
    if (!iconStat || !iconStat.isFile() || iconStat.size > MAX_ICNS_BYTES) {
      return null;
    }
    // The icon must live inside the bundle even after resolving parent directories.
    const realBundle = fs.realpathSync(resolvedBundlePath);
    const realIcon = fs.realpathSync(iconPath);
    if (!realIcon.startsWith(realBundle + path.sep)) {
      return null;
    }

    return extractPngFromIcns(fs.readFileSync(realIcon));
  } catch {
    return null;
  }
}
