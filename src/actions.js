import { fetchManualSets } from './manual.js';
import { renderLog, toast } from './hub.js';
import { sggQuery } from './api.js';
import { getPlaceholderStationIds } from './queue.js';
import { buildStreamMovePing, sendWebhook } from './discord.js';
import { saveCheckins, getDiscordMention, state } from './state.js';

// Actions
// ─────────────────────────────────────────────────────────────
async function markInProgressQuick(setId, silent = false) {
  try {
    await sggQuery(`mutation { markSetInProgress(setId: "${setId}") { id state } }`);
    if (!silent) toast('▶ Set in progress');
    await fetchManualSets();
  } catch (e) { if (!silent) toast(`✗ ${e.message}`, true); }
}

// ─────────────────────────────────────────────────────────────
// Confirmation Modal
// ─────────────────────────────────────────────────────────────
// Shows a modal with custom buttons. Each button is { label, sublabel?, onClick, variant }.
// variant: 'danger' | 'primary' | 'info' | undefined (neutral)
function showConfirmModal({ title, message, buttons, variant = '' }) {
  const card = document.getElementById('confirmModalCard');
  card.classList.remove('danger', 'info', 'ok');
  if (variant === 'danger') card.classList.add('danger');
  else if (variant === 'info') card.classList.add('info');
  else if (variant === 'ok') card.classList.add('ok');

  document.getElementById('confirmModalTitle').textContent = title || '';
  document.getElementById('confirmModalMessage').innerHTML = message || '';

  const btnsContainer = document.getElementById('confirmModalBtns');
  btnsContainer.innerHTML = '';
  for (const btn of (buttons || [])) {
    const el = document.createElement('button');
    el.className = 'modal-btn' + (btn.variant ? ' ' + btn.variant : '');
    el.innerHTML = `${btn.icon ? `<span class="mb-icon">${btn.icon}</span>` : ''}<div style="flex:1;min-width:0;">${btn.label}${btn.sublabel ? `<span class="mb-sub">${btn.sublabel}</span>` : ''}</div>`;
    el.onclick = () => {
      closeConfirmModal();
      try { btn.onClick && btn.onClick(); } catch (e) { console.error(e); }
    };
    btnsContainer.appendChild(el);
  }

  document.getElementById('confirmModal').classList.add('show');
}

function closeConfirmModal() {
  document.getElementById('confirmModal').classList.remove('show');
}

// Close modal on backdrop click
document.getElementById('confirmModal').addEventListener('click', e => {
  if (e.target.id === 'confirmModal') closeConfirmModal();
});
// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('confirmModal').classList.contains('show')) {
    closeConfirmModal();
  }
});

// ─── DQ Confirmation: opens modal instead of inline "Sure?" ───
// Used by manual sets DQ buttons. winnerId/loserId already determined
// (clicking DQ on player A means A loses, B wins).
function requestDQ(setId, winnerId, loserId, winnerName, loserName) {
  showConfirmModal({
    title: '⚠️ Confirm DQ',
    message: `DQ <strong>${loserName}</strong>? <strong>${winnerName}</strong> will advance.`,
    variant: 'danger',
    buttons: [
      {
        label: `Yes, DQ ${loserName}`,
        sublabel: `${winnerName} advances`,
        variant: 'danger',
        icon: '🚫',
        onClick: () => submitDQ(setId, winnerId, loserId, winnerName, false),
      },
    ],
  });
}

