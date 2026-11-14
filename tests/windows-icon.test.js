import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readExeIconPng, bitmapIconToPng, readWindowsAppIconPng } from '../src/discovery/windows-icon.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A minimal PE32 file with one .rsrc section holding a group icon and its images. */
function makeExe(images) {
  const sectionRva = 0x1000;
  const fileAlign = 0x200;
  // Resource tree: root(2 types) -> type -> name(id) -> lang -> data entry
  const dirs = [];
  const dataEntries = [];
  const blobs = [];
  // Build in a flat buffer with absolute offsets computed in two passes
  const groupBody = Buffer.alloc(6 + images.length * 14);
  groupBody.writeUInt16LE(1, 2);
  groupBody.writeUInt16LE(images.length, 4);
  images.forEach((img, i) => {
    const at = 6 + i * 14;
    groupBody[at] = img.size === 256 ? 0 : img.size;
    groupBody[at + 1] = img.size === 256 ? 0 : img.size;
    groupBody.writeUInt16LE(1, at + 4);
    groupBody.writeUInt16LE(32, at + 6);
    groupBody.writeUInt32LE(img.data.length, at + 8);
    groupBody.writeUInt16LE(i + 1, at + 12);
  });
  const layout = [];
  let cursor = 0;
  const alloc = (size) => { const at = cursor; cursor += size; return at; };
  const dirSize = (n) => 16 + n * 8;
  const root = alloc(dirSize(2));
  const iconTypeDir = alloc(dirSize(images.length));
  const groupTypeDir = alloc(dirSize(1));
  const iconNameDirs = images.map(() => alloc(dirSize(1)));
  const groupNameDir = alloc(dirSize(1));
  const iconEntries = images.map(() => alloc(16));
  const groupEntry = alloc(16);
  const iconData = images.map((img) => { const at = alloc(img.data.length); return at; });
  const groupData = alloc(groupBody.length);
  const buf = Buffer.alloc(cursor);
  const dir = (at, entries) => {
    buf.writeUInt16LE(entries.length, at + 14);
    entries.forEach(([id, target, sub], i) => {
      buf.writeUInt32LE(id, at + 16 + i * 8);
      buf.writeUInt32LE((sub ? 0x80000000 : 0) + target, at + 20 + i * 8);
    });
  };
  dir(root, [[3, iconTypeDir, true], [14, groupTypeDir, true]]);
  dir(iconTypeDir, images.map((_, i) => [i + 1, iconNameDirs[i], true]));
  dir(groupTypeDir, [[1, groupNameDir, true]]);
  images.forEach((_, i) => dir(iconNameDirs[i], [[1033, iconEntries[i], false]]));
  dir(groupNameDir, [[1033, groupEntry, false]]);
  images.forEach((img, i) => {
    buf.writeUInt32LE(sectionRva + iconData[i], iconEntries[i]);
    buf.writeUInt32LE(img.data.length, iconEntries[i] + 4);
    img.data.copy(buf, iconData[i]);
  });
  buf.writeUInt32LE(sectionRva + groupData, groupEntry);
  buf.writeUInt32LE(groupBody.length, groupEntry + 4);
  groupBody.copy(buf, groupData);

  const headers = Buffer.alloc(fileAlign);
  headers.write('MZ', 0, 'latin1');
  headers.writeUInt32LE(0x80, 0x3c);
  headers.writeUInt32LE(0x00004550, 0x80);
  headers.writeUInt16LE(0x14c, 0x84); // machine
  headers.writeUInt16LE(1, 0x86); // sections
  headers.writeUInt16LE(224, 0x94); // optional header size (PE32)
  const opt = 0x98;
  headers.writeUInt16LE(0x10b, opt);
  headers.writeUInt32LE(16, opt + 92); // number of data directories
  headers.writeUInt32LE(sectionRva, opt + 96 + 16); // resource directory RVA
  headers.writeUInt32LE(buf.length, opt + 96 + 20);
  const sec = opt + 224;
  headers.write('.rsrc', sec, 'latin1');
  headers.writeUInt32LE(buf.length, sec + 8);
  headers.writeUInt32LE(sectionRva, sec + 12);
  headers.writeUInt32LE(buf.length, sec + 16);
  headers.writeUInt32LE(fileAlign, sec + 20);
  return Buffer.concat([headers, buf]);
}

function makeDib(size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  // bottom row blue, top row red (BGRA, stored bottom-up)
  for (let x = 0; x < size; x++) { pixels.writeUInt32LE(0xff0000ff, x * 4); pixels.writeUInt32LE(0xffff0000, ((size - 1) * size + x) * 4); }
  return Buffer.concat([header, pixels, Buffer.alloc(size * size / 8)]);
}

function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('WI1. A program file\'s largest icon is read by offset: PNG kept as is, 32-bit bitmaps converted', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-winicon-')));
  try {
    const bigPng = Buffer.concat([PNG, Buffer.from('fake png body')]);
    const exe = path.join(root, 'App.exe');
    fs.writeFileSync(exe, makeExe([{ size: 32, data: makeDib(32) }, { size: 256, data: bigPng }]));
    assert.deepEqual(readExeIconPng(exe), bigPng, 'the 256 px PNG wins');

    const dibOnly = path.join(root, 'Old.exe');
    fs.writeFileSync(dibOnly, makeExe([{ size: 16, data: makeDib(16) }, { size: 48, data: makeDib(48) }]));
    const png = readExeIconPng(dibOnly);
    assert.ok(png.subarray(0, 8).equals(PNG));
    assert.deepEqual(pngSize(png), { width: 48, height: 48 });
    // Top-left pixel is the red top row (rows are flipped from bottom-up)
    const idat = png.indexOf('IDAT');
    const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    assert.deepEqual([...raw.subarray(1, 5)], [255, 0, 0, 255]);

    // Not a program, a truncated one, and a shortcut without a stored target
    fs.writeFileSync(path.join(root, 'notes.exe'), 'hello');
    assert.equal(readExeIconPng(path.join(root, 'notes.exe')), null);
    fs.writeFileSync(path.join(root, 'cut.exe'), makeExe([{ size: 32, data: makeDib(32) }]).subarray(0, 700));
    assert.equal(readExeIconPng(path.join(root, 'cut.exe')), null);
    assert.equal(readExeIconPng(path.join(root, 'missing.exe')), null);
    fs.writeFileSync(path.join(root, 'Store.lnk'), Buffer.alloc(0x4c));
    assert.equal(readWindowsAppIconPng(path.join(root, 'Store.lnk')), null);
    assert.equal(readWindowsAppIconPng(path.join(root, 'readme.txt')), null);
    assert.equal(bitmapIconToPng(Buffer.alloc(10)), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
