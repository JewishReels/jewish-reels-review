const { contextBridge, ipcRenderer } = require('electron');
const feedbackActions = ['feedback-reasons','save-hit-feedback','save-bulk-hit-feedback','get-learning','start-learning','stop-learning','set-lesson-active'];
const allowed = new Set(['bootstrap','choose-project','reopen-project','refresh-project','get-models','save-key','forget-key','choose-vimeo-cookies','save-vimeo-access','start-review','set-dispatch-mode','pause-review','hit-recheck-info','hit-recheck-results','start-hit-recheck','pause-hit-recheck','clear-hit-recheck','open-hit-recheck-report','image','match-image','result-detail','open-project-folder','open-review-logs','open-url','export','create-workspace','import-source','add-website-source','crawl-website','set-active-source','start-preparation','pause-preparation','set-auto-backfill','retry-preparation','sync-verdicts','cleanup-media','preview-prepared','get-criteria','save-criteria','reset-criteria']);
contextBridge.exposeInMainWorld('reelsight', {
  call: async (method, ...args) => {
    if (!allowed.has(method) && !feedbackActions.includes(method)) throw new Error('Unknown action.');
    const result = await ipcRenderer.invoke(method, ...args);
    if (!result.ok) throw new Error(result.error); return result.value;
  },
  onState: callback => ipcRenderer.on('review-state', (_e, data) => callback(data)),
  onLearning: callback => ipcRenderer.on('learning-state', (_e,data) => callback(data)),
  onLearningUpdated: callback => ipcRenderer.on('learning-updated', () => callback()),
  onHitRecheck: callback => ipcRenderer.on('hit-recheck-state', (_e,data) => callback(data)),
  onVerdict: callback => ipcRenderer.on('new-verdict', (_e, data) => callback(data)),
  onPreparation: callback => ipcRenderer.on('prepare-state', (_e, data) => callback(data)),
  onProject: callback => ipcRenderer.on('project-updated', (_e, data) => callback(data))
});