// ─── Hub Timer-Expired: lets TO choose who to DQ when neither/one checked in ───
function requestHubDQ(setId) {
  const set = state.activeSetsData.find(s => String(s.id) === String(setId)) || state.pendingSetsData.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }
  const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
  const nA = set.slots[0]?.entrant?.name || 'Player 1', nB = set.slots[1]?.entrant?.name || 'Player 2';
  const hasA = state.hubCheckins.has(`${set.id}-${idA}`), hasB = state.hubCheckins.has(`${set.id}-${idB}`);

  // Build button list — TO always gets to choose, no automatic seed-based pick.
  const buttons = [
    {
      label: `DQ ${nA}`,
      sublabel: hasA ? `${nA} IS checked in — confirm anyway?` : `${nA} not checked in · ${nB} advances`,
      variant: 'danger',
      icon: '🚫',
      onClick: () => submitDQ(set.id, idB, idA, nB, false),
    },
    {
      label: `DQ ${nB}`,
      sublabel: hasB ? `${nB} IS checked in — confirm anyway?` : `${nB} not checked in · ${nA} advances`,
      variant: 'danger',
      icon: '🚫',
      onClick: () => submitDQ(set.id, idA, idB, nA, false),
    },
  ];

  // If both are checked in, offer to start the set instead of DQ'ing
  if (hasA && hasB) {
    buttons.push({
      label: 'Start the set',
      sublabel: 'Both state.players checked in',
      variant: 'primary',
      icon: '▶️',
      onClick: () => markInProgressQuick(set.id),
    });
  }

  let context = '';
  if (!hasA && !hasB) context = '<strong style="color:var(--accent2)">Neither player checked in.</strong> Choose who to DQ.';
  else if (!hasA) context = `<strong>${nA}</strong> is missing. <strong>${nB}</strong> is checked in.`;
  else if (!hasB) context = `<strong>${nB}</strong> is missing. <strong>${nA}</strong> is checked in.`;
  else context = 'Both state.players are checked in. You can DQ someone manually or start the set.';

  showConfirmModal({
    title: '⏱ Timer Expired',
    message: context,
    variant: 'danger',
    buttons,
  });
}

// ─────────────────────────────────────────────────────────────
// Move to Stream — with confirmation modal
// ─────────────────────────────────────────────────────────────
async function moveToStream(setId, streamId, streamName) {
  const set = state.activeSetsData.find(s => String(s.id) === String(setId)) || state.allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }

  // Track the freed station (if any) so the venue dashboard can immediately
  // show it as available
  const previousStationId = set.station?.id;

  // Mark this assignment as already announced — the next poll will see the
  // stream assignment in start.gg's data and we don't want to double-ping.
  state.streamAnnouncedSetIds.add(String(setId));

  try {
    await sggQuery(`mutation { assignStream(setId: "${setId}", streamId: "${streamId}") { id } }`);
    // start.gg keeps the station assignment around when you assign a stream;
    // we treat any set with both as "on stream, station free" via
    // updateVenueDashboardUI's busy-id logic. Locally clear so the UI matches.
    set.stream = { id: streamId, streamName: streamName };

    // Lock the new stream so it doesn't double-book
    state.recentlyAssignedLocs.set(String(streamId), Date.now());
    // Free the previously locked station (if any)
    if (previousStationId) state.recentlyAssignedLocs.delete(String(previousStationId));

    const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
    const mA = getDiscordMention(nA), mB = getDiscordMention(nB);

    const ping = buildStreamMovePing({ mA, mB, streamLabel: streamName, roundText: set.fullRoundText });
    await sendWebhook(ping.content);

    addPollLog(`${ping.shiny ? '✨ SHINY' : '📺'} Moved to stream: ${nA} vs ${nB} → 🎥 ${streamName}`, 'new');
    toast(`📺 Moved to ${streamName}`);
    if (ping.shiny) toast('✨ SHINY STREAM PROMOTION! 1/8192');

    // Re-render everything that depends on stream/station state
    fetchManualSets();
  } catch (e) {
    // Roll back the optimistic announce-marker so a future successful
    // assignment (manual retry or external) can still ping.
    state.streamAnnouncedSetIds.delete(String(setId));
    toast(`✗ Move to stream failed: ${e.message}`, true);
    addPollLog(`⚠️ moveToStream(${setId} → ${streamId}) failed: ${e.message}`, 'err');
  }
}

function requestMoveToStream(setId, streamId, streamName) {
  const set = state.activeSetsData.find(s => String(s.id) === String(setId)) || state.allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }

  const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
  const fromStation = set.station?.number ? `Station ${set.station.number}` : null;

  showConfirmModal({
    title: '📺 Move to Stream',
    message: `Move <strong>${nA} vs ${nB}</strong> to <strong>${streamName}</strong>?` +
      (fromStation ? `<br><br>This will free up <strong>${fromStation}</strong> and ping the state.players in Discord.`
        : '<br><br>Players will be pinged in Discord with the new location.'),
    variant: 'info',
    buttons: [
      {
        label: `Yes — move to ${streamName}`,
        sublabel: fromStation ? `Frees ${fromStation}` : 'Sends Discord ping',
        variant: 'info',
        icon: '🎥',
        onClick: () => moveToStream(setId, streamId, streamName),
      },
    ],
  });
}

