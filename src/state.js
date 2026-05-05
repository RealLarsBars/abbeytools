// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
window.players = []; window.tagMap = new Map(); window.matchLog = []; window.pollTimer = null;
window.announcedSetIds = new Set(); window.completedSetIds = new Set(); window.pollLogEntries = [];
// Tracks setIds we've already pinged Discord about for stream assignments,
// so external moves get pinged exactly once and our own moveToStream calls
// pre-populate this to avoid double-pings on the next poll.
window.streamAnnouncedSetIds = new Set();
// Tracks setIds we've already sent a "you're in the queue" ping for, so
// reordering or queue-state churn doesn't cause repeat pings.
window.queuePingedSetIds = new Set();
window.activeSetsData = []; window.pendingSetsData = []; window.allFetchedSets = [];
window.stationList = []; window.streamList = [];
window.hubCheckins = new Set();
window.recentlyAssignedLocs = new Map();
window.DQ_MINUTES = 5.5;

// Stream queues — per-stream ordered list of setIds waiting to go on stream.
// Pure client-side state (no API call until "Send to stream" promotes the head).
// Shape: { [streamId]: [setId, setId, ...] }
window.streamQueues = {};
// Tracks which streams have their "+ Add to queue" panel expanded
window._expandedAddQueues = new Set();
// Tracks when each stream first became empty (no active occupant). Shape: { [streamId]: timestamp }
window.streamEmptySince = {};

function loadStreamQueues() {
  try {
    const raw = localStorage.getItem('abbey_stream_queues');
    streamQueues = raw ? JSON.parse(raw) : {};
    if (typeof streamQueues !== 'object' || streamQueues === null) streamQueues = {};
  } catch { streamQueues = {}; }
  // Pre-mark all queue entries as already-pinged so the reconciliation pass in
  // cleanStreamQueues doesn't fire Discord pings for stale entries from a
  // previous session the first time their entrants resolve.
  for (const ids of Object.values(streamQueues)) {
    for (const id of ids) queuePingedSetIds.add(String(id));
  }
}
function saveStreamQueues() {
  try { localStorage.setItem('abbey_stream_queues', JSON.stringify(streamQueues)); } catch { }
}
loadStreamQueues();

// Stable slot ordering for hub cards — prevents layout shift
window._hubSlotIds = [];

window.$ = id => document.getElementById(id);
window.activeTimers = [];

function updateTimerCache() {
  activeTimers = Array.from(document.querySelectorAll('.dq-timer-display')).map(el => ({
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
  return Math.min(999, ...allFetchedSets.filter(s => [1, 2, 6].includes(s.state)).map(s => s.phaseGroup?.phase?.phaseOrder ?? 999));
}

function getDiscordMention(playerName) {
  const p = resolvePlayer(playerName);
  // When linked: ping the user AND show their start.gg tag in parens for clarity.
  // When not linked: just show the tag (no mention available).
  return p?.discordId ? `<@${p.discordId}> (${playerName})` : playerName;
}

try {
  hubCheckins = new Set(JSON.parse(localStorage.getItem('abbey_checkins') || '[]'));
} catch (e) { hubCheckins = new Set(); }

function saveCheckins() {
  localStorage.setItem('abbey_checkins', JSON.stringify([...hubCheckins]));
}

// Expose to window
Object.assign(window, {
  loadStreamQueues,
  saveStreamQueues,
  updateTimerCache,
  getEventField,
  getLowestIncompletePhase,
  getDiscordMention,
  saveCheckins,
});
