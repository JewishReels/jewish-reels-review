const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.cjs'))
  .sort()
  .map(name => path.join('test', name));

if (!files.length) throw new Error('No test files were found.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
