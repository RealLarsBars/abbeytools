export const state = {
  players: [], tagMap: new Map(), matchLog: [], pollTimer: null,
  announcedSetIds: new Set(), completedSetIds: new Set(), pollLogEntries: [],
  streamAnnouncedSetIds: new Set(), queuePingedSetIds: new Set(),
  activeSetsData: [], pendingSetsData: [], allFetchedSets: [],
  stationList: [], streamList: [], hubCheckins: new Set(),
  recentlyAssignedLocs: new Map(), DQ_MINUTES: 5.5,
  streamQueues: {}, _expandedAddQueues: new Set(), streamEmptySince: {},
  _hubSlotIds: [], activeTimers: []
};
// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────


// Tracks setIds we've already pinged Discord about for stream assignments,
// so external moves get pinged exactly once and our own moveToStream calls
// pre-populate this to avoid double-pings on the next poll.

// Tracks setIds we've already sent a "you're in the queue" ping for, so
// reordering or queue-state churn doesn't cause repeat pings.







// Stream queues — per-stream ordered list of setIds waiting to go on stream.
// Pure client-side state (no API call until "Send to stream" promotes the head).
// Shape: { [streamId]: [setId, setId, ...] }

// Tracks which streams have their "+ Add to queue" panel expanded

// Tracks when each stream first became empty (no active occupant). Shape: { [streamId]: timestamp }


function loadStreamQueues() {
  try {
    const raw = localStorage.getItem('abbey_stream_queues');
    state.streamQueues = raw ? JSON.parse(raw) : {};
    if (typeof state.streamQueues !== 'object' || state.streamQueues === null) state.streamQueues = {};
  } catch { state.streamQueues = {}; }
  // Pre-mark all queue entries as already-pinged so the reconciliation pass in
  // cleanStreamQueues doesn't fire Discord pings for stale entries from a
  // previous session the first time their entrants resolve.
  for (const ids of Object.values(state.streamQueues)) {
    for (const id of ids) state.queuePingedSetIds.add(String(id));
  }
}
function saveStreamQueues() {
  try { localStorage.setItem('abbey_stream_queues', JSON.stringify(state.streamQueues)); } catch { }
}
loadStreamQueues();

// Stable slot ordering for hub cards — prevents layout shift


import { resolvePlayer } from './api.js';
export let discordOverrides = {};
export function saveOverrides() { localStorage.setItem('abbey_discord_overrides', JSON.stringify(discordOverrides)); }
export const $ = id => document.getElementById(id);


function updateTimerCache() {
  state.activeTimers = Array.from(document.querySelectorAll('.dq-timer-display')).map(el => ({
    el,
    callTime: parseInt(el.dataset.time, 10)
  })).filter(t => t.callTime);
}

function getEventField() {
  const event = $('sggEvent')?.value.trim() || localStorage.getItem('abbey_sgg_event');
  if (!event) return null;
  return /^\d+$/.test(event) ? `event(id: ${event})` : `event(slug: "${event}")`;
}

function getLowestIncompletePhase() {
  return Math.min(999, ...state.allFetchedSets.filter(s => [1, 2, 6].includes(s.state)).map(s => s.phaseGroup?.phase?.phaseOrder ?? 999));
}

function getDiscordMention(playerName) {
  const p = resolvePlayer(playerName);
  // When linked: ping the user AND show their start.gg tag in parens for clarity.
  // When not linked: just show the tag (no mention available).
  return p?.discordId ? `<@${p.discordId}> (${playerName})` : playerName;
}

try {
  state.hubCheckins = new Set(JSON.parse(localStorage.getItem('abbey_checkins') || '[]'));
} catch (e) { state.hubCheckins = new Set(); }

function saveCheckins() {
  localStorage.setItem('abbey_checkins', JSON.stringify([...state.hubCheckins]));
}

// Expose to window
export { 
  loadStreamQueues,
  saveStreamQueues,
  updateTimerCache,
  getEventField,
  getLowestIncompletePhase,
  getDiscordMention,
  saveCheckins,
 };