// ─── Pull from stream: removes a set from a stream slot (sends back to station) ───
async function pullFromStream(setId) {
  const set = state.activeSetsData.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }
  const streamName = set.stream?.streamName || 'stream';

  showConfirmModal({
    title: '⏏ Remove from Stream',
    message: `Pull <strong>${set.slots[0]?.entrant?.name || '?'} vs ${set.slots[1]?.entrant?.name || '?'}</strong> off <strong>${streamName}</strong>?<br><br>The set will return to its original station${set.station?.number ? ` (<strong>Station ${set.station.number}</strong>)` : ''}.`,
    variant: 'danger',
    buttons: [
      {
        label: `Yes — pull from ${streamName}`,
        variant: 'danger',
        icon: '⏏',
        onClick: async () => {
          try {
            // Re-assign to the original station to clear the stream.
            // start.gg's API doesn't have a clean unassign; the cleanest
            // approach is to re-call assignStation, which moves it back.
            if (set.station?.id) {
              await sggQuery(`mutation { assignStation(setId: "${setId}", stationId: "${set.station.id}") { id } }`);
              state.recentlyAssignedLocs.set(String(set.station.id), Date.now());
            }
            // Locally clear stream
            const oldStreamId = set.stream?.id;
            set.stream = null;
            if (oldStreamId) state.recentlyAssignedLocs.delete(String(oldStreamId));
            // Allow this set to be re-announced if it gets put back on stream later
            state.streamAnnouncedSetIds.delete(String(setId));
            toast('⏏ Pulled from stream');
            addPollLog(`⏏ Pulled set ${setId} from stream`, 'new');
            fetchManualSets();
          } catch (e) {
            toast(`✗ ${e.message}`, true);
          }
        },
      },
    ],
  });
}

async function submitDQ(setId, winnerId, loserId, winnerName, auto = false) {
  if (state.completedSetIds.has(String(setId))) return;
  state.completedSetIds.add(String(setId));
  try {
    await sggQuery(`mutation DQSet { reportBracketSet(setId: "${setId}", winnerId: "${winnerId}", isDQ: true) { id state } }`);
    state.announcedSetIds.delete(String(setId));
    state.hubCheckins.delete(`${setId}-${winnerId}`); state.hubCheckins.delete(`${setId}-${loserId}`); saveCheckins();
    // Leave state._hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = state.matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }
    addPollLog(auto ? `⚡ AUTO-DQ — ${winnerName} advances` : `✓ DQ — ${winnerName} wins`, 'err');
    toast(`✓ DQ: ${winnerName} wins`);
    await fetchManualSets();
  } catch (e) { state.completedSetIds.delete(String(setId)); toast(`✗ DQ failed: ${e.message}`, true); }
}

async function reportFullScore(setId, idA, idB, nameA, nameB, prefix = "") {
  const scoreA = parseInt(document.getElementById(`${prefix}scoreA-${setId}`).value) || 0;
  const scoreB = parseInt(document.getElementById(`${prefix}scoreB-${setId}`).value) || 0;
  if (scoreA === scoreB) { toast("Scores cannot be tied", true); return; }
  const winnerId = scoreA > scoreB ? idA : idB;
  const winnerName = scoreA > scoreB ? nameA : nameB;
  let gameData = [], g = 1;
  for (let i = 0; i < scoreA; i++) gameData.push(`{winnerId: "${idA}", gameNum: ${g++}}`);
  for (let i = 0; i < scoreB; i++) gameData.push(`{winnerId: "${idB}", gameNum: ${g++}}`);
  try {
    await sggQuery(`mutation { reportBracketSet(setId: "${setId}", winnerId: "${winnerId}", gameData: [${gameData.join(',')}]) { id state } }`);
    toast(`🏆 Reported: ${winnerName} wins!`);
    state.completedSetIds.add(String(setId)); state.announcedSetIds.delete(String(setId));
    state.hubCheckins.delete(`${setId}-${idA}`); state.hubCheckins.delete(`${setId}-${idB}`); saveCheckins();
    // Leave state._hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = state.matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }
    fetchManualSets();
  } catch (e) { toast(`✗ ${e.message}`, true); }
}

