import { renderLog } from './hub.js';
import { loadSettings } from './ui.js';
import { state } from './state.js';

import './state.js';
import './ui.js';
import './api.js';
import './discord.js';
import './actions.js';
import './streams.js';
import './poll.js';
import './manual.js';
import './queue.js';
import './hub.js';
import './csv-handler.js';

// (initDropZone moved to csv-handler.js)

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
} catch (e) { /* ignore */ }
try { renderLog(); } catch (e) { console.error('renderLog failed:', e); }