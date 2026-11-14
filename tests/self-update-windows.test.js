import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRunningWindowsInstall,
  resolveWindowsInstallTarget,
  checkStagedWindowsPackage,
  windowsSwapScript,
  WINDOWS_INSTALL_ENTRIES
} from '../src/platform/self-update-windows.js';
import { releaseAssetUrls } from '../src/platform/self-update.js';

function makePackage(dir, { version = '0.8.0', name = 'artifact-atlas', withExe = true } = {}) {
  const write = (rel, content = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  if (withExe) write('ArtifactAtlas.exe', 'MZ');
  write(path.join('runtime', 'node.exe'), 'MZ');
  write(path.join('app', 'src', 'cli.js'), '// cli');
  write(path.join('app', 'src', 'ui', 'server.js'), '// server');
  write(path.join('app', 'package.json'), JSON.stringify({ name, version }));
  return dir;
}

test('WU1. Windows updater: the running install, the install target and the checks that stand in for a signature', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-winupd-')));
  try {
    const install = makePackage(path.join(root, 'ArtifactAtlas'));
    assert.equal(findRunningWindowsInstall(path.join(install, 'app', 'src', 'ui', 'server.js')), install);
    assert.equal(findRunningWindowsInstall(path.join(root, 'basket', 'src', 'ui', 'server.js')), null, 'run from source');

    assert.deepEqual(resolveWindowsInstallTarget({ installDir: install, localAppData: path.join(root, 'local') }), {
      ok: true, reason: null, targetPath: install, relocates: false
    });
    assert.equal(resolveWindowsInstallTarget({ installDir: null }).reason, 'NOT_PACKAGED');

    assert.equal(checkStagedWindowsPackage(install, '0.8.0'), install);
    assert.throws(() => checkStagedWindowsPackage(install, '0.9.0'), /UPDATE_VERSION_MISMATCH/);
    const other = makePackage(path.join(root, 'Other'), { name: 'something-else' });
    assert.throws(() => checkStagedWindowsPackage(other, '0.8.0'), /UPDATE_PACKAGE_NAME_MISMATCH/);
    const partial = makePackage(path.join(root, 'Partial'), { withExe: false });
    assert.throws(() => checkStagedWindowsPackage(partial, '0.8.0'), /UPDATE_PACKAGE_INCOMPLETE/);

    assert.equal(releaseAssetUrls('v0.8.0', 'ArtifactAtlas-Windows.zip').zipUrl, 'https://github.com/yazicmert/basket/releases/download/v0.8.0/ArtifactAtlas-Windows.zip');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WU2. Windows swap helper: only the app\'s own entries, the previous ones kept until done', () => {
  const script = windowsSwapScript();
  assert.deepEqual(WINDOWS_INSTALL_ENTRIES, ['ArtifactAtlas.exe', 'runtime', 'app', 'README.txt', 'LICENSE.txt']);
  assert.match(script, /refusing: unexpected staged path/);
  assert.match(script, /refusing: the install folder does not hold Artifact Atlas/);
  // The old entries are moved aside before the copy, and moved back on failure
  assert.ok(script.indexOf('Move-Item -LiteralPath $Current') < script.indexOf('Copy-Item -LiteralPath $New'));
  assert.match(script, /catch \{[\s\S]*Move-Item -LiteralPath \(Join-Path \$Previous \$Entry\)/);
  // Removals stay inside the staging folder or replace one of the app's own entries
  const removals = script.match(/Remove-Item -LiteralPath [^\n]+/g) || [];
  for (const line of removals) {
    assert.ok(/^Remove-Item -LiteralPath (\$Previous|\$Target|\(Join-Path \$Staging '[^']+'\)) /.test(line), line);
  }
  assert.match(script, /update finished with status/);
});