async function enforceAutoDQManual(setId) {
  const set = state.activeSetsData.find(s => String(s.id) === String(setId)) || state.pendingSetsData.find(s => String(s.id) === String(setId));
  if (!set) return;
  const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
  const nA = set.slots[0]?.entrant?.name || 'Player 1', nB = set.slots[1]?.entrant?.name || 'Player 2';
  const seedA = set.slots[0]?.seed?.seedNum || 9999, seedB = set.slots[1]?.seed?.seedNum || 9999;
  const hasA = state.hubCheckins.has(`${set.id}-${idA}`), hasB = state.hubCheckins.has(`${set.id}-${idB}`);
  let winId, loseId, winName;
  if (!hasA && !hasB) {
    if (seedA > seedB) { winId = idB; loseId = idA; winName = nB; }
    else { winId = idA; loseId = idB; winName = nA; }
  } else if (!hasA) { winId = idB; loseId = idA; winName = nB; }
  else { winId = idA; loseId = idB; winName = nA; }

  await submitDQ(set.id, winId, loseId, winName, false);
}

// ─────────────────────────────────────────────────────────────
// Poll log + venue dashboard
// ─────────────────────────────────────────────────────────────
function addPollLog(msg, type = '') {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.pollLogEntries.unshift({ time, msg, type });
  if (state.pollLogEntries.length > 200) state.pollLogEntries.pop();
  const el = document.getElementById('pollLog');
  if (el) el.innerHTML = state.pollLogEntries.map(e => `<div class="entry ${e.type}">[${e.time}] ${e.msg}</div>`).join('');
}

