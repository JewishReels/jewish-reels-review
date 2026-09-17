const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'ui', 'index.html');
const capturePage = path.join(root, 'ui', '.readme-capture.html');
const captureDemo = path.join(root, 'ui', '.readme-demo.js');
const captureEvidence = path.join(root, 'ui', '.readme-evidence.png');
const output = path.join(root, 'docs', 'screenshots');
const socialPreview = path.join(root, 'docs', 'social-preview.png');
const profileRoot = path.join(root, '.theme-check-userdata', 'readme-edge');
const edgeCandidates = [
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
];
const edge = edgeCandidates.find(candidate => fs.existsSync(candidate));
if (!edge) throw new Error('Microsoft Edge is required to render documentation screenshots on Windows.');

fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(profileRoot, { recursive: true });
const html = fs.readFileSync(source, 'utf8').replace(
  '<script src="model-capabilities.js"></script>',
  '<script src=".readme-demo.js"></script><script src="model-capabilities.js"></script>'
);
fs.writeFileSync(capturePage, html);
fs.copyFileSync(path.join(root, 'scripts', 'readme-demo.js'), captureDemo);

const pageUrl = new URL(`file:///${capturePage.replaceAll('\\', '/')}`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function capture(name, hash) {
  const destination = path.join(output, `${name}.png`);
  const profile = path.join(profileRoot, name);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(destination, { force: true });
  const child = spawn(edge, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--in-process-gpu',
    '--disable-software-rasterizer', '--disable-gpu-compositing', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1600,1000', '--virtual-time-budget=4000', `--user-data-dir=${profile}`,
    `--screenshot=${destination}`, `${pageUrl.href}${hash}`
  ], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (!fs.existsSync(destination) || fs.statSync(destination).size === 0)) await sleep(150);
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  else child.kill('SIGKILL');
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    throw new Error(`Could not capture ${name} within 15 seconds.`);
  }
}

async function createSocialPreview() {
  const hero = await sharp(path.join(output, 'footage-preparation.png'))
    .resize(800, 640, { fit: 'cover', position: 'left' })
    .png()
    .toBuffer();
  const icon = await sharp(path.join(root, 'assets', 'icon.png'))
    .resize(104, 104)
    .png()
    .toBuffer();
  const copy = Buffer.from(`
    <svg width="1280" height="640" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#f4eee2" stop-opacity="1"/>
          <stop offset="1" stop-color="#f4eee2" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="480" height="640" fill="#f4eee2"/>
      <rect x="480" width="110" height="640" fill="url(#edge)"/>
      <rect x="64" y="211" width="72" height="5" rx="2.5" fill="#b98a3e"/>
      <text x="64" y="282" fill="#1d150d" font-family="Georgia, serif" font-size="62" font-weight="700">Jewish Reels</text>
      <text x="64" y="342" fill="#493d31" font-family="Arial, sans-serif" font-size="29">
        <tspan x="64" dy="0">Find and review Jewish</tspan>
        <tspan x="64" dy="39">visual history in archival</tspan>
        <tspan x="64" dy="39">footage.</tspan>
      </text>
      <text x="64" y="566" fill="#6b5b4a" font-family="Arial, sans-serif" font-size="19" letter-spacing="0.4">WINDOWS DESKTOP APPLICATION</text>
      <text x="64" y="599" fill="#5f7d64" font-family="Arial, sans-serif" font-size="21" font-weight="700">jewishreels.com</text>
    </svg>`);
  await sharp({ create: { width: 1280, height: 640, channels: 4, background: '#f4eee2' } })
    .composite([
      { input: hero, left: 480, top: 0 },
      { input: copy, left: 0, top: 0 },
      { input: icon, left: 64, top: 72 }
    ])
    .png({ compressionLevel: 9 })
    .toFile(socialPreview);
}

async function main() {
  try {
    const demoSource = fs.readFileSync(path.join(root, 'scripts', 'readme-demo.js'), 'utf8');
    const svg = demoSource.match(/const syntheticSheet = String\.raw`([\s\S]*?)`;/)?.[1];
    if (!svg) throw new Error('Synthetic screenshot artwork was not found.');
    await sharp(Buffer.from(svg)).png().toFile(captureEvidence);
    for (const [name, hash] of [['footage-preparation', ''], ['visual-review', '#review'], ['review-matches', '#matches']]) await capture(name, hash);
    await createSocialPreview();
    console.log(`Wrote 3 privacy-safe screenshots and ${path.relative(root, socialPreview)}`);
  } finally {
    fs.rmSync(capturePage, { force: true });
    fs.rmSync(captureDemo, { force: true });
    fs.rmSync(captureEvidence, { force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
