const os = require('node:os');

const SOURCE_CONCURRENCY_MAX = 12;
const EXTRACTION_CONCURRENCY_MAX = 4;
const SLOT_RESERVE_GB = 0.25;
const STORAGE_HEADROOM_GB = 0.5;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function preparationLimits(load = {}, maxGB = 20, parallelism = os.availableParallelism?.() || os.cpus().length) {
  const requestedSources = Math.min(16, positiveInteger(load.videoConcurrency, 1));
  const storageGB = Number(maxGB);
  const usableStorageGB = Number.isFinite(storageGB) && storageGB > 0 ? storageGB : 20;
  // Leave a fixed publication/cleanup margin, then reserve one additional
  // 256-MiB slot beyond the workers admitted below. This is a heuristic for
  // ordinary screener files; the live storage guard remains the hard backstop.
  const storageSlots = Math.max(1, Math.floor((usableStorageGB - STORAGE_HEADROOM_GB) / SLOT_RESERVE_GB) - 1);
  const sourceConcurrency = Math.max(1, Math.min(SOURCE_CONCURRENCY_MAX, requestedSources, storageSlots));
  // FFmpeg is itself multithreaded. Give each extraction roughly four logical
  // processors and keep a small absolute ceiling so downloads can overlap
  // without making the desktop unresponsive when several files finish at once.
  const logicalProcessors = positiveInteger(parallelism, 1);
  const extractionConcurrency = Math.max(1, Math.min(sourceConcurrency, EXTRACTION_CONCURRENCY_MAX, Math.floor(logicalProcessors / 4) || 1));
  return { sourceConcurrency, extractionConcurrency };
}

module.exports = { preparationLimits };
