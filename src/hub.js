import { _scoreKbdBuffer, _scoreKbdTimer } from './manual.js';
import { discordOverrides, saveOverrides } from './state.js';
import { saveStreamQueues, updateTimerCache, state, saveCheckins } from './state.js';
import { renderStationSidebar, fetchManualSets } from './manual.js';
import { streamGrade } from './streams.js';
import { sggQuery } from './api.js';
import { callQueuedSetToStream, findQueueAssignment, renderStreamQueue } from './queue.js';
import { addPollLog } from './actions.js';

// Player Hub — stable fixed-size card grid
// ─────────────────────────────────────────────────────────────
function renderPlayerHub() {
  const activeEl = document.getElementById('hubActiveList');
  if (!activeEl) return;

  // Side panels are independent of the main card grid — render them
  // unconditionally so the TO sees current station + stream state.
  renderStationSidebar();
  renderStreamQueue();

  const actionSets = state.activeSetsData.filter(s => s.state === 2 || s.state === 6);
  const currentIds = actionSets.map(s => String(s.id));
  currentIds.forEach(id => { if (!state._hubSlotIds.includes(id)) state._hubSlotIds.push(id); });
  // Never prune here — pruning happens once per poll cycle in doPoll so stale
  // slots hold their position as dashed placeholders across ALL renders that
  // fire between polls (e.g. score submit + auto-promote both call fetchManualSets).

  const CARD_H = '200px';

  const cards = state._hubSlotIds.map(slotId => {
    const set = actionSets.find(s => String(s.id) === slotId);

    if (!set) return `<div style="height:${CARD_H};background:var(--bg);border:1px dashed var(--border);border-radius:10px;display:flex;align-items:center;justify-content:center;">
      <span style="font-size:0.75rem;color:var(--border);">—</span>
    </div>`;

    const a = set.slots[0]?.entrant, b = set.slots[1]?.entrant;
    const nameA = a?.name || '???', nameB = b?.name || '???';
    const onStream = !!set.stream?.streamName;
    const streamName = set.stream?.streamName || '';
    const stationLabel = set.station?.number ? `Station ${set.station.number}` : '';
    // Player-hub cards now also surface "queued for stream X" status — the player
    // is still playing on a station, but they should know they're up next on stream.
    const queueAssignment = !onStream ? findQueueAssignment(set.id) : null;
    const queuedStream = queueAssignment ? state.streamList.find(s => String(s.id) === queueAssignment.streamId) : null;
    const isQueued = !!queuedStream;
    const queuedLabel = queuedStream
      ? `🎬 QUEUED FOR ${queuedStream.streamName.toUpperCase()}${queueAssignment.position === 0 ? ' (NEXT UP)' : ` (#${queueAssignment.position + 1})`}`
      : '';
    const loc = onStream
      ? `📺 ON STREAM · ${streamName}`
      : isQueued
        ? `${queuedLabel}${stationLabel ? ' · ' + stationLabel : ''}`
        : (stationLabel || 'No Location');
    const escA = nameA.replace(/'/g, "\'"), escB = nameB.replace(/'/g, "\'");

    if (set.state === 6) {
      const ciA = state.hubCheckins.has(`${set.id}-${a?.id}`), ciB = state.hubCheckins.has(`${set.id}-${b?.id}`);
      const callTime = set.updatedAt || set.createdAt || Math.floor(Date.now() / 1000);
      const nowSec = Math.floor(Date.now() / 1000);
      const isExpired = (nowSec - callTime) / 60 >= state.DQ_MINUTES;
      const autoDqOn = document.getElementById('autoDqToggle')?.checked !== false;

      // On-stream OR queued-for-stream sets get a blue accent so it's
      // immediately obvious that stream interaction is incoming/active.
      const blueState = onStream || isQueued;
      const accentVar = blueState ? 'var(--blue)' : 'var(--accent2)';
      const headerLabel = blueState ? loc : `Called · ${loc}`;
      const cardBg = blueState ? 'rgba(114,137,218,0.06)' : 'var(--bg)';

      // Handle Manual DQ Fallback Layout
      if (isExpired && !autoDqOn) {
        return `<div style="height:${CARD_H};background:rgba(255,79,109,0.06);border:2px solid var(--accent2);border-radius:10px;padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;animation: slideIn 0.2s ease;overflow:hidden;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;min-width:0;">
            <span style="font-size:0.72rem;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:0.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Timer Expired &middot; ${loc}</span>
          </div>
          <div style="font-size:1rem;font-weight:800;line-height:1.3;word-break:break-word;margin:auto 0;">${nameA} <span style="color:var(--muted);font-weight:400;">vs</span> ${nameB}</div>
          <div style="font-size:0.78rem;color:var(--accent2);font-weight:700;word-break:break-word;">${(!ciA && !ciB) ? 'Neither checked in' : (!ciA ? `${nameA} missing` : `${nameB} missing`)}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;flex-shrink:0;">
            <button onclick="requestHubDQ('${set.id}')" class="hub-dq-btn">DQ?</button>
            <button onclick="markInProgressQuick('${set.id}')" style="background:transparent;border:2px solid var(--accent);color:var(--accent);padding:10px;border-radius:8px;font-family:'Space Mono',monospace;font-weight:bold;cursor:pointer;font-size:0.85rem;transition:0.1s;" onmouseover="this.style.background='var(--accent)';this.style.color='#000';" onmouseout="this.style.background='transparent';this.style.color='var(--accent)';">Start Set?</button>
          </div>
        </div>`;
      }

      const brdA = ciA ? 'var(--accent)' : 'rgba(255,255,255,0.1)', bgA = ciA ? 'rgba(0,229,160,0.2)' : 'rgba(255,255,255,0.04)', clA = ciA ? 'var(--accent)' : 'var(--text)';
      const brdB = ciB ? 'var(--accent)' : 'rgba(255,255,255,0.1)', bgB = ciB ? 'rgba(0,229,160,0.2)' : 'rgba(255,255,255,0.04)', clB = ciB ? 'var(--accent)' : 'var(--text)';
      return `<div style="height:${CARD_H};background:${cardBg};border:2px solid ${accentVar};border-radius:10px;padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
          <span style="font-size:0.72rem;font-weight:700;color:${accentVar};text-transform:uppercase;letter-spacing:0.5px;">${headerLabel}</span>
          <span style="font-size:0.72rem;font-weight:700;color:${accentVar};">DQ:&nbsp;<span class="dq-timer-display" data-time="${callTime}">0:00</span></span>
        </div>
        <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);flex-shrink:0;">Players checked in:</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0;">
          <button onclick="toggleHubCheckin('${set.id}','${a?.id}','${escA}')"
            style="border-radius:8px;border:2px solid ${brdA};background:${bgA};color:${clA};font-family:'Inter',sans-serif;cursor:pointer;padding:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;overflow:hidden;transition:all 0.15s;">
            <span style="font-size:1.6rem;line-height:1;">${ciA ? '&#x2705;' : '&#x2B1C;'}</span>
            <span style="font-size:0.82rem;font-weight:${ciA ? '600' : '800'};word-break:break-word;max-width:100%;text-align:center;line-height:1.2;">${nameA}</span>
          </button>
          <button onclick="toggleHubCheckin('${set.id}','${b?.id}','${escB}')"
            style="border-radius:8px;border:2px solid ${brdB};background:${bgB};color:${clB};font-family:'Inter',sans-serif;cursor:pointer;padding:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;overflow:hidden;transition:all 0.15s;">
            <span style="font-size:1.6rem;line-height:1;">${ciB ? '&#x2705;' : '&#x2B1C;'}</span>
            <span style="font-size:0.82rem;font-weight:${ciB ? '600' : '800'};word-break:break-word;max-width:100%;text-align:center;line-height:1.2;">${nameB}</span>
          </button>
        </div>
      </div>`;
    }

    if (set.state === 2) {
      const blueState = onStream || isQueued;
      const accentVar = blueState ? 'var(--blue)' : 'var(--accent)';
      const headerLabel = blueState ? loc : `In Progress · ${loc}`;
      const cardBg = blueState ? 'rgba(114,137,218,0.06)' : 'var(--bg)';
      return `<div style="height:${CARD_H};background:${cardBg};border:2px solid ${accentVar};border-radius:10px;padding:14px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
        <div style="flex-shrink:0;">
          <div style="font-size:0.7rem;color:${accentVar};font-family:'Space Mono',monospace;margin-bottom:6px;font-weight:700;">${headerLabel}</div>
          <div style="font-size:1rem;font-weight:800;line-height:1.3;word-break:break-word;">${nameA} <span style="color:var(--muted);font-weight:400;">vs</span> ${nameB}</div>
        </div>
        <button onclick="openScoreOverlay('${set.id}','${a?.id}','${b?.id}','${escA}','${escB}','${loc}')"
          style="flex-shrink:0;padding:12px;border-radius:8px;border:none;background:var(--accent);color:#000;font-family:'Inter',sans-serif;font-size:0.9rem;font-weight:800;cursor:pointer;letter-spacing:0.3px;">
          &#x1F4DD; Report Score
        </button>
      </div>`;
    }
    return '';
  });

  activeEl.innerHTML = cards.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:10px;">${cards.join('')}</div>`
    : '<div class="sets-empty" style="padding:40px 0;">No active matches right now.</div>';
  updateTimerCache();
}

// ─────────────────────────────────────────────────────────────
// Session Log
// ─────────────────────────────────────────────────────────────
function logMatch(nameA, nameB, station, source, setId = null, seedA = null, seedB = null, shiny = false) {
  const _sc = (seedA && seedB) ? Math.abs(seedA - seedB) + (seedA + seedB) * 0.1 : 9999;
  const _gr = streamGrade(_sc);
  state.matchLog.unshift({ p1: nameA, p2: nameB, station, source, setId, completed: false, grade: _gr, shiny, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  renderLog();
}

function resetMatch(setId) {
  state.announcedSetIds.delete(String(setId)); state.completedSetIds.delete(String(setId));
  const entry = state.matchLog.find(e => e.setId === setId);
  if (entry) entry.completed = false;
  renderLog();
  addPollLog(`↩ Reset set ${setId} — will re-ping on next poll`, 'new');
  toast('↩ Reset — will re-ping next poll');
}

function renderLog() {
  const el = document.getElementById('state.matchLog');
  if (!state.matchLog.length) { el.innerHTML = '<div class="empty-log">No matches called yet.</div>'; return; }
  el.innerHTML = state.matchLog.map(e => `
    <div class="match-entry ${e.source === 'auto' ? 'auto' : ''} ${e.completed ? 'done' : ''}">
      <div style="flex:1;min-width:0;">
        <div class="state.players">${e.p1} <span style="color:var(--muted)">vs</span> ${e.p2}${e.shiny ? ' <span class="shiny-badge">✨ SHINY</span>' : ''}</div>
        <div class="meta">${e.time} · ${e.source === 'auto' ? '⚡ auto' : '🖐 manual'}${e.grade ? ' &middot; ' + e.grade : ''}${e.completed ? ' · <span style="color:var(--accent)">✓ done</span>' : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <div class="stn">${e.station}</div>
        ${e.setId && !e.completed ? `<button class="btn-sm" style="font-size:0.68rem;padding:5px 8px;" onclick="resetMatch('${e.setId}')">↩</button>` : ''}
      </div>
    </div>`).join('');
}

function toast(msg, err = false) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = err ? 'err' : '';
  void el.offsetWidth; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────────────────────
// Score Overlay — button-based score picker
// ─────────────────────────────────────────────────────────────
export let _overlaySetId = null; let _overlayIdA = null; let _overlayIdB = null;
export let _overlayNameA = ''; export let _overlayNameB = '';
export let _overlayScoreA = null; export let _overlayScoreB = null;

function openScoreOverlay(setId, idA, idB, nameA, nameB, loc) {
  _overlaySetId = setId; _overlayIdA = idA; _overlayIdB = idB;
  _overlayNameA = nameA; _overlayNameB = nameB;
  _overlayScoreA = null; _overlayScoreB = null;
  document.getElementById('scoreOverlayTitle').textContent = `${nameA} vs ${nameB}`;
  document.getElementById('scoreOverlayLoc').textContent = loc;
  document.getElementById('scoreOverlayNameA').textContent = nameA;
  document.getElementById('scoreOverlayNameB').textContent = nameB;
  document.getElementById('scoreDisplayA').textContent = '—';
  document.getElementById('scoreDisplayB').textContent = '—';
  document.getElementById('scoreDisplayA').style.color = 'var(--muted)';
  document.getElementById('scoreDisplayB').style.color = 'var(--muted)';
  // Reset all buttons
  [0, 1, 2, 3].forEach(n => {
    ['A', 'B'].forEach(p => {
      const btn = document.getElementById(`sb${p}${n}`);
      if (btn) btn.classList.remove('selected');
    });
  });
  const submitBtn = document.getElementById('scoreOverlayBtn');
  submitBtn.textContent = 'Select scores above';
  submitBtn.style.opacity = '0.4';
  submitBtn.style.pointerEvents = 'none';
  document.getElementById('scoreOverlay').style.display = 'flex';
  _scoreKbdBuffer = '';
}

function setScore(player, value) {
  if (player === 'A') {
    _overlayScoreA = value;
    document.getElementById('scoreDisplayA').textContent = value;
    document.getElementById('scoreDisplayA').style.color = 'var(--accent)';
    [0, 1, 2, 3].forEach(n => document.getElementById(`sbA${n}`)?.classList.toggle('selected', n === value));
  } else {
    _overlayScoreB = value;
    document.getElementById('scoreDisplayB').textContent = value;
    document.getElementById('scoreDisplayB').style.color = 'var(--accent)';
    [0, 1, 2, 3].forEach(n => document.getElementById(`sbB${n}`)?.classList.toggle('selected', n === value));
  }
  updateOverlayScore();
}

function closeScoreOverlay() {
  document.getElementById('scoreOverlay').style.display = 'none';
  _overlaySetId = null; _scoreKbdBuffer = '';
}

function updateOverlayScore() {
  if (_overlayScoreA === null && _overlayScoreB === null) return;
  const submitBtn = document.getElementById('scoreOverlayBtn');
  const sA = _overlayScoreA === null ? 0 : _overlayScoreA;
  const sB = _overlayScoreB === null ? 0 : _overlayScoreB;
  if (sA === sB) {
    submitBtn.textContent = "Scores can't be tied — pick again";
    submitBtn.style.opacity = '0.4'; submitBtn.style.pointerEvents = 'none';
    return;
  }
  const winnerName = sA > sB ? _overlayNameA : _overlayNameB;
  const ws = Math.max(sA, sB), ls = Math.min(sA, sB);
  submitBtn.textContent = `Report: ${winnerName} Wins ${ws}-${ls}`;
  submitBtn.style.opacity = '1'; submitBtn.style.pointerEvents = 'auto';
}

async function submitOverlayScore() {
  if (_overlaySetId === null || (_overlayScoreA === null && _overlayScoreB === null)) return;
  const sA = _overlayScoreA === null ? 0 : _overlayScoreA;
  const sB = _overlayScoreB === null ? 0 : _overlayScoreB;
  if (sA === sB) { toast("Scores can't be tied", true); return; }
  const setId = _overlaySetId, idA = _overlayIdA, idB = _overlayIdB;
  const nameA = _overlayNameA, nameB = _overlayNameB;
  closeScoreOverlay();

  // Capture the stream this set was on (if any) before reporting — once we
  // call reportBracketSet, the set is gone and we can't look it up to figure
  // out where to auto-call from. We use this to auto-promote the next queued
  // match for that stream after the score lands.
  const setBeingReported = state.activeSetsData.find(s => String(s.id) === String(setId)) ||
    state.allFetchedSets.find(s => String(s.id) === String(setId));
  const reportedStreamId = setBeingReported?.stream?.id ? String(setBeingReported.stream.id) : null;

  const winnerId = sA > sB ? idA : idB;
  const winnerName = sA > sB ? nameA : nameB;
  let gameData = [], g = 1;
  for (let i = 0; i < sA; i++) gameData.push(`{winnerId: "${idA}", gameNum: ${g++}}`);
  for (let i = 0; i < sB; i++) gameData.push(`{winnerId: "${idB}", gameNum: ${g++}}`);
  try {
    await sggQuery(`mutation { reportBracketSet(setId: "${setId}", winnerId: "${winnerId}", gameData: [${gameData.join(',')}]) { id state } }`);
    toast(`🏆 Reported: ${winnerName} wins!`);
    state.completedSetIds.add(String(setId)); state.announcedSetIds.delete(String(setId));
    state.streamAnnouncedSetIds.delete(String(setId));
    state.hubCheckins.delete(`${setId}-${idA}`); state.hubCheckins.delete(`${setId}-${idB}`); saveCheckins();
    // Leave state._hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = state.matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }

    // Auto-call the next queued match for this stream, if any.
    // We do this BEFORE fetchManualSets so the stream goes from
    // "live: just-reported set" to "live: next queued set" without a
    // visible empty state in between.
    // Gated by the "Autocall next from queue" toggle.
    const autoQueueCallOnAfterScore = document.getElementById('autoQueueCallToggle')?.checked !== false;
    if (reportedStreamId && autoQueueCallOnAfterScore) {
      const nextSetId = (state.streamQueues[reportedStreamId] || [])[0];
      if (nextSetId) {
        const stream = state.streamList.find(s => String(s.id) === reportedStreamId);
        const nextSet = state.activeSetsData.find(s => String(s.id) === String(nextSetId)) ||
          state.pendingSetsData.find(s => String(s.id) === String(nextSetId)) ||
          state.allFetchedSets.find(s => String(s.id) === String(nextSetId));
        const nextFilled = !!(nextSet?.slots?.[0]?.entrant?.name && nextSet?.slots?.[1]?.entrant?.name);
        if (stream && nextSet && nextFilled) {
          // Drop from queue first so re-renders don't show it twice
          state.streamQueues[reportedStreamId] = state.streamQueues[reportedStreamId].filter(x => String(x) !== String(nextSetId));
          saveStreamQueues();
          addPollLog(`🎬 Auto-promoting next queued match → ${stream.streamName} (after score report)`, 'new');
          // Don't await — let it run while we refresh data, so the UI stays snappy
          callQueuedSetToStream(nextSetId, stream.id, stream.streamName);
        } else if (stream && nextSet && !nextFilled) {
          addPollLog(`⏸ Next queued match for ${stream.streamName} has unfilled entrants — skipping auto-promote`, 'new');
        }
      }
    }

    fetchManualSets();
  } catch (e) { toast(`✗ ${e.message}`, true); }
}

// ─────────────────────────────────────────────────────────────
// Discord Linked Accounts panel
// ─────────────────────────────────────────────────────────────
function renderDiscordAccountsList() {
  const el = document.getElementById('discordLinkedList');
  if (!el) return;
  if (!state.players.length) {
    el.innerHTML = '<span style="font-size:0.82rem;color:var(--muted);">Load an attendee CSV above to see linked accounts.</span>';
    return;
  }
  const linked = state.players.filter(p => p.discordId);
  const unlinked = state.players.filter(p => !p.discordId);
  let html = '';

  if (linked.length) {
    html += `<div style="margin-bottom:8px;font-size:0.68rem;font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:1px;color:var(--accent);">${linked.length} linked</div>`;
    linked.forEach(p => {
      const pi = state.players.indexOf(p);
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,229,160,0.05);border:1px solid rgba(0,229,160,0.2);border-radius:7px;margin-bottom:4px;">
        <span style="flex:1;font-size:0.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.tag.replace(/</g,'&lt;')}</span>
        <span style="font-family:'Space Mono',monospace;font-size:0.68rem;color:var(--muted);flex-shrink:0;">${p.discordId}</span>
        <button class="btn-sm" style="padding:3px 8px;font-size:0.65rem;border-color:var(--accent2);color:var(--accent2);flex-shrink:0;" onclick="unlinkPlayer(${pi})">Unlink</button>
      </div>`;
    });
  }

  if (unlinked.length) {
    html += `<details style="margin-top:${linked.length ? '12' : '0'}px;">
      <summary style="font-size:0.72rem;font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:1px;color:var(--muted);cursor:pointer;margin-bottom:8px;user-select:none;">${unlinked.length} not linked &#x2014; expand to link manually</summary>`;
    unlinked.forEach(p => {
      const pi = state.players.indexOf(p);
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;margin-bottom:4px;">
        <span style="flex:1;font-size:0.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.tag.replace(/</g,'&lt;')}</span>
        <input id="ml-p${pi}" type="text" placeholder="Discord User ID" style="width:140px;font-size:0.72rem;padding:4px 8px;flex-shrink:0;" autocomplete="off">
        <button class="btn-sm" style="padding:3px 8px;font-size:0.65rem;flex-shrink:0;" onclick="manualLinkPlayer(${pi})">Link</button>
      </div>`;
    });
    html += '</details>';
  }

  if (!linked.length && !unlinked.length) {
    html = '<span style="font-size:0.82rem;color:var(--muted);">No state.players in CSV.</span>';
  }

  el.innerHTML = html;
}

function manualLinkPlayer(playerIdx) {
  const p = state.players[playerIdx];
  if (!p) return;
  const input = document.getElementById('ml-p' + playerIdx);
  const id = input?.value.trim().replace(/\D/g, '');
  if (!id) { toast('Paste a numeric Discord user ID', true); return; }
  discordOverrides[p.tag.toLowerCase()] = id;
  saveOverrides();
  try { const m = JSON.parse(localStorage.getItem('abbey_discord_map') || '{}'); m[p.tag.toLowerCase()] = id; localStorage.setItem('abbey_discord_map', JSON.stringify(m)); } catch (e) { }
  const player = state.tagMap.get(p.tag.toLowerCase());
  if (player) player.discordId = id;
  p.discordId = id;
  renderDiscordAccountsList();
  toast(`✓ Linked ${p.tag}`);
}

function unlinkPlayer(playerIdx) {
  const p = state.players[playerIdx];
  if (!p) return;
  delete discordOverrides[p.tag.toLowerCase()];
  saveOverrides();
  try { const m = JSON.parse(localStorage.getItem('abbey_discord_map') || '{}'); delete m[p.tag.toLowerCase()]; localStorage.setItem('abbey_discord_map', JSON.stringify(m)); } catch (e) { }
  const player = state.tagMap.get(p.tag.toLowerCase());
  if (player) player.discordId = '';
  p.discordId = '';
  renderDiscordAccountsList();
  toast(`Unlinked ${p.tag}`);
}

// --- WordPress compatibility shim ---
// Expose to window
export { 
  renderPlayerHub,
  logMatch,
  resetMatch,
  renderLog,
  toast,
  openScoreOverlay,
  setScore,
  closeScoreOverlay,
  updateOverlayScore,
  submitOverlayScore,
  renderDiscordAccountsList,
  manualLinkPlayer,
  unlinkPlayer,
 };
