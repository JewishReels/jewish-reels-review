const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function hash(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function main() {
  const source = path.resolve(__dirname, '..');
  const output = path.resolve(source, '../../outputs');
  const productName = 'Jewish Reels';
  const packageName = `${productName}-${require('../package.json').version}`;
  const target = path.join(output, `${packageName}-win32-x64`);
  if (path.dirname(target) !== output) throw new Error('Unexpected package destination.');
  if (process.platform === 'win32') {
    const processes = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process -Name 'Jewish Reels*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"], { windowsHide: true, encoding: 'utf8' });
    if (processes.split(/\r?\n/).some(p => p.trim() && path.dirname(path.resolve(p.trim())).toLowerCase() === target.toLowerCase())) throw new Error('Close this Jewish Reels version before rebuilding its application folder.');
  }
  const { packager } = await import('@electron/packager');
  const folders = await packager({ dir: source, name: packageName, platform: 'win32', arch: 'x64', out: output, icon: path.join(source,'assets/icon.ico'), overwrite: true,
    // Windows loads native dependencies from disk; DLLs must sit beside their .node bindings.
    asar: { unpack: '**/*.{node,dll}' },
    extraResource: [path.resolve(source,'../package-resources/media-tools')], ignore: [/^\/\.theme-check-userdata(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/test(?:\/|$)/, /^\/package-lock\.json$/, /^\/ui\/frame-filter\.(?:js|css)$/, /^\/lib\/(?:frame-filter-worker|people-scoring|people-view-policy)\.cjs$/, /^\/node_modules\/(?:@huggingface|onnxruntime(?:-|\/)|sharp\/node_modules\/onnxruntime)(?:\/|$)/] });
  // Keep the publicly distributed runtime executable byte-for-byte unchanged.
  // App code and branding live in resources and the Electron window/shortcut.
  // Changing native EXE resources creates a new binary with no cloud reputation.
  const runtime = path.join(source,'node_modules/electron/dist/electron.exe');
  const expectedHash = await hash(runtime);
  for (const folder of folders) {
    if (path.resolve(folder) !== target) throw new Error('Packager returned an unexpected destination.');
    const exe = path.join(folder,`${productName}.exe`);
    await fs.rename(path.join(folder,`${packageName}.exe`), exe);
    await fs.copyFile(runtime, exe);
    await fs.copyFile(path.join(source,'assets/icon.ico'),path.join(folder,`${productName}.ico`));
    if (await hash(exe) !== expectedHash) throw new Error('Runtime copy failed verification.');
    await fs.writeFile(path.join(folder,'runtime-provenance.json'), JSON.stringify({ runtime: 'Electron', version: require('electron/package.json').version, sha256: expectedHash, executable_resources_modified: false, windows_security_settings_changed: false },null,2)+'\n');
  }
  console.log(`Packaged Jewish Reels with the original Electron runtime (${expectedHash}).`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
