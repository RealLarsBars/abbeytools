import { _overlayScoreA, _overlayScoreB, _overlayNameA, _overlayNameB } from './hub.js';
import { sggQuery } from './api.js';
import { getPlaceholderStationIds, renderStreamQueue } from './queue.js';
import { updateTimerCache, state, saveCheckins, getDiscordMention, $, getEventField } from './state.js';
import { closeScoreOverlay, toast, renderPlayerHub, submitOverlayScore, logMatch, setScore } from './hub.js';
import { buildCallPing, sendWebhook } from './discord.js';
import { updateVenueDashboardUI, markInProgressQuick } from './actions.js';
import { renderStreamSetupSelectors } from './streams.js';

// Manual Sets
// ─────────────────────────────────────────────────────────────
function formatWait(createdAt) {
  const mins = Math.floor((Date.now() / 1000 - createdAt) / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60), rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

async function fetchManualSets() {
  const eventField = getEventField();
  if (!eventField) { toast('No event selected', true); return; }
  const btn = $('fetchSetsBtn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const [setData, stationData, streamData] = await Promise.all([
      sggQuery(`query { ${eventField} { sets(page: 1, perPage: 100, filters: { state: [1,2,6] }) { nodes { id state fullRoundText createdAt updatedAt phaseGroup { id phase { id phaseOrder } } station { id number } stream { id streamName } slots { prereqType prereqId prereqPlacement seed { seedNum } entrant { id name } } } } } }`),
      sggQuery(`query { ${eventField} { tournament { streams { id streamName } stations(page: 1, perPage: 30) { nodes { id number } } } } }`).catch(() => null)
    ]);
    const allSets = setData?.data?.event?.sets?.nodes || [];
    state.allFetchedSets = allSets.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.activeSetsData = allSets.filter(s => s.state === 2 || s.state === 6);
    state.pendingSetsData = allSets.filter(s => s.state === 1 && s.slots?.[0]?.entrant?.id && s.slots?.[1]?.entrant?.id);
    if (stationData?.data?.event?.tournament) {
      const tourney = stationData.data.event.tournament;
      if (tourney.stations?.nodes) {
        state.stationList = tourney.stations.nodes.sort((a, b) => a.number - b.number);
      }
      if (tourney.streams) {
        state.streamList = tourney.streams || [];
      }
    }
    renderManualSets(); renderPlayerHub(); renderStreamQueue(); updateVenueDashboardUI(allSets); renderStreamSetupSelectors();
    if (btn) btn.textContent = 'Fetch ↓';
  } catch (e) {
    toast(`✗ ${e.message}`, true); if (btn) btn.textContent = 'Fetch ↓';
  } finally { if (btn) btn.disabled = false; }
}

