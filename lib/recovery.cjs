const fs = require('node:fs/promises');
const path = require('node:path');
const lockCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A Windows sharing violation is often brief. Do not turn permission failures
// into "missing", and never retry an unknown error indefinitely in an IO call.
async function retryIO(operation, { retries = 6, sleep: wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!lockCodes.has(error.code) || attempt >= retries) throw error;
      await wait(Math.min(1000, 50 * 2 ** attempt));
    }
  }
}
function inputError(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: cause?.code || 'INPUT_UNAVAILABLE', path: cause?.path, inputUnavailable: true });
}
async function inputOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (lockCodes.has(error.code) || error.code === 'ENOENT') error.inputUnavailable = true;
    throw error;
  }
}
async function logRecovery(root, event) {
  const folder = path.join(root, 'logs');
  await retryIO(() => fs.mkdir(folder, { recursive: true }));
  await retryIO(() => fs.appendFile(path.join(folder, 'reelsight_recovery.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'));
}
module.exports = { retryIO, lockCodes, inputError, inputOperation, logRecovery, sleep };
