import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseWindowsShortcutTarget } from './windows-apps.js';

/**
 * Reads a Windows program's own icon for display, the way app-icon.js does for a macOS
 * bundle. Static read only: the program file's resource table is parsed by offset (its
 * RT_GROUP_ICON and RT_ICON entries) and the largest image is returned as PNG. Nothing in it
 * is run. Icons stored as PNG are returned as they are; 32-bit bitmap icons are converted.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_RESOURCE_SECTION = 64 * 1024 * 1024;
const MAX_ICON_BYTES = 4 * 1024 * 1024;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, offset);
  return read === length ? buf : null;
}

/** The resource section of a PE file: { data, rva } or null. */
function readResourceSection(fd, fileSize) {
  const dos = readAt(fd, 0, 64);
  if (!dos || dos.toString('latin1', 0, 2) !== 'MZ') return null;
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset + 24 > fileSize) return null;
  const head = readAt(fd, peOffset, 24);
  if (!head || head.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
  const sectionCount = head.readUInt16LE(6);
  const optionalSize = head.readUInt16LE(20);
  const optional = readAt(fd, peOffset + 24, optionalSize);
  if (!optional || optionalSize < 96) return null;
  const magic = optional.readUInt16LE(0);
  const dirStart = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  if (dirStart < 0 || dirStart + 3 * 8 > optionalSize) return null;
  const resourceRva = optional.readUInt32LE(dirStart + 2 * 8);
  if (!resourceRva) return null;
  const sections = readAt(fd, peOffset + 24 + optionalSize, sectionCount * 40);
  if (!sections) return null;
  for (let i = 0; i < sectionCount; i++) {
    const at = i * 40;
    const virtualSize = sections.readUInt32LE(at + 8);
    const virtualAddress = sections.readUInt32LE(at + 12);
    const rawSize = sections.readUInt32LE(at + 16);
    const rawPointer = sections.readUInt32LE(at + 20);
    const span = Math.max(virtualSize, rawSize);
    if (resourceRva >= virtualAddress && resourceRva < virtualAddress + span) {
      if (rawSize > MAX_RESOURCE_SECTION || rawPointer + rawSize > fileSize) return null;
      const data = readAt(fd, rawPointer, rawSize);
      return data ? { data, rva: virtualAddress, rootOffset: resourceRva - virtualAddress } : null;
    }
  }
  return null;
}

/** Entries of one resource directory: [{ id, isDirectory, offset }] (named entries skipped). */
function directoryEntries(section, offset) {
  const { data } = section;
  if (offset + 16 > data.length) return [];
  const named = data.readUInt16LE(offset + 12);
  const ids = data.readUInt16LE(offset + 14);
  const entries = [];
  for (let i = 0; i < named + ids; i++) {
    const at = offset + 16 + i * 8;
    if (at + 8 > data.length) break;
    const name = data.readUInt32LE(at);
    const target = data.readUInt32LE(at + 4);
    if (name & 0x80000000) continue; // named entry
    entries.push({ id: name & 0xffff, isDirectory: Boolean(target & 0x80000000), offset: section.rootOffset + (target & 0x7fffffff) });
  }
  return entries;
}

/** The bytes of the first language of one resource, or null. */
function resourceData(section, entry) {
  let current = entry;
  // name level -> language level -> data entry
  while (current && current.isDirectory) {
    current = directoryEntries(section, current.offset)[0];
  }
  if (!current) return null;
  const { data } = section;
  if (current.offset + 8 > data.length) return null;
  const rva = data.readUInt32LE(current.offset);
  const size = data.readUInt32LE(current.offset + 4);
  const start = rva - section.rva;
  if (start < 0 || size > MAX_ICON_BYTES || start + size > data.length) return null;
  return data.subarray(start, start + size);
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** A 32-bit BGRA bitmap icon (bottom-up, height doubled for the mask) as PNG, or null. */
export function bitmapIconToPng(dib) {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  const height = Math.abs(dib.readInt32LE(8)) / 2;
  const bitCount = dib.readUInt16LE(14);
  if (headerSize < 40 || bitCount !== 32 || width <= 0 || width > 512 || height <= 0 || height > 512) return null;
  const rowBytes = width * 4;
  if (headerSize + rowBytes * height > dib.length) return null;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = headerSize + (height - 1 - y) * rowBytes; // bottom-up
    const dst = y * (rowBytes + 1);
    raw[dst] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + 1 + x * 4;
      raw[d] = dib[s + 2];
      raw[d + 1] = dib[s + 1];
      raw[d + 2] = dib[s];
      raw[d + 3] = dib[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** The largest icon of a program file (.exe) as PNG, or null. */
export function readExeIconPng(exePath) {
  let fd;
  try {
    const st = fs.lstatSync(exePath);
    if (!st.isFile()) return null;
    fd = fs.openSync(exePath, 'r');
    const section = readResourceSection(fd, st.size);
    if (!section) return null;
    const types = directoryEntries(section, section.rootOffset);
    const groupType = types.find((t) => t.id === RT_GROUP_ICON && t.isDirectory);
    const iconType = types.find((t) => t.id === RT_ICON && t.isDirectory);
    if (!groupType || !iconType) return null;
    const group = resourceData(section, directoryEntries(section, groupType.offset)[0]);
    if (!group || group.length < 6) return null;
    const count = group.readUInt16LE(4);
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 14;
      if (at + 14 > group.length) break;
      candidates.push({ size: group[at] || 256, bits: group.readUInt16LE(at + 6), id: group.readUInt16LE(at + 12) });
    }
    candidates.sort((a, b) => b.size - a.size || b.bits - a.bits);
    const icons = directoryEntries(section, iconType.offset);
    for (const candidate of candidates) {
      const entry = icons.find((e) => e.id === candidate.id);
      const image = entry ? resourceData(section, entry) : null;
      if (!image) continue;
      if (image.subarray(0, 8).equals(PNG_SIGNATURE)) return Buffer.from(image);
      const png = bitmapIconToPng(image);
      if (png) return png;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The icon of an application listed on Windows: a Start Menu shortcut (its stored target's
 * icon) or a program file. Only regular .exe files are read.
 */
export function readWindowsAppIconPng(appPath) {
  try {
    let exe = appPath;
    if (/\.lnk$/i.test(appPath)) {
      exe = parseWindowsShortcutTarget(fs.readFileSync(appPath));
      if (!exe) return null;
    }
    if (!/\.exe$/i.test(exe) || !path.isAbsolute(exe)) return null;
    return readExeIconPng(exe);
  } catch {
    return null;
  }
}