function renderManualSets() {
  const el = document.getElementById('manualSetList');
  if (!el) return;
  const selectedStates = (document.getElementById('setFetchState')?.value || '1,2,6').split(',').map(Number);
  // Stations reserved as stream placeholders are excluded from the manual
  // assignment dropdown so a TO can't accidentally send a non-streamed match
  // to the stream station. Streams remain available in their own optgroup.
  const placeholderIds = getPlaceholderStationIds();
  const stationsForDropdown = state.stationList.filter(s => !placeholderIds.has(String(s.id)));
  // Sort by bracket stage (phaseOrder ascending) then by duration (oldest first)
  // For state 6 (called) and state 2 (in progress), use updatedAt as the call/start time
  // For state 1 (pending), use createdAt
  const toRender = state.allFetchedSets
    .filter(s => selectedStates.includes(s.state))
    .slice()
    .sort((a, b) => {
      const pA = a.phaseGroup?.phase?.phaseOrder ?? 999;
      const pB = b.phaseGroup?.phase?.phaseOrder ?? 999;
      if (pA !== pB) return pA - pB;
      const tA = (a.state === 6 || a.state === 2) ? (a.updatedAt || a.createdAt || 0) : (a.createdAt || 0);
      const tB = (b.state === 6 || b.state === 2) ? (b.updatedAt || b.createdAt || 0) : (b.createdAt || 0);
      return tA - tB; // oldest first → longest waiting/playing surfaces at top
    });
  if (!toRender.length) { el.innerHTML = '<div class="sets-empty">No sets match the current filter.</div>'; return; }
  el.innerHTML = toRender.map(set => {
    const a = set.slots[0]?.entrant, b = set.slots[1]?.entrant;
    const nameA = a?.name || '???', nameB = b?.name || '???';
    const ciA = state.hubCheckins.has(`${set.id}-${a?.id}`), ciB = state.hubCheckins.has(`${set.id}-${b?.id}`);
    // Prefer stream label when both are set (stream wins; station is freed)
    const onStream = !!set.stream?.streamName;
    const loc = onStream ? `🎥 ${set.stream.streamName}` : (set.station?.number ? `Station ${set.station.number}` : '');
    const isState6 = set.state === 6, isState2 = set.state === 2;
    const waitLabel = set.createdAt ? formatWait(set.createdAt) : '';
    let badgeHtml = '';
    if (isState2) badgeHtml = `<span class="set-called-badge" style="background:rgba(0,229,160,0.2);color:var(--accent);">▶ In Progress</span>`;
    else if (isState6) { const ct = set.updatedAt || set.createdAt || Math.floor(Date.now() / 1000); badgeHtml = `<span class="set-called-badge" style="background:var(--accent2);color:#fff;">⏱ <span class="dq-timer-display" data-time="${ct}">0:00</span></span>`; }
    return `<div class="set-card" id="setcard-${set.id}" style="${isState6 ? 'border-left:3px solid var(--accent2);' : isState2 ? 'border-left:3px solid var(--accent);' : ''}">
      <div class="set-header">
        <span class="set-round">${set.fullRoundText || 'Set'}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${waitLabel ? `<span style="font-family:'Space Mono',monospace;font-size:0.68rem;color:var(--muted);">${waitLabel}</span>` : ''}
          ${loc ? `<span class="set-station-badge"${onStream ? ' style="background:rgba(114,137,218,0.15);color:var(--blue);"' : ''}>${loc}</span>` : ''}
          ${badgeHtml}
        </div>
      </div>
      <div class="set-player-row">
        <span class="checkin-dot ${ciA ? 'yes' : 'no'}" onclick="toggleHubCheckin('${set.id}','${a?.id}','${nameA.replace(/'/g, "\\'")}')"></span>
        <span class="set-player-name">${nameA}</span>
        <div class="set-player-actions"><button class="act-btn dq" onclick="requestDQ('${set.id}', '${b?.id}', '${a?.id}', '${nameB.replace(/'/g, "\\'")}', '${nameA.replace(/'/g, "\\'")}')">DQ</button></div>
      </div>
      <div class="set-player-row">
        <span class="checkin-dot ${ciB ? 'yes' : 'no'}" onclick="toggleHubCheckin('${set.id}','${b?.id}','${nameB.replace(/'/g, "\\'")}')"></span>
        <span class="set-player-name">${nameB}</span>
        <div class="set-player-actions"><button class="act-btn dq" onclick="requestDQ('${set.id}', '${a?.id}', '${b?.id}', '${nameA.replace(/'/g, "\\'")}', '${nameB.replace(/'/g, "\\'")}')">DQ</button></div>
      </div>
      <div class="set-footer">
        <select id="stn-${set.id}" style="flex:1;font-size:0.78rem;">
          <option value="">No assignment</option>
          ${stationsForDropdown.length ? `<optgroup label="Stations">${stationsForDropdown.map(s => `<option value="station:${s.id}" data-num="${s.number}" ${set.station?.number == s.number ? 'selected' : ''}>Station ${s.number}</option>`).join('')}</optgroup>` : ''}
          ${state.streamList.length ? `<optgroup label="Streams">${state.streamList.map(s => `<option value="stream:${s.id}" data-name="${s.streamName}" ${set.stream?.id == s.id ? 'selected' : ''}>🎥 ${s.streamName}</option>`).join('')}</optgroup>` : ''}
        </select>
        <button class="set-call-btn" onclick="callSetFromPanel('${set.id}')">📢 Call</button>
      </div>
    </div>`;
  }).join('');
  updateTimerCache();
}