function copyPollLog() {
  const text = state.pollLogEntries.map(e => `[${e.time}] ${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Log copied to clipboard!'));
}

// Strip the "SPONSOR | " prefix from an entrant name for compact log lines.
// Falls back to the CSV's Short GamerTag if loaded, else the substring after
// the last `|`. Returns '???' for empty/missing names.
function compactName(name) {
  if (!name) return '???';
  const player = (typeof state.tagMap !== 'undefined' && state.tagMap.get)
    ? state.tagMap.get(String(name).toLowerCase())
    : null;
  if (player?.shortTag) return player.shortTag;
  const parts = String(name).split('|').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || String(name);
}

// Render a one-line summary of a set: "Haiku/shoe(R3)" — short tags + round.
function compactSet(set) {
  if (!set) return '?';
  const a = compactName(set.slots?.[0]?.entrant?.name);
  const b = compactName(set.slots?.[1]?.entrant?.name);
  // Strip "Winners "/"Losers " prefix and roman-numeral noise to keep round
  // tags short. "Winners Round 3" -> "WR3", "Losers Quarter-Final" -> "LQF".
  const round = (set.fullRoundText || '')
    .replace(/Winners\s+/i, 'W')
    .replace(/Losers\s+/i, 'L')
    .replace(/Round\s+/i, 'R')
    .replace(/Quarter-?Final/i, 'QF')
    .replace(/Semi-?Final/i, 'SF')
    .replace(/Grand\s*Final(?:\s*Reset)?/i, m => /reset/i.test(m) ? 'GFR' : 'GF')
    .replace(/\s+/g, '')
    .slice(0, 6);
  return round ? `${a}/${b}(${round})` : `${a}/${b}`;
}

// Build the per-cycle state snapshot: 3 lines (streams, stations, tracked sets).
// Returns an array of strings ready to feed to addPollLog. Designed to fit
// what start.gg sent us THIS poll, before any of the poll's mutations run.
function buildPollSnapshot(allSets, freeLocs) {
  const active = allSets.filter(s => s.state === 2 || s.state === 6);

  // 🎬 Per-stream view: who's live and what's queued
  const streamParts = state.state.state.streamList.map(stream => {
    const sid = String(stream.id);
    const live = active.filter(s => String(s.stream?.id) === sid);
    const liveLabel = live.length
      ? live.map(s => `${s.state === 2 ? '▶' : '⏸'}${compactSet(s)}`).join(',')
      : '—';
    const queue = state.streamQueues[sid] || [];
    const queueLabel = queue.length
      ? queue.map(setId => compactSet(allSets.find(x => String(x.id) === String(setId)))).join(',')
      : '—';
    return `${stream.streamName}[live:${liveLabel} · queue:${queueLabel}]`;
  });
  const streamsLine = streamParts.length
    ? `🎬 ${streamParts.join(' ')}`
    : `🎬 (no streams configured)`;

  // 🏟 Per-station view: occupied stations with names, plus free station numbers
  const stnByNum = new Map();
  for (const s of active) {
    if (s.station?.number && !s.stream?.id) {
      stnByNum.set(s.station.number, compactSet(s));
    }
  }
  const occupied = [...stnByNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([num, label]) => `${num}:${label}`)
    .join(' · ');
  const freeStnNums = freeLocs
    .filter(l => l.type === 'station')
    .map(l => l.sortIdx)
    .sort((a, b) => a - b);
  const stationsLine = `🏟 ${occupied || '—'} (free:${freeStnNums.join(',') || 'none'})`;

  // 🧠 Tracking-set sizes — useful for spotting stuck/leaked entries
  const totalQueued = Object.values(state.streamQueues).reduce((n, q) => n + (q?.length || 0), 0);
  const trackedLine = `🧠 announced=${state.announcedSetIds.size} streamCalled=${state.streamAnnouncedSetIds.size} queuePinged=${state.queuePingedSetIds.size} inQueues=${totalQueued} completed=${state.completedSetIds.size}`;

  return [streamsLine, stationsLine, trackedLine];
}

function updateVenueDashboardUI(allSets) {
  // Stations that are reserved as stream placeholders are NEVER shown as
  // free locations, never auto-assigned, and never count toward "free
  // stations" UI. They exist only as the destination for sets that get
  // moved to a stream.
  const placeholderIds = getPlaceholderStationIds();
  const allLocs = [
    ...stationList
      .filter(s => !placeholderIds.has(String(s.id)))
      .map(s => ({ id: s.id, type: 'station', label: `Station ${s.number}`, sortIdx: s.number })),
    ...state.state.streamList.map((s, i) => ({ id: s.id, type: 'stream', label: `🎥 ${s.streamName}`, sortIdx: -1000 + i }))
  ];
  const activeSets = allSets.filter(s => (s.state === 2 || s.state === 6) && (s.station || s.stream));

  // KEY RULE: If a set has BOTH a station and a stream, treat it as on-stream
  // and consider the station FREE. This is how "move to stream" frees up
  // the station even though start.gg keeps the station assignment around.
  const busyIds = new Set();
  for (const s of activeSets) {
    if (s.stream?.id) {
      busyIds.add(String(s.stream.id));
      // intentionally do not add s.station.id — promoting to stream frees the station
    } else if (s.station?.id) {
      busyIds.add(String(s.station.id));
    }
  }

  // Shield recently assigned locations from being double-booked by stale API responses
  const now = Date.now();
  for (const [locId, timestamp] of state.recentlyAssignedLocs.entries()) {
    if (now - timestamp < 180000) { // 3 minutes protection
      busyIds.add(String(locId));
    } else {
      state.recentlyAssignedLocs.delete(locId); // cleanup old locks
    }
  }

  const freeLocs = allLocs.filter(loc => !busyIds.has(String(loc.id))).sort((a, b) => a.sortIdx - b.sortIdx);

  const activeListEl = document.getElementById('vActiveList');
  if (activeListEl) activeListEl.innerHTML = activeSets.length ? activeSets.map(s => {
    // When both are set, label as the stream (the station has been freed)
    const onStream = !!s.stream?.id;
    const locLabel = onStream
      ? `🎥 ${s.stream.streamName}`
      : (s.station?.number ? `Station ${s.station.number}` : '');
    return `<div class="v-match"><span class="stn-num" style="${onStream ? 'color:var(--blue)' : ''}">${locLabel}</span> ${s.slots[0]?.entrant?.name || '?'} vs ${s.slots[1]?.entrant?.name || '?'}</div>`;
  }).join('') : '<div style="font-size:0.75rem;color:var(--muted)">No sets currently assigned</div>';
  const freeListEl = document.getElementById('vFreeList');
  if (freeListEl) freeListEl.innerHTML = freeLocs.length ? freeLocs.map(loc => `<span class="stn-pill" style="${loc.type === 'stream' ? 'border-color:var(--blue);color:var(--blue)' : ''}">${loc.label}</span>`).join('') : '<div style="font-size:0.75rem;color:var(--accent2)">All locations are occupied</div>';

  return { activeSets, freeLocs };
}

// Expose to window
export { 
  markInProgressQuick,
  showConfirmModal,
  closeConfirmModal,
  requestDQ,
  requestHubDQ,
  moveToStream,
  requestMoveToStream,
  pullFromStream,
  submitDQ,
  reportFullScore,
  enforceAutoDQManual,
  addPollLog,
  copyPollLog,
  compactName,
  compactSet,
  buildPollSnapshot,
  updateVenueDashboardUI,
 };
