function getStreamScore(set) {
  const getSlotSeed = (slot) => {
    if (slot?.seed?.seedNum) return slot.seed.seedNum;
    if (slot?.prereqType === 'set' && slot?.prereqId) {
      const feeder = allFetchedSets.find(s => String(s.id) === String(slot.prereqId)) ||
        activeSetsData.find(s => String(s.id) === String(slot.prereqId));
      if (feeder?.slots) {
        const s0 = feeder.slots[0]?.seed?.seedNum, s1 = feeder.slots[1]?.seed?.seedNum;
        if (s0 && s1) {
          const wantsWinner = (slot.prereqPlacement ?? 1) === 1;
          return wantsWinner ? Math.min(s0, s1) : Math.max(s0, s1);
        }
        if (s0) return s0;
      }
    }
    return null;
  };
  const sA = getSlotSeed(set.slots[0]), sB = getSlotSeed(set.slots[1]);
  if (!sA || !sB) return 9999;
  return Math.abs(sA - sB) + ((sA + sB) * 0.1);
}

function streamGrade(score) {
  if (!score || score >= 9999) return '';
  if (score <= 3) return '<span style="color:#00e5a0;font-weight:700;">A+</span>';
  if (score <= 6) return '<span style="color:#00e5a0;font-weight:700;">A</span>';
  if (score <= 10) return '<span style="color:#4fd8a0;font-weight:700;">A-</span>';
  if (score <= 15) return '<span style="color:#a0d070;font-weight:700;">B+</span>';
  if (score <= 22) return '<span style="color:#d4c040;font-weight:700;">B</span>';
  if (score <= 30) return '<span style="color:#e09030;font-weight:700;">B-</span>';
  if (score <= 50) return '<span style="color:#e06030;font-weight:700;">C</span>';
  return '<span style="color:#ff4f6d;font-weight:700;">D</span>';
}

// Winners side sets in user-selected stream-priority phases are held for stream only
async function fetchAndPopulateStreams() {
  const eventField = getEventField();
  if (!eventField) { toast('Select an event first', true); return; }
  try {
    const data = await sggQuery(`query { ${eventField} { tournament { streams { id streamName } } } }`);
    streamList = data?.data?.event?.tournament?.streams || [];
    renderPriorityStreamSelector();
    renderStreamSetupSelectors();
    toast(`✓ ${streamList.length} streams loaded`);
  } catch (e) { toast(`✗ ${e.message}`, true); }
}

function savePriorityStream() {
  const val = document.getElementById('priorityStreamId')?.value || '';
  localStorage.setItem('abbey_priority_stream_id', val);
}

function getPriorityStreamId() {
  return localStorage.getItem('abbey_priority_stream_id') || '';
}

function renderPriorityStreamSelector() {
  const sel = document.getElementById('priorityStreamId');
  if (!sel || !streamList.length) return;
  const saved = getPriorityStreamId();
  sel.innerHTML = '<option value="">Any available stream</option>';
  for (const s of streamList) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.streamName;
    opt.selected = String(s.id) === saved;
    sel.appendChild(opt);
  }
}

function renderStreamSetupSelectors() {
  const mainStr = document.getElementById('mainStreamId');
  const mainStn = document.getElementById('mainStreamStationId');
  const sideStr = document.getElementById('sideStreamId');
  const sideStn = document.getElementById('sideStreamStationId');
  
  if (!mainStr || !mainStn || !sideStr || !sideStn) return;

  const savedMainStr = localStorage.getItem('abbey_main_stream_id') || '';
  const savedMainStn = localStorage.getItem('abbey_main_stream_station_id') || '';
  const savedSideStr = localStorage.getItem('abbey_side_stream_id') || '';
  const savedSideStn = localStorage.getItem('abbey_side_stream_station_id') || '';

  const populate = (el, list, savedId, defaultLabel, isStream) => {
    el.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    // Show "(N available)" so the user can immediately tell whether the
    // dropdown actually has options behind it. Without this, an empty list
    // and an unfilled-but-populated list look identical when collapsed.
    def.textContent = list.length > 0
      ? `${defaultLabel} (${list.length} available)`
      : `${defaultLabel} — none loaded`;
    el.appendChild(def);

    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = isStream ? item.streamName : `Station ${item.number}`;
      if (String(item.id) === String(savedId)) opt.selected = true;
      el.appendChild(opt);
    }
  };

  populate(mainStr, streamList, savedMainStr, 'Select Stream...', true);
  populate(sideStr, streamList, savedSideStr, 'Select Stream...', true);
  populate(mainStn, stationList, savedMainStn, 'No dedicated station', false);
  populate(sideStn, stationList, savedSideStn, 'No dedicated station', false);

  // Note: no toast/poll-log here — this function is called on every tab
  // switch and every fetchManualSets, so any output would spam. The
  // user-facing "streams loaded" toast lives in fetchAndPopulateStreams.
}

