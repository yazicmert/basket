import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPngFromIcns, readAppIconPng } from '../src/discovery/app-icon.js';
import { ArtifactType } from '../src/models/entities.js';
import { createAtlasServer } from '../src/ui/server.js';
import '../src/ui/public/icons.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakePng(tag) {
  return Buffer.concat([PNG_HEAD, Buffer.from(`png-${tag}`)]);
}

function icnsOf(entries) {
  const chunks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function makeBundle(root, name, { iconFile, icns } = {}) {
  const bundle = path.join(root, `${name}.app`);
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>${name}</string>${
      iconFile ? `<key>CFBundleIconFile</key><string>${iconFile}</string>` : ''
    }</dict></plist>`
  );
  if (icns) {
    fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'AppIcon.icns'), icns);
  }
  return bundle;
}

test('extractPngFromIcns picks the PNG best suited to a small tile and ignores other data', () => {
  const icns = icnsOf([
    ['TOC ', Buffer.from('table of contents')],
    ['ic10', fakePng('1024')],
    ['il32', Buffer.from('raw rle data, not png')],
    ['ic07', fakePng('128')]
  ]);
  assert.deepEqual(extractPngFromIcns(icns), fakePng('128'));
  assert.deepEqual(extractPngFromIcns(icnsOf([['ic10', fakePng('1024')]])), fakePng('1024'));
  assert.equal(extractPngFromIcns(icnsOf([['il32', Buffer.from('raw')]])), null);
  assert.equal(extractPngFromIcns(Buffer.from('not an icns file at all')), null);
  // A truncated entry must not read past the buffer
  const truncated = icnsOf([['ic07', fakePng('128')]]).subarray(0, 20);
  assert.equal(extractPngFromIcns(truncated), null);
});

test('readAppIconPng reads the icon named by Info.plist and stays inside the bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-icon-'));
  try {
    const icns = icnsOf([['ic07', fakePng('app')]]);
    const withIcon = makeBundle(root, 'WithIcon', { iconFile: 'AppIcon', icns });
    assert.deepEqual(readAppIconPng(withIcon), fakePng('app'));

    const withExtension = makeBundle(root, 'WithExt', { iconFile: 'AppIcon.icns', icns });
    assert.deepEqual(readAppIconPng(withExtension), fakePng('app'));

    assert.equal(readAppIconPng(makeBundle(root, 'NoIcon')), null);

    // Info.plist does not name the icon, but the bundle ships one under a usual name
    const unnamed = makeBundle(root, 'Unnamed');
    fs.writeFileSync(path.join(unnamed, 'Contents', 'Resources', 'electron.icns'), icns);
    assert.deepEqual(readAppIconPng(unnamed), fakePng('app'));
    // ...or as the only .icns in Resources
    const lone = makeBundle(root, 'Lone');
    fs.writeFileSync(path.join(lone, 'Contents', 'Resources', 'Something.icns'), icns);
    assert.deepEqual(readAppIconPng(lone), fakePng('app'));
    // Several unnamed candidates are ambiguous, so none is used
    fs.writeFileSync(path.join(lone, 'Contents', 'Resources', 'Other.icns'), icns);
    assert.equal(readAppIconPng(lone), null);
    assert.equal(readAppIconPng(path.join(root, 'Missing.app')), null);
    assert.equal(readAppIconPng(root), null);

    // An icon name that tries to leave the bundle is rejected
    fs.writeFileSync(path.join(root, 'outside.icns'), icns);
    const traversal = makeBundle(root, 'Traversal', { iconFile: '../../../outside' });
    assert.equal(readAppIconPng(traversal), null);

    // A symlinked icon file is not followed
    const linked = makeBundle(root, 'Linked', { iconFile: 'AppIcon' });
    fs.symlinkSync(
      path.join(root, 'outside.icns'),
      path.join(linked, 'Contents', 'Resources', 'AppIcon.icns')
    );
    assert.equal(readAppIconPng(linked), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('icon endpoint serves icons only for bundles listed in the picker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-icon-api-'));
  const appsDir = path.join(root, 'Applications');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const icns = icnsOf([['ic07', fakePng('listed')]]);
  const listed = makeBundle(appsDir, 'Listed', { iconFile: 'AppIcon', icns });
  const unlisted = makeBundle(path.join(root, 'elsewhere'), 'Unlisted', { iconFile: 'AppIcon', icns });

  const { server, sessionToken, shutdown } = createAtlasServer({
    sandboxRoot: path.join(root, 'sandbox'),
    homeDir,
    platform: 'darwin',
    dataDir: path.join(root, 'data'),
    applicationDirs: [appsDir]
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = (bundlePath, token = sessionToken) =>
      fetch(`${url}/api/app/icon?bundlePath=${encodeURIComponent(bundlePath)}`, {
        headers: token ? { 'X-Atlas-Token': token } : {}
      });

    const ok = await get(listed);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), fakePng('listed'));

    assert.equal((await get(unlisted)).status, 404);
    assert.equal((await get('/etc/passwd')).status, 404);
    assert.equal((await get(listed, null)).status, 401);
  } finally {
    if (shutdown) await shutdown();
    else await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every artifact type has its own icon, and the site copy matches the app copy', () => {
  const icons = globalThis.AtlasIcons;
  const used = new Set();
  for (const type of Object.values(ArtifactType)) {
    const name = icons.forArtifactType(type);
    assert.ok(Array.isArray(icons.paths[name]) && icons.paths[name].length > 0, `icon for ${type}`);
    assert.ok(!used.has(name), `${type} shares the icon '${name}' with another type`);
    used.add(name);
  }
  for (const nodeType of ['WORKSPACE', 'SESSION', 'OPERATION', 'UNKNOWN_ORIGIN']) {
    assert.ok(icons.paths[icons.forNode({ nodeType })], `icon for ${nodeType}`);
  }
  assert.equal(icons.forApp({ name: 'Cursor' }), 'pointer');
  assert.equal(icons.forApp({ adapterId: 'codex-cli', name: 'Codex CLI' }), 'braces');
  assert.equal(icons.forApp({ adapterId: 'claude-code', name: 'Claude Code' }), 'terminal');
  assert.equal(icons.forApp({ name: 'NebulaSketch' }), 'app');
  // Known applications have a logo file to fall back on, in the app and on the site
  for (const [name, logo] of [['Claude', 'claudecode'], ['Cursor', 'cursor'], ['Ollama', 'ollama'], ['Zed', 'zedindustries']]) {
    assert.equal(icons.logoForApp({ name }), logo);
    assert.ok(fs.existsSync(path.resolve('src', 'ui', 'public', 'logos', `${logo}.svg`)), `${logo}.svg in the app`);
    assert.ok(fs.existsSync(path.resolve('site', 'logos', `${logo}.svg`)), `${logo}.svg on the site`);
  }
  assert.equal(icons.logoForApp({ name: 'NebulaSketch' }), null);
  assert.equal(icons.logoForApp({ name: 'Zedd Player' }), null);
  assert.match(icons.svg('log', 16), /^<svg[^>]+viewBox="0 0 24 24"/);

  assert.equal(
    fs.readFileSync(path.resolve('site', 'icons.js'), 'utf8'),
    fs.readFileSync(path.resolve('src', 'ui', 'public', 'icons.js'), 'utf8'),
    'site/icons.js must be an exact copy of src/ui/public/icons.js'
  );
});
