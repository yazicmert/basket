import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseRevealTarget } from '../src/graph/reveal-target.js';

const mac = (files) => chooseRevealTarget(files, { homeDir: '/Users/me', pathApi: path.posix });

test('RV1. Show in Finder opens the file, the shared folder, or the largest part of a spread selection', () => {
  assert.equal(chooseRevealTarget([]), null);
  const one = mac([{ path: '/Users/me/dev/app/a.js', bytes: 3 }]);
  assert.deepEqual([one.kind, one.path], ['file', '/Users/me/dev/app/a.js']);

  const shared = mac([
    { path: '/Users/me/Library/Caches/claude/a', bytes: 1 },
    { path: '/Users/me/Library/Caches/claude/sub/b', bytes: 1 }
  ]);
  assert.deepEqual([shared.kind, shared.path, shared.fileCount, shared.totalCount], ['folder', '/Users/me/Library/Caches/claude', 2, 2]);

  // Spread over the home folder: never the home folder or one arbitrary file
  const spread = mac([
    { path: '/Users/me/dev/shop/dist/assets/a.js', bytes: 900 },
    { path: '/Users/me/dev/shop/dist/assets/b.js', bytes: 900 },
    { path: '/Users/me/dev/blog/out/c.js', bytes: 100 },
    { path: '/Users/me/Library/Caches/x/d', bytes: 50 }
  ]);
  assert.equal(spread.kind, 'folder');
  assert.equal(spread.path, '/Users/me/dev', 'the part of home holding most bytes, down to where its files part ways');
  assert.equal(spread.fileCount, 3);
  assert.equal(spread.totalCount, 4);
  assert.equal(spread.folderCount, 3);

  // Outside the home folder, the root is never opened
  const root = chooseRevealTarget([{ path: '/opt/a/x', bytes: 1 }, { path: '/var/b/y', bytes: 5 }], { homeDir: '/Users/me', pathApi: path.posix });
  assert.equal(root.path, '/var/b');

  const win = chooseRevealTarget(
    [
      { path: 'C:\\Users\\me\\AppData\\Local\\Cursor\\a', bytes: 9 },
      { path: 'C:\\Users\\me\\appdata\\local\\Cursor\\b', bytes: 9 },
      { path: 'D:\\work\\c', bytes: 1 }
    ],
    { homeDir: 'C:\\Users\\me', pathApi: path.win32 }
  );
  assert.equal(win.path, 'C:\\Users\\me\\AppData\\Local\\Cursor', 'Windows paths compare without case');
});

test('RV2. A selection of 300,000 files is placed quickly, and a stray file outside home does not open home', () => {
  const files = [];
  for (let i = 0; i < 300000; i += 1) {
    const root = i % 3 === 0 ? '/Users/me/dev/shop/dist' : '/Users/me/Library/Caches/claude';
    files.push({ path: `${root}/d${i % 500}/f${i}.js`, bytes: i % 3 === 0 ? 100 : 10 });
  }
  const started = Date.now();
  const big = mac(files);
  assert.ok(Date.now() - started < 3000, 'fast enough to answer a click');
  assert.equal(big.path, '/Users/me/dev/shop/dist');
  assert.equal(big.totalCount, 300000);

  const stray = mac([
    { path: '/opt/a/x', bytes: 1 },
    { path: '/Users/me/dev/a/y', bytes: 50 },
    { path: '/Users/me/Library/b/z', bytes: 40 }
  ]);
  assert.equal(stray.path, '/Users/me/dev/a', 'never the home folder itself');
});