async function callSetFromPanel(setId) {
  const set = state.allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) return;
  const stnSelect = document.getElementById(`stn-${setId}`);
  const stnValue = stnSelect?.value || '';
  const selectedOpt = stnSelect?.selectedOptions?.[0];
  const isStation = stnValue.startsWith('station:'), isStream = stnValue.startsWith('stream:');
  try {
    let targetId = setId;
    const callRes = await sggQuery(`mutation { markSetCalled(setId: "${targetId}") { id state } }`);

    // Start.gg might have converted a "preview_" ID into a real numeric ID
    if (callRes?.data?.markSetCalled?.id) {
      targetId = callRes.data.markSetCalled.id;
    }

    // THEN assign the location using the updated ID
    if (isStation) {
      const sid = stnValue.replace('station:', '');
      await sggQuery(`mutation { assignStation(setId: "${targetId}", stationId: "${sid}") { id } }`);
      state.recentlyAssignedLocs.set(String(sid), Date.now()); // Locally lock the station
    }
    else if (isStream) {
      const sid = stnValue.replace('stream:', '');
      await sggQuery(`mutation { assignStream(setId: "${targetId}", streamId: "${sid}") { id } }`);
      state.recentlyAssignedLocs.set(String(sid), Date.now()); // Locally lock the stream
    }

    const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
    const locName = isStation ? `Station ${selectedOpt.dataset.num}` : isStream ? `🎥 ${selectedOpt.dataset.name}` : '?';
    const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
    const dTs = Math.floor((Date.now() + state.DQ_MINUTES * 60 * 1000) / 1000);
    const ping = buildCallPing({ mA, mB, loc: locName, roundText: set.fullRoundText, dqTimestamp: dTs });
    await sendWebhook(ping.content);

    state.announcedSetIds.add(String(targetId));
    if (targetId !== setId) state.announcedSetIds.add(String(setId));

    toast(`${ping.shiny ? '✨ SHINY ' : ''}📢 ${nA} vs ${nB}`);
    if (ping.shiny) toast('✨ SHINY PING! 1/8192 — go check Discord');
    logMatch(nA, nB, locName, 'manual', targetId, set.slots[0]?.seed?.seedNum, set.slots[1]?.seed?.seedNum, ping.shiny); fetchManualSets();
  } catch (e) { toast(`✗ ${e.message}`, true); }
}

// ─────────────────────────────────────────────────────────────
// Hub check-in
// ─────────────────────────────────────────────────────────────
async function toggleHubCheckin(setId, entrantId, name) {
  const key = `${setId}-${entrantId}`;
  if (state.hubCheckins.has(key)) state.hubCheckins.delete(key);
  else { state.hubCheckins.add(key); toast(`🟢 ${name} checked in!`); }
  saveCheckins();
  const set = state.activeSetsData.find(s => String(s.id) === String(setId)) || state.pendingSetsData.find(s => String(s.id) === String(setId));
  if (set && set.state === 6) {
    const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
    if (state.hubCheckins.has(`${setId}-${idA}`) && state.hubCheckins.has(`${setId}-${idB}`)) {
      // Re-render first so both checkmarks are visible, then transition after a short delay
      renderPlayerHub(); renderManualSets();
      toast('Both state.players checked in!');
      setTimeout(async () => {
        await markInProgressQuick(setId, true);
      }, 1200);
      return;
    }
  }
  renderPlayerHub(); renderManualSets();
}

// ─────────────────────────────────────────────────────────────
// Keyboard shortcut: "32Enter" fills scores and submits
// ─────────────────────────────────────────────────────────────
export export let _scoreKbdBuffer = ''; export export let _scoreKbdTimer = null;
export function setScoreKbdBuffer(val) { _scoreKbdBuffer = val; }
export function setScoreKbdTimer(val) { _scoreKbdTimer = val; }

document.addEventListener('keydown', e => {
  const overlay = document.getElementById('scoreOverlay');

  // Only intercept keys if the score overlay is actually open
  if (overlay && overlay.style.display === 'flex') {

    // If a number key is pressed
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      _scoreKbdBuffer += e.key;
      clearTimeout(_scoreKbdTimer);

      // First number sets Player A
      if (_scoreKbdBuffer.length === 1) {
        setScore('A', parseInt(_scoreKbdBuffer[0], 10));
      }
      // Second number sets Player B
      else if (_scoreKbdBuffer.length === 2) {
        setScore('B', parseInt(_scoreKbdBuffer[1], 10));
      }

      // Clear the buffer if they stop typing for 3 seconds
      _scoreKbdTimer = setTimeout(() => { _scoreKbdBuffer = ''; }, 3000);
    }

    // If Enter is pressed — submit if both scores set, or fill opponent 0 if only one set
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (_overlayScoreA !== null && _overlayScoreB !== null && _overlayScoreA !== _overlayScoreB) {
        submitOverlayScore();
        _scoreKbdBuffer = '';
      } else if (_overlayScoreA !== null && _overlayScoreB === null && _overlayScoreA > 0) {
        // "2 Enter" shortcut: single digit + Enter fills opponent as 0 and submits
        setScore('B', 0);
        submitOverlayScore();
        _scoreKbdBuffer = '';
      }
    }

    // If Escape is pressed
    else if (e.key === 'Escape') {
      closeScoreOverlay();
    }
  }
});

function toggleHubScore(setId) {
  const el = document.getElementById(`hub-score-modal-${setId}`);
  const opening = el.style.display !== 'block';
  document.querySelectorAll('.hub-score-modal').forEach(m => m.style.display = 'none');
  if (opening) { el.style.display = 'block'; _scoreKbdBuffer = ''; }
}

