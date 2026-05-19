import { 
  renderLog, 
  resetMatch, 
  openScoreOverlay, 
  setScore, 
  closeScoreOverlay, 
  submitOverlayScore, 
  manualLinkPlayer, 
  unlinkPlayer 
} from './hub.js';
import { 
  loadSettings, 
  toggleSetup, 
  hubToggleWatch, 
  clearPhaseFilter, 
  saveSettings, 
  switchTab 
} from './ui.js';
import { 
  fetchManualSets, 
  renderManualSets, 
  callSetFromPanel, 
  toggleHubCheckin 
} from './manual.js';
import { 
  browseEvents, 
  loadPhaseGroups 
} from './api.js';
import { 
  markInProgressQuick, 
  closeConfirmModal, 
  requestDQ, 
  requestHubDQ, 
  pullFromStream, 
  copyPollLog 
} from './actions.js';
import { 
  fetchAndPopulateStreams, 
  savePriorityStream 
} from './streams.js';
import { 
  startPolling, 
  stopPolling 
} from './poll.js';
import { 
  addToStreamQueue, 
  removeFromStreamQueue, 
  clearAllQueues, 
  moveInStreamQueue, 
  promoteFromQueue, 
  toggleAddQueuePanel 
} from './queue.js';
import { 
  loadCSV 
} from './csv-handler.js';
import { state } from './state.js';

// Expose functions globally to support inline HTML event handlers in a bundler environment
Object.assign(window, {
  toggleSetup,
  loadCSV,
  saveSettings,
  browseEvents,
  fetchManualSets,
  fetchAndPopulateStreams,
  savePriorityStream,
  loadPhaseGroups,
  clearPhaseFilter,
  copyPollLog,
  switchTab,
  renderManualSets,
  startPolling,
  stopPolling,
  clearAllQueues,
  hubToggleWatch,
  setScore,
  submitOverlayScore,
  closeScoreOverlay,
  closeConfirmModal,
  toggleHubCheckin,
  requestDQ,
  callSetFromPanel,
  requestHubDQ,
  markInProgressQuick,
  openScoreOverlay,
  unlinkPlayer,
  manualLinkPlayer,
  addToStreamQueue,
  moveInStreamQueue,
  removeFromStreamQueue,
  promoteFromQueue,
  toggleAddQueuePanel,
  pullFromStream,
  resetMatch
});

try { loadSettings(); } catch (e) { console.error('loadSettings failed:', e); }
// Restore discord IDs from localStorage so page refresh doesn't wipe pings
try {
  const savedMap = JSON.parse(localStorage.getItem('abbey_discord_map') || '{}');
  for (const [tag, id] of Object.entries(savedMap)) {
    if (!state.tagMap.has(tag)) {
      const p = { tag, shortTag: tag, discordId: id };
      state.tagMap.set(tag, p);
    } else {
      state.tagMap.get(tag).discordId = id;
    }
  }
} catch (e) { }
try { renderLog(); } catch (e) { console.error('renderLog failed:', e); }