function getPhaseTiers() {
  try { return JSON.parse(localStorage.getItem('abbey_phase_tiers') || '{}'); } catch (e) { return {}; }
}
function setPhaseTier(phaseId, tier) {
  const tiers = getPhaseTiers();
  if (tier) tiers[phaseId] = tier; else delete tiers[phaseId];
  localStorage.setItem('abbey_phase_tiers', JSON.stringify(tiers));
  // Keep legacy abbey_stream_priority_phases in sync for isStreamPriority checks
  const ids = Object.keys(tiers);
  localStorage.setItem('abbey_stream_priority_phases', JSON.stringify(ids));
}

function renderStreamPriorityPicker(phases) {
  const container = document.getElementById('streamPriorityPhases');
  if (!container) return;
  const tiers = getPhaseTiers();
  container.innerHTML = '';
  for (const phase of phases.sort((a, b) => a.phaseOrder - b.phaseOrder)) {
    const id = String(phase.id);
    const current = tiers[id] || null;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;min-width:54px;';
    label.textContent = phase.name;
    row.appendChild(label);
    [['stream-preferred', 'Top 8', 'var(--blue)', 'rgba(114,137,218,0.15)'],
    ['winners-main', 'Top 24', '#a78bfa', 'rgba(167,139,250,0.12)']].forEach(([tier, label2, col, bg]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = label2;
      const active = current === tier;
      chip.style.cssText = `padding:4px 12px;border-radius:20px;border:1px solid ${active ? col : 'var(--border)'};background:${active ? bg : 'transparent'};color:${active ? col : 'var(--muted)'};font-family:'Space Mono',monospace;font-size:0.72rem;cursor:pointer;transition:all 0.12s;`;
      chip.onclick = function () {
        const t = getPhaseTiers();
        const newTier = t[id] === tier ? null : tier;
        setPhaseTier(id, newTier);
        renderStreamPriorityPicker(phases);
      };
      row.appendChild(chip);
    });
    container.appendChild(row);
  }
}

function getStreamPriorityPhaseIds() {
  try { return JSON.parse(localStorage.getItem('abbey_stream_priority_phases') || '[]'); } catch (e) { return []; }
}
// Returns stream tier for a set:
// 'main-only'        — Winners Top8, Losers Finals, Grand Finals
// 'stream-preferred' — other Losers sets in stream-priority phases
// 'normal'           — everything else
function getSetStreamTier(set) {
  const phaseId = String(set.phaseGroup?.phase?.id ?? '');
  const tiers = getPhaseTiers();
  const phaseTier = tiers[phaseId];
  if (!phaseTier) return 'normal';
  const round = (set.fullRoundText || '').toLowerCase();
  const isWinners = round.includes('winners') || round.includes('grand final');
  if (phaseTier === 'stream-preferred') {
    // Winners → main only; Losers → main first, sidestream fallback
    return isWinners ? 'main-only' : 'stream-preferred';
  }
  if (phaseTier === 'winners-main') {
    // Winners → main only; Losers → normal (stations/any stream)
    return isWinners ? 'main-only' : 'normal';
  }
  return 'normal';
}
function isStreamPriority(set) { return getSetStreamTier(set) !== 'normal'; }

async function enforceAutoDQ(set) {
  if (completedSetIds.has(String(set.id))) return;
  const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
  const nA = set.slots[0]?.entrant?.name || 'Player 1', nB = set.slots[1]?.entrant?.name || 'Player 2';
  const seedA = set.slots[0]?.seed?.seedNum || 9999, seedB = set.slots[1]?.seed?.seedNum || 9999;
  const hasA = hubCheckins.has(`${set.id}-${idA}`), hasB = hubCheckins.has(`${set.id}-${idB}`);
  if (hasA && hasB) { await markInProgressQuick(set.id, true); return; }
  if (!hasA && !hasB) { (seedA > seedB) ? await submitDQ(set.id, idB, idA, nB, true) : await submitDQ(set.id, idA, idB, nA, true); }
  else if (!hasA) { await submitDQ(set.id, idB, idA, nB, true); }
  else { await submitDQ(set.id, idA, idB, nA, true); }
}

// ─────────────────────────────────────────────────────────────
// Expose to window
Object.assign(window, {
  getStreamScore,
  streamGrade,
  fetchAndPopulateStreams,
  savePriorityStream,
  getPriorityStreamId,
  renderPriorityStreamSelector,
  renderStreamSetupSelectors,
  getPhaseTiers,
  setPhaseTier,
  renderStreamPriorityPicker,
  getStreamPriorityPhaseIds,
  getSetStreamTier,
  isStreamPriority,
  enforceAutoDQ,
});