function updateScoreUI(setId, nameA, nameB, prefix = "") {
  const sA = parseInt(document.getElementById(`${prefix}scoreA-${setId}`).value) || 0;
  const sB = parseInt(document.getElementById(`${prefix}scoreB-${setId}`).value) || 0;
  const btn = document.getElementById(`${prefix}reportBtn-${setId}`);
  const inA = document.getElementById(`${prefix}scoreA-${setId}`), inB = document.getElementById(`${prefix}scoreB-${setId}`);
  if (sA > sB) { btn.innerHTML = `🏆 Report: <strong>${nameA}</strong> Wins!`; inA.style.borderColor = 'var(--accent)'; inB.style.borderColor = 'var(--border)'; }
  else if (sB > sA) { btn.innerHTML = `🏆 Report: <strong>${nameB}</strong> Wins!`; inB.style.borderColor = 'var(--accent)'; inA.style.borderColor = 'var(--border)'; }
  else { btn.innerHTML = `🏆 Submit Score`; inA.style.borderColor = 'var(--border)'; inB.style.borderColor = 'var(--border)'; }
  btn.style.background = 'var(--accent)'; btn.style.color = '#000';
}

// ─────────────────────────────────────────────────────────────
// Station Status Sidebar — shows every station + stream with current state
// ─────────────────────────────────────────────────────────────
function renderStationSidebar() {
  const el = document.getElementById('stationStatusList');
  if (!el) return;
  if (!state.stationList.length && !state.streamList.length) {
    el.innerHTML = '<div style="font-size:0.75rem;color:var(--muted);text-align:center;padding:14px 0;">No stations loaded yet</div>';
    return;
  }

  // Build a quick lookup of who's on which location.
  // Streams take precedence over stations when both are set on a single set.
  const stationOccupants = new Map(); // stationId -> set
  const streamOccupants = new Map(); // streamId  -> set
  const activeForOccupancy = state.activeSetsData.filter(s => s.state === 2 || s.state === 6);
  for (const s of activeForOccupancy) {
    if (s.stream?.id) streamOccupants.set(String(s.stream.id), s);
    else if (s.station?.id) stationOccupants.set(String(s.station.id), s);
  }

  const rows = [];

  // Streams first (ranked higher visually)
  for (const stream of state.streamList) {
    const occupant = streamOccupants.get(String(stream.id));
    if (occupant) {
      const a = occupant.slots[0]?.entrant?.name || '?';
      const b = occupant.slots[1]?.entrant?.name || '?';
      rows.push(`<div class="station-row stream-row busy">
        <div class="sr-num">📺</div>
        <div class="sr-info">
          <div class="sr-label">${stream.streamName}</div>
          <div class="sr-status" title="${a} vs ${b}">${a} vs ${b}</div>
        </div>
        <div class="sr-dot"></div>
      </div>`);
    } else {
      rows.push(`<div class="station-row stream-row free">
        <div class="sr-num">📺</div>
        <div class="sr-info">
          <div class="sr-label">${stream.streamName}</div>
          <div class="sr-status">empty · queue a match below</div>
        </div>
        <div class="sr-dot"></div>
      </div>`);
    }
  }

  // Then stations sorted by number — excluding stream placeholder stations,
  // which are tracked under their stream's row above and shouldn't appear
  // as standalone station entries.
  const placeholderIds = getPlaceholderStationIds();
  const sortedStations = state.stationList
    .filter(s => !placeholderIds.has(String(s.id)))
    .slice()
    .sort((a, b) => a.number - b.number);
  for (const stn of sortedStations) {
    const occupant = stationOccupants.get(String(stn.id));
    if (occupant) {
      const a = occupant.slots[0]?.entrant?.name || '?';
      const b = occupant.slots[1]?.entrant?.name || '?';
      const stateLabel = occupant.state === 2 ? '▶' : '⏱';
      rows.push(`<div class="station-row busy">
        <div class="sr-num">${stn.number}</div>
        <div class="sr-info">
          <div class="sr-label">Station ${stn.number}</div>
          <div class="sr-status" title="${a} vs ${b}">${stateLabel} ${a} vs ${b}</div>
        </div>
        <div class="sr-dot"></div>
      </div>`);
    } else {
      rows.push(`<div class="station-row free">
        <div class="sr-num">${stn.number}</div>
        <div class="sr-info">
          <div class="sr-label">Station ${stn.number}</div>
          <div class="sr-status">free</div>
        </div>
        <div class="sr-dot"></div>
      </div>`);
    }
  }

  el.innerHTML = rows.join('');
}

// Expose to window
export { 
  formatWait,
  fetchManualSets,
  renderManualSets,
  callSetFromPanel,
  toggleHubCheckin,
  toggleHubScore,
  updateScoreUI,
  renderStationSidebar,
 };
