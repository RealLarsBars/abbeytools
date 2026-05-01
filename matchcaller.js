// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let players = [], tagMap = new Map(), matchLog = [], pollTimer = null;
let announcedSetIds = new Set(), completedSetIds = new Set(), pollLogEntries = [];
// Tracks setIds we've already pinged Discord about for stream assignments,
// so external moves get pinged exactly once and our own moveToStream calls
// pre-populate this to avoid double-pings on the next poll.
let streamAnnouncedSetIds = new Set();
// Tracks setIds we've already sent a "you're in the queue" ping for, so
// reordering or queue-state churn doesn't cause repeat pings.
let queuePingedSetIds = new Set();
let activeSetsData = [], pendingSetsData = [], allFetchedSets = [];
let stationList = [], streamList = [];
let hubCheckins = new Set();
let recentlyAssignedLocs = new Map(); // Local lock for stations: loc.id -> timestamp
let DQ_MINUTES = 5.5;

// Stream queues — per-stream ordered list of setIds waiting to go on stream.
// Pure client-side state (no API call until "Send to stream" promotes the head).
// Shape: { [streamId]: [setId, setId, ...] }
let streamQueues = {};
// Tracks which streams have their "+ Add to queue" panel expanded
let _expandedAddQueues = new Set();

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
let _hubSlotIds = [];

const $ = id => document.getElementById(id);
let activeTimers = [];

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

// ─────────────────────────────────────────────────────────────
// Setup accordion
// ─────────────────────────────────────────────────────────────
function toggleSetup(forceCollapse = null) {
  const content = document.getElementById('setupContent');
  const icon = document.getElementById('setupToggleIcon');
  const shouldCollapse = forceCollapse !== null ? forceCollapse : content.style.display !== 'none';
  content.style.display = shouldCollapse ? 'none' : 'grid';
  icon.textContent = shouldCollapse ? '▼' : '▲';
}

// ─────────────────────────────────────────────────────────────
// DQ timer
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (!activeTimers.length) return;
  const nowSec = Math.floor(Date.now() / 1000);
  activeTimers.forEach(({ el, callTime }) => {
    const remaining = Math.max(0, (DQ_MINUTES * 60) - (nowSec - callTime));
    const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60).toString().padStart(2, '0');
    el.textContent = `${m}:${s}`;
    if (remaining === 0) el.style.color = 'var(--accent2)';
  });
}, 1000);

// ─────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────
function renderHubChips() {
  const container = document.getElementById('hubPhaseChips');
  if (!container) return;
  const sourceChips = [...document.querySelectorAll('#phaseGroupCheckboxes button[data-pg-id]')];
  if (!sourceChips.length) return;
  container.innerHTML = '<span style="font-size:0.68rem;color:var(--muted);font-family:\'Space Mono\',monospace;">FILTER:</span>';
  // Group by phase row
  const rows = document.querySelectorAll('#phaseGroupCheckboxes > div');
  rows.forEach(row => {
    const phaseLabel = row.querySelector('span')?.textContent?.trim();
    const chips = [...row.querySelectorAll('button[data-pg-id]')];
    if (!chips.length) return;
    if (phaseLabel) {
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:0.65rem;color:var(--muted);font-family:\'Space Mono\',monospace;text-transform:uppercase;letter-spacing:1px;';
      lbl.textContent = phaseLabel + ':';
      container.appendChild(lbl);
    }
    chips.forEach(src => {
      const isActive = src.style.color === 'var(--accent)' || src.style.background.includes('229');
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = src.textContent;
      chip.dataset.pgId = src.dataset.pgId;
      chip.style.cssText = `padding:3px 10px;border-radius:20px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'rgba(0,229,160,0.15)' : 'transparent'};color:${isActive ? 'var(--accent)' : 'var(--muted)'};font-family:'Space Mono',monospace;font-size:0.68rem;cursor:pointer;transition:all 0.12s;`;
      chip.onclick = function () {
        // Toggle the source chip in Auto Watch and sync
        const active = src.style.color === 'var(--accent)' || src.style.background.includes('229');
        src.style.borderColor = active ? 'var(--border)' : 'var(--accent)';
        src.style.background = active ? 'transparent' : 'rgba(0,229,160,0.15)';
        src.style.color = active ? 'var(--muted)' : 'var(--accent)';
        saveSettings();
        renderHubChips();
      };
      container.appendChild(chip);
    });
  });
}

function hubToggleWatch() {
  if (pollTimer) { stopPolling(); }
  else {
    const activeTab = document.querySelector('.tab-panel.active')?.id?.replace('tab-', '') || 'hub';
    switchTab('auto'); startPolling(); switchTab(activeTab);
  }
}

function updateHubWatchBtn() {
  for (const id of ['hubWatchBtn', 'streamWatchBtn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    if (pollTimer) {
      btn.textContent = '■ Stop Watching';
      btn.style.background = 'var(--accent2)';
      btn.style.borderColor = 'var(--accent2)';
      btn.style.color = '#fff';
    } else {
      btn.textContent = '▶ Start Watching';
      btn.style.background = 'var(--accent)';
      btn.style.borderColor = 'var(--accent)';
      btn.style.color = '#0d0f12';
    }
  }
}

function clearPhaseFilter() {
  document.querySelectorAll('#phaseGroupCheckboxes button[data-pg-id]').forEach(chip => {
    chip.style.borderColor = 'var(--border)';
    chip.style.background = 'transparent';
    chip.style.color = 'var(--muted)';
  });
  localStorage.setItem('abbey_pg_filter', '');
  updateFilterBar();
  showStatus('settingsStatus', '✓ Filters cleared', true);
  toast('Filters cleared — calling all phases');
  renderHubChips();
}

function saveSettings() {
  localStorage.setItem('abbey_webhook', document.getElementById('webhookUrl').value.trim());
  localStorage.setItem('abbey_sgg_token', document.getElementById('sggToken').value.trim());
  const slug = document.getElementById('tournamentSlug').value.trim();
  if (slug) localStorage.setItem('abbey_tournament_slug', slug);
  const event = document.getElementById('sggEvent').value.trim();
  if (event) localStorage.setItem('abbey_sgg_event', event);
  localStorage.setItem('abbey_auto_assign', document.getElementById('autoAssignToggle')?.checked ? '1' : '0');
  localStorage.setItem('abbey_auto_stream_assign', document.getElementById('autoStreamAssignToggle')?.checked ? '1' : '0');
  localStorage.setItem('abbey_main_stream_id', document.getElementById('mainStreamId')?.value || '');
  localStorage.setItem('abbey_main_stream_station_id', document.getElementById('mainStreamStationId')?.value || '');
  localStorage.setItem('abbey_side_stream_id', document.getElementById('sideStreamId')?.value || '');
  localStorage.setItem('abbey_side_stream_station_id', document.getElementById('sideStreamStationId')?.value || '');
  localStorage.setItem('abbey_bypass_phase', '0');

  const adqInput = document.getElementById('autoDqToggle');
  if (adqInput) localStorage.setItem('abbey_auto_dq', adqInput.checked ? '1' : '0');

  const aqcInput = document.getElementById('autoQueueCallToggle');
  if (aqcInput) localStorage.setItem('abbey_auto_queue_call', aqcInput.checked ? '1' : '0');

  const dqTimer = document.getElementById('dqTimerInput');
  if (dqTimer) {
    const dqVal = parseFloat(dqTimer.value) || 5.5;
    localStorage.setItem('abbey_dq_timer', String(dqVal));
    DQ_MINUTES = dqVal;
  }

  const pgChecked = [...document.querySelectorAll('#phaseGroupCheckboxes button[data-pg-id]')].filter(b => b.style.color === 'var(--accent)' || b.style.background.includes('229')).map(b => b.dataset.pgId);
  localStorage.setItem('abbey_pg_filter', pgChecked.join(','));
  updateFilterBar();
  showStatus('settingsStatus', '✓ Settings saved', true);
}

function loadSettings() {
  const get = k => localStorage.getItem(k) || '';
  document.getElementById('webhookUrl').value = get('abbey_webhook');
  document.getElementById('sggToken').value = get('abbey_sgg_token');
  document.getElementById('tournamentSlug').value = get('abbey_tournament_slug') || '';
  document.getElementById('sggEvent').value = get('abbey_sgg_event');
  const at = document.getElementById('autoAssignToggle');
  if (at) at.checked = get('abbey_auto_assign') === '1';

  const asa = document.getElementById('autoStreamAssignToggle');
  if (asa) asa.checked = get('abbey_auto_stream_assign') !== '0';


  const adq = document.getElementById('autoDqToggle');
  if (adq) adq.checked = get('abbey_auto_dq') !== '0';

  const aqc = document.getElementById('autoQueueCallToggle');
  if (aqc) aqc.checked = get('abbey_auto_queue_call') !== '0'; // default ON

  const savedDq = get('abbey_dq_timer');
  if (savedDq) {
    const dqInput = document.getElementById('dqTimerInput');
    if (dqInput) dqInput.value = savedDq;
    DQ_MINUTES = parseFloat(savedDq) || 5.5;
  }

  if (get('abbey_sgg_event')) {
    document.getElementById('eventHint').textContent = `Event #${get('abbey_sgg_event')} loaded · Browse to change`;
    document.getElementById('selectedEventField').style.display = 'block';
    toggleSetup(true);
    setTimeout(() => loadPhaseGroups(), 500);
  }
}

function showStatus(id, msg, ok) {
  document.getElementById(id).innerHTML = `<span class="badge ${ok ? 'badge-ok' : 'badge-err'}"><span class="dot"></span>${msg}</span>`;
}

function updateFilterBar() {
  const bar = document.getElementById('activeFilterTags');
  if (!bar) return;
  const active = [...document.querySelectorAll('#phaseGroupCheckboxes button[data-pg-id]')].filter(b => b.style.color === 'var(--accent)' || b.style.background.includes('229'));
  const hubStatus = document.getElementById('hubFilterStatus');
  if (!active.length) {
    bar.innerHTML = '<span style="color:var(--muted);">all phases</span>';
    if (hubStatus) hubStatus.innerHTML = '<span style="color:var(--accent);">none</span>';
    return;
  }
  bar.innerHTML = active.map(b => `<span style="background:rgba(0,229,160,0.15);color:var(--accent);border:1px solid rgba(0,229,160,0.3);border-radius:4px;padding:2px 8px;font-family:'Space Mono',monospace;font-size:0.7rem;white-space:nowrap;">${b.closest('div')?.querySelector('span')?.textContent?.trim() || ''} ${b.textContent}</span>`).join('');
  if (hubStatus) hubStatus.textContent = active.map(b => (b.closest('div')?.querySelector('span')?.textContent?.trim() || '') + ' ' + b.textContent).join(', ');
  renderHubChips();
}

// ─────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────
function switchTab(name) {
  const tabs = ['manual', 'auto', 'stream', 'hub'];
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', tabs[i] === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'hub' || name === 'manual' || name === 'stream') fetchManualSets();
}

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────
let discordOverrides = {};
try { discordOverrides = JSON.parse(localStorage.getItem('abbey_discord_overrides') || '{}'); } catch (e) { }

function saveOverrides() {
  localStorage.setItem('abbey_discord_overrides', JSON.stringify(discordOverrides));
}

function manualLink(tag) {
  const input = document.getElementById('ml-' + tag);
  const id = input?.value.trim().replace(/\D/g, '');
  if (!id) { toast('Paste a numeric Discord user ID', true); return; }
  discordOverrides[tag.toLowerCase()] = id;
  saveOverrides();
  // Also persist to the full discord map
  try { const m = JSON.parse(localStorage.getItem('abbey_discord_map') || '{}'); m[tag.toLowerCase()] = id; localStorage.setItem('abbey_discord_map', JSON.stringify(m)); } catch (e) { }
  const p = tagMap.get(tag.toLowerCase());
  if (p) p.discordId = id;
  renderCsvStatus();
  toast(`✓ Linked ${tag}`);
}

// (Attendee/CSV logic moved to csv-handler.js)


// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────
async function sggQuery(query) {
  const token = document.getElementById('sggToken').value.trim();
  if (!token) throw new Error('Enter your start.gg API token first');
  const res = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data;
}

async function browseEvents() {
  const picker = document.getElementById('eventPicker');
  const btn = document.getElementById('browseBtn');
  const input = document.getElementById('tournamentSlug').value.trim() || localStorage.getItem('abbey_tournament_slug') || '';
  if (picker.style.display !== 'none') { picker.style.display = 'none'; btn.textContent = 'Browse ▾'; return; }
  if (!input) { showStatus('settingsStatus', '✗ Enter a tournament name or slug', false); return; }
  btn.textContent = '⏳'; btn.disabled = true;
  showStatus('settingsStatus', `Resolving "${input}"…`, true);
  try {
    let tournament = null;
    const directData = await sggQuery(`query { tournament(slug: "${input}") { slug name events { id name } } }`);
    tournament = directData?.data?.tournament;
    if (!tournament) {
      showStatus('settingsStatus', `Not a full slug — searching by name…`, true);
      const searchData = await sggQuery(`query { tournaments(query: { filter: { name: "${input}" }, sortBy: "startAt desc", perPage: 5 }) { nodes { slug name startAt events { id name } } } }`);
      const nodes = searchData?.data?.tournaments?.nodes || [];
      if (!nodes.length) throw new Error(`No tournament found for "${input}"`);
      tournament = nodes[0];
      document.getElementById('tournamentSlug').value = tournament.slug;
      localStorage.setItem('abbey_tournament_slug', tournament.slug);
      showStatus('settingsStatus', `Resolved → ${tournament.slug}`, true);
    }
    const events = tournament.events || [];
    const currentId = localStorage.getItem('abbey_sgg_event');
    // Store event data for click handler, avoid inline quoting issues
    picker._tournamentName = tournament.name;
    picker._events = events;
    const currentIdStr = String(currentId || '');
    picker.innerHTML = `<div class="event-picker">
      <div class="t-name">${tournament.name}</div>
      ${events.map(e => `<div class="event-opt ${String(e.id) === currentIdStr ? 'selected' : ''}" data-event-id="${e.id}">
        <span>${e.name}</span><span class="eid">#${e.id}</span>
      </div>`).join('')}
    </div>`;
    picker.onclick = function (ev) {
      const opt = ev.target.closest('[data-event-id]');
      if (!opt) return;
      selectEvent(opt.dataset.eventId, picker._events.find(e => String(e.id) === opt.dataset.eventId)?.name || '', picker._tournamentName);
    };
    picker.style.display = 'block'; btn.textContent = 'Browse ✕';
    showStatus('settingsStatus', `${events.length} events — select one`, true);
  } catch (e) {
    showStatus('settingsStatus', `✗ ${e.message}`, false); btn.textContent = 'Browse ▾';
  } finally { btn.disabled = false; }
}


function selectEvent(id, eventName, tournamentName) {
  document.getElementById('sggEvent').value = String(id);
  localStorage.setItem('abbey_sgg_event', String(id));
  document.getElementById('eventPicker').style.display = 'none';
  document.getElementById('browseBtn').textContent = 'Browse ▾';
  document.getElementById('eventHint').textContent = `${tournamentName} › ${eventName} (#${id})`;
  document.getElementById('selectedEventField').style.display = 'block';
  saveSettings(); toggleSetup(true); toast('Event selected!');
}

async function loadPhaseGroups() {
  const eventField = getEventField();
  if (!eventField) { toast('Select an event first', true); return; }
  const btn = $('loadPhasesBtn');
  const status = $('pgLoadStatus');
  btn.textContent = '⏳'; btn.disabled = true; status.textContent = '';
  try {
    const data = await sggQuery(`query {
      ${eventField} {
        tournament {
          streams { id streamName }
          stations(page: 1, perPage: 30) { nodes { id number } }
        }
        phases {
          id name phaseOrder
          phaseGroups(query: { page: 1, perPage: 20 }) {
            nodes { id displayIdentifier state }
          }
        }
      }
    }`);
    const tourney = data?.data?.event?.tournament;
    if (tourney) {
      streamList = tourney.streams || [];
      stationList = (tourney.stations?.nodes || []).sort((a, b) => a.number - b.number);
    }
    const phases = data?.data?.event?.phases || [];
    const savedFilter = localStorage.getItem('abbey_pg_filter') || '';
    const savedIds = savedFilter ? savedFilter.split(',').map(s => s.trim()) : [];
    const container = document.getElementById('phaseGroupCheckboxes');
    container.innerHTML = '';
    for (const phase of phases.sort((a, b) => a.phaseOrder - b.phaseOrder)) {
      const groups = phase.phaseGroups?.nodes || [];
      if (!groups.length) continue;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;min-width:54px;';
      label.textContent = phase.name;
      row.appendChild(label);
      for (const pg of groups) {
        const isChecked = savedIds.includes(String(pg.id));
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.pgId = String(pg.id);
        chip.textContent = groups.length === 1 ? 'Pool 1' : `Pool ${pg.displayIdentifier}`;
        chip.style.cssText = `padding:4px 12px;border-radius:20px;border:1px solid ${isChecked ? 'var(--accent)' : 'var(--border)'};background:${isChecked ? 'rgba(0,229,160,0.15)' : 'transparent'};color:${isChecked ? 'var(--accent)' : 'var(--muted)'};font-family:'Space Mono',monospace;font-size:0.72rem;cursor:pointer;transition:all 0.12s;`;
        chip.onclick = function () {
          const active = this.style.color === 'var(--accent)' || this.style.color.includes('229');
          this.style.borderColor = active ? 'var(--border)' : 'var(--accent)';
          this.style.background = active ? 'transparent' : 'rgba(0,229,160,0.15)';
          this.style.color = active ? 'var(--muted)' : 'var(--accent)';
          saveSettings();
        };
        row.appendChild(chip);
      }
      container.appendChild(row);
    }

    // Consolidate dropdown population to a single robust function
    renderStreamSetupSelectors();

    btn.textContent = '↻ Refresh';
    updateFilterBar();
    renderHubChips();
    renderStreamPriorityPicker(phases);
    renderPriorityStreamSelector();
  } catch (e) {
    status.textContent = `Error: ${e.message}`; toast(`✗ ${e.message}`, true); btn.textContent = '↻ Load Phases';
  } finally { btn.disabled = false; }
}

function resolvePlayer(entrantName) {
  if (!entrantName) return null;
  const lower = entrantName.toLowerCase().trim();
  if (tagMap.has(lower)) return tagMap.get(lower);
  // normalize spaces around pipe: 'NSB  |  KXT' -> 'nsb | kxt'
  const normalized = lower.replace(/\s*\|\s*/g, ' | ');
  if (tagMap.has(normalized)) return tagMap.get(normalized);
  const stripped = entrantName.replace(/^[^|]+\|\s*/, '').trim().toLowerCase();
  if (stripped && tagMap.has(stripped)) return tagMap.get(stripped);
  return null;
}

// ─────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────
async function sendWebhook(content) {
  const webhook = document.getElementById('webhookUrl').value.trim();
  if (!webhook) return;
  await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
}

// ─────────────────────────────────────────────────────────────
// Ping flair — normal default with 1% cringe roll, 1/8192 shiny
// ─────────────────────────────────────────────────────────────

// CRINGE_RATE: chance any single ping rolls the cringe template instead of the
// normal one. Set to 0 to disable entirely. Currently 1% — once or twice per
// large tournament. The cringe template is the only one that signs off as LarsBars.
const CRINGE_RATE = 0.01;

// Cringe pool — kept around as an easter egg. Only fires CRINGE_RATE of the time.
const PING_INTROS_CRINGE = [
  '🥺 pwease come pway 🥺',
  '👉👈 hewwo your match is wittle bit weady',
  '✨💖 hey besties 💖✨ match time!',
  'OMG ROUND TWO?!?!?! 🎀🎀🎀',
  '💀 not me having to call you 💀',
  '✨ slay queens (and kings) ✨ time to throw',
  '🤓☝️ um actually your match is up',
  '💗💗 hi besties guess what 💗💗',
  'fr fr no cap your match is called 🧢',
  '🥹 it\'s giving... your match. it\'s giving your match.',
  'skibidi bracket wants u 😎',
  'rizz check: you up 🫦',
  'POV: you opened discord and saw this 📲',
  '🎀 bestie ur match called and i fear u must answer 🎀',
  '👁️👄👁️ ur match. it\'s here.',
  '🍃🍃 babe wake up new match dropped 🍃🍃',
  'periodt 💅 ur match is called',
];
const PING_DIRECTIONS_CRINGE = [
  '🚶 walk your wittle wegs to the TO area uwu',
  '🪜 those stairs aren\'t gonna climb themselves bestie',
  '✨ teleport to the TO desk ✨ (jk just walk)',
  '🛗 imaginary elevator to the TO area is broken 💔 take stairs queen',
  '🦵 LEG DAY 💪 stairs to TO area, let\'s gooo',
  '🥾 hike up to the TO area like the main character u are',
];
const PING_WARNINGS_CRINGE = [
  '💀 don\'t be mid, be ON TIME (<t:%t:t>) bestie or get that L (<t:%t:R>)',
  '⏰ <t:%t:t> ✨ deadline ✨ or you\'re getting that L tier behavior (<t:%t:R>)',
  '🤡 don\'t be the clown who DQs themselves <t:%t:t> (<t:%t:R>)',
  '📵 <t:%t:t> bestie or it\'s a ✨skill issue✨ (<t:%t:R>)',
  '🪦 RIP your bracket run if you\'re not there by <t:%t:t> (<t:%t:R>)',
  '👻 ghost the bracket by <t:%t:t> = automatic L (<t:%t:R>)',
];
const PING_QUEUE_CRINGE = [
  '🎀 OMG bestie u just got slotted into the stream queue 🎀',
  '✨ u in the stream queue now ✨ act surprised on camera',
  '📺 stream said: \'we want u\' (eventually) 💗',
  '🥺 ur in line for stream, pls don\'t leave the venue uwu',
];
const PING_STREAM_MOVE_CRINGE = [
  '📺 babe wake up new stream slot just dropped 🛏️',
  '🎀 stream is feeling generous today, you got promoted 🎀',
  '✨💖 yass queen STREAM TIME 💖✨',
  '📺 not me putting you on stream 💀',
  '🤳 caught in 4k now bestie',
  'POV: ur about to be a clip 🎬',
  'main character energy unlocked 🌟 stream incoming',
];

// ─── Normal templates — single fixed wording per slot ───
function buildNormalCallPing({ mA, mB, loc, roundText, dqTimestamp }) {
  return (
    `📢 **Set called** — ${mA} vs ${mB}\n` +
    `📍 **${loc}** *(${roundText})*\n` +
    `🪜 Head to the TO area upstairs to check in.\n` +
    `⏰ Be there by <t:${dqTimestamp}:t> (<t:${dqTimestamp}:R>) or risk DQ.\n` +
    `——————————————————`
  );
}

function buildNormalQueuePing({ mA, mB, streamLabel, roundText }) {
  return (
    `🎬 **You're in the stream queue** — ${mA} vs ${mB}\n` +
    `📺 Queued up for **${streamLabel}** *(${roundText})*\n` +
    `Stay nearby and keep an eye on Discord — we'll ping again when you're called to the stream setup.\n` +
    `——————————————————`
  );
}

function buildNormalRerouteToQueuePing({ mA, mB, streamLabel, roundText, fromLoc }) {
  return (
    `🔄 **Sorry for the double ping!** ${mA} vs ${mB}\n` +
    `We're moving you from ${fromLoc} — you're now in the **${streamLabel}** stream queue *(${roundText})*\n` +
    `Ignore the previous ping. Stay close and keep an eye on Discord — we'll ping again when you're called to the stream setup.\n` +
    `——————————————————`
  );
}

function buildNormalStreamCallPing({ mA, mB, streamLabel, roundText }) {
  return (
    `🎥 **You're up on stream** — ${mA} vs ${mB}\n` +
    `📺 Head to the **${streamLabel}** setup now and get ready to play *(${roundText})*\n` +
    `——————————————————`
  );
}

// ─── Cringe templates — only fire CRINGE_RATE of the time ───
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function isSFMeleeStream(label) { return /sf\s*_*melee/i.test(String(label || '')); }

const PING_DISCLAIMER = `*My name is LarsBars and I don't approve this message.*`;

function buildCringeCallPing({ mA, mB, loc, roundText, dqTimestamp }) {
  return (
    `${pick(PING_INTROS_CRINGE)} — ${mA} vs ${mB} — ${loc} *(${roundText})*\n` +
    `${pick(PING_DIRECTIONS_CRINGE)}\n` +
    `${pick(PING_WARNINGS_CRINGE).replaceAll('%t', String(dqTimestamp))}\n` +
    `——————————————————\n` +
    `${PING_DISCLAIMER}`
  );
}

function buildCringeQueuePing({ mA, mB, streamLabel, roundText }) {
  return (
    `${pick(PING_QUEUE_CRINGE)}\n` +
    `${mA} vs ${mB} → 🎬 queued for **${streamLabel}** *(${roundText})*\n` +
    `Don't wander off bestie ✨ we'll ping again when ur up\n` +
    `——————————————————\n` +
    `${PING_DISCLAIMER}`
  );
}

function buildCringeRerouteToQueuePing({ mA, mB, streamLabel, roundText, fromLoc }) {
  return (
    `${pick(PING_QUEUE_CRINGE)}\n` +
    `${mA} vs ${mB}: forget ${fromLoc} bestie 💅 you've been rerouted to the **${streamLabel}** queue *(${roundText})*\n` +
    `Hold tight ✨ we'll ping when ur up\n` +
    `——————————————————\n` +
    `${PING_DISCLAIMER}`
  );
}

function buildCringeStreamCallPing({ mA, mB, streamLabel, roundText }) {
  return (
    `${pick(PING_STREAM_MOVE_CRINGE)}: ${mA} vs ${mB} → **${streamLabel}** *(${roundText})*\n` +
    `🎥 Get to the **${streamLabel}** setup and don't be cringe (we're allowed, you aren't)\n` +
    `——————————————————\n` +
    `${PING_DISCLAIMER}`
  );
}

// 1 in 8192 — Pokémon shiny odds. Layered on top of normal/cringe selection,
// independent. Shiny pings get the rarity callout regardless of which body was picked.
function rollShiny() { return Math.floor(Math.random() * 8192) === 0; }
function rollCringe() { return Math.random() < CRINGE_RATE; }

// ─── Public ping builders — what the rest of the code calls ───
// All three return { content, shiny } so the caller can react to rare events.

function buildCallPing({ mA, mB, loc, roundText, dqTimestamp }) {
  const shiny = rollShiny();
  const cringe = rollCringe();
  let body = cringe
    ? buildCringeCallPing({ mA, mB, loc, roundText, dqTimestamp })
    : buildNormalCallPing({ mA, mB, loc, roundText, dqTimestamp });
  if (shiny) {
    body =
      `✨🌟✨ **A SHINY MATCH APPEARED** ✨🌟✨\n` +
      `*(1 in 8192 odds — congrats, you witnessed the rarest ping the matchcaller can produce)*\n\n` +
      body +
      `\n🌈 *This set is now part of Abbey Tavern lore.*`;
  }
  return { content: body, shiny };
}

function buildQueuePing({ mA, mB, streamLabel, roundText }) {
  const shiny = rollShiny();
  const cringe = rollCringe();
  let body = cringe
    ? buildCringeQueuePing({ mA, mB, streamLabel, roundText })
    : buildNormalQueuePing({ mA, mB, streamLabel, roundText });
  if (shiny) {
    body =
      `✨🌟✨ **A SHINY QUEUE PLACEMENT** ✨🌟✨\n` +
      `*(1/8192 odds — extremely rare flex)*\n\n` +
      body +
      `\n🌈 *Today is your day.*`;
  }
  return { content: body, shiny };
}

// Use this when a set was already pinged to a station and is now being
// rerouted to the stream queue (TO assigned a stream to it externally on
// start.gg). Different ping than buildQueuePing because the player already
// got a "go to Station X" message — this one tells them to ignore that.
function buildRerouteToQueuePing({ mA, mB, streamLabel, roundText, fromLoc }) {
  const shiny = rollShiny();
  const cringe = rollCringe();
  let body = cringe
    ? buildCringeRerouteToQueuePing({ mA, mB, streamLabel, roundText, fromLoc })
    : buildNormalRerouteToQueuePing({ mA, mB, streamLabel, roundText, fromLoc });
  if (shiny) {
    body =
      `✨🌟✨ **A SHINY REROUTE** ✨🌟✨\n` +
      `*(1/8192 odds — extremely rare)*\n\n` +
      body +
      `\n🌈 *Today is your day.*`;
  }
  return { content: body, shiny };
}

// Use this when actually calling someone TO the stream setup (queue head → live).
function buildStreamCallPing({ mA, mB, streamLabel, roundText }) {
  const shiny = rollShiny();
  const cringe = rollCringe();
  let body = cringe
    ? buildCringeStreamCallPing({ mA, mB, streamLabel, roundText })
    : buildNormalStreamCallPing({ mA, mB, streamLabel, roundText });
  if (shiny) {
    body =
      `✨🌟✨ **A SHINY STREAM CALL** ✨🌟✨\n` +
      `*(1/8192 odds — extremely rare flex)*\n\n` +
      body +
      `\n🌈 *Today is your day.*`;
  }
  return { content: body, shiny };
}

// Legacy alias — used to be called when we did "move to stream" as one operation.
// Now structurally we have queue (buildQueuePing) and call (buildStreamCallPing).
// Kept here so any outside reference still resolves.
function buildStreamMovePing(args) { return buildStreamCallPing(args); }

// ─────────────────────────────────────────────────────────────
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
  const set = activeSetsData.find(s => String(s.id) === String(setId)) || pendingSetsData.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }
  const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
  const nA = set.slots[0]?.entrant?.name || 'Player 1', nB = set.slots[1]?.entrant?.name || 'Player 2';
  const hasA = hubCheckins.has(`${set.id}-${idA}`), hasB = hubCheckins.has(`${set.id}-${idB}`);

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
      sublabel: 'Both players checked in',
      variant: 'primary',
      icon: '▶️',
      onClick: () => markInProgressQuick(set.id),
    });
  }

  let context = '';
  if (!hasA && !hasB) context = '<strong style="color:var(--accent2)">Neither player checked in.</strong> Choose who to DQ.';
  else if (!hasA) context = `<strong>${nA}</strong> is missing. <strong>${nB}</strong> is checked in.`;
  else if (!hasB) context = `<strong>${nB}</strong> is missing. <strong>${nA}</strong> is checked in.`;
  else context = 'Both players are checked in. You can DQ someone manually or start the set.';

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
  const set = activeSetsData.find(s => String(s.id) === String(setId)) || allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }

  // Track the freed station (if any) so the venue dashboard can immediately
  // show it as available
  const previousStationId = set.station?.id;

  // Mark this assignment as already announced — the next poll will see the
  // stream assignment in start.gg's data and we don't want to double-ping.
  streamAnnouncedSetIds.add(String(setId));

  try {
    await sggQuery(`mutation { assignStream(setId: "${setId}", streamId: "${streamId}") { id } }`);
    // start.gg keeps the station assignment around when you assign a stream;
    // we treat any set with both as "on stream, station free" via
    // updateVenueDashboardUI's busy-id logic. Locally clear so the UI matches.
    set.stream = { id: streamId, streamName: streamName };

    // Lock the new stream so it doesn't double-book
    recentlyAssignedLocs.set(String(streamId), Date.now());
    // Free the previously locked station (if any)
    if (previousStationId) recentlyAssignedLocs.delete(String(previousStationId));

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
    streamAnnouncedSetIds.delete(String(setId));
    toast(`✗ Move to stream failed: ${e.message}`, true);
    addPollLog(`⚠️ moveToStream(${setId} → ${streamId}) failed: ${e.message}`, 'err');
  }
}

function requestMoveToStream(setId, streamId, streamName) {
  const set = activeSetsData.find(s => String(s.id) === String(setId)) || allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }

  const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
  const fromStation = set.station?.number ? `Station ${set.station.number}` : null;

  showConfirmModal({
    title: '📺 Move to Stream',
    message: `Move <strong>${nA} vs ${nB}</strong> to <strong>${streamName}</strong>?` +
      (fromStation ? `<br><br>This will free up <strong>${fromStation}</strong> and ping the players in Discord.`
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
  const set = activeSetsData.find(s => String(s.id) === String(setId));
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
              recentlyAssignedLocs.set(String(set.station.id), Date.now());
            }
            // Locally clear stream
            const oldStreamId = set.stream?.id;
            set.stream = null;
            if (oldStreamId) recentlyAssignedLocs.delete(String(oldStreamId));
            // Allow this set to be re-announced if it gets put back on stream later
            streamAnnouncedSetIds.delete(String(setId));
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
  if (completedSetIds.has(String(setId))) return;
  completedSetIds.add(String(setId));
  try {
    await sggQuery(`mutation DQSet { reportBracketSet(setId: "${setId}", winnerId: "${winnerId}", isDQ: true) { id state } }`);
    announcedSetIds.delete(String(setId));
    hubCheckins.delete(`${setId}-${winnerId}`); hubCheckins.delete(`${setId}-${loserId}`); saveCheckins();
    // Leave _hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }
    addPollLog(auto ? `⚡ AUTO-DQ — ${winnerName} advances` : `✓ DQ — ${winnerName} wins`, 'err');
    toast(`✓ DQ: ${winnerName} wins`);
    await fetchManualSets();
  } catch (e) { completedSetIds.delete(String(setId)); toast(`✗ DQ failed: ${e.message}`, true); }
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
    completedSetIds.add(String(setId)); announcedSetIds.delete(String(setId));
    hubCheckins.delete(`${setId}-${idA}`); hubCheckins.delete(`${setId}-${idB}`); saveCheckins();
    // Leave _hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }
    fetchManualSets();
  } catch (e) { toast(`✗ ${e.message}`, true); }
}

async function enforceAutoDQManual(setId) {
  const set = activeSetsData.find(s => String(s.id) === String(setId)) || pendingSetsData.find(s => String(s.id) === String(setId));
  if (!set) return;
  const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
  const nA = set.slots[0]?.entrant?.name || 'Player 1', nB = set.slots[1]?.entrant?.name || 'Player 2';
  const seedA = set.slots[0]?.seed?.seedNum || 9999, seedB = set.slots[1]?.seed?.seedNum || 9999;
  const hasA = hubCheckins.has(`${set.id}-${idA}`), hasB = hubCheckins.has(`${set.id}-${idB}`);
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
  pollLogEntries.unshift({ time, msg, type });
  if (pollLogEntries.length > 200) pollLogEntries.pop();
  const el = document.getElementById('pollLog');
  if (el) el.innerHTML = pollLogEntries.map(e => `<div class="entry ${e.type}">[${e.time}] ${e.msg}</div>`).join('');
}

function copyPollLog() {
  const text = pollLogEntries.map(e => `[${e.time}] ${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Log copied to clipboard!'));
}

// Strip the "SPONSOR | " prefix from an entrant name for compact log lines.
// Falls back to the CSV's Short GamerTag if loaded, else the substring after
// the last `|`. Returns '???' for empty/missing names.
function compactName(name) {
  if (!name) return '???';
  const player = (typeof tagMap !== 'undefined' && tagMap.get)
    ? tagMap.get(String(name).toLowerCase())
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
  const streamParts = streamList.map(stream => {
    const sid = String(stream.id);
    const live = active.filter(s => String(s.stream?.id) === sid);
    const liveLabel = live.length
      ? live.map(s => `${s.state === 2 ? '▶' : '⏸'}${compactSet(s)}`).join(',')
      : '—';
    const queue = streamQueues[sid] || [];
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
  const totalQueued = Object.values(streamQueues).reduce((n, q) => n + (q?.length || 0), 0);
  const trackedLine = `🧠 announced=${announcedSetIds.size} streamCalled=${streamAnnouncedSetIds.size} queuePinged=${queuePingedSetIds.size} inQueues=${totalQueued} completed=${completedSetIds.size}`;

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
    ...streamList.map((s, i) => ({ id: s.id, type: 'stream', label: `🎥 ${s.streamName}`, sortIdx: -1000 + i }))
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
  for (const [locId, timestamp] of recentlyAssignedLocs.entries()) {
    if (now - timestamp < 180000) { // 3 minutes protection
      busyIds.add(String(locId));
    } else {
      recentlyAssignedLocs.delete(locId); // cleanup old locks
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
// Poll
// ─────────────────────────────────────────────────────────────
async function doPoll() {
  addPollLog('Checking start.gg…');
  const eventField = getEventField();
  if (!eventField) return;

  try {
    const [setData, venueData] = await Promise.all([
      sggQuery(`query PollSets { ${eventField} { sets(page: 1, perPage: 50, filters: { state: [1,2,6] }) { nodes { id state fullRoundText createdAt updatedAt phaseGroup { id phase { id phaseOrder } } station { id number } stream { id streamName } slots { prereqType prereqId prereqPlacement seed { seedNum } entrant { id name } } } } } }`),
      sggQuery(`query PollVenue { ${eventField} { tournament { id streams { id streamName } stations(page: 1, perPage: 30) { nodes { id number } } } } }`).catch(() => null)
    ]);

    const allSets = setData?.data?.event?.sets?.nodes || [];
    if (venueData?.data?.event?.tournament) {
      const tourney = venueData.data.event.tournament;
      stationList = (tourney.stations?.nodes || []).sort((a, b) => a.number - b.number);
      streamList = tourney.streams || [];
      
      // NOTE: We deliberately do NOT sync from start.gg's streamQueue field.
      // The local streamQueues object is the authoritative source of truth for
      // queue ordering. start.gg's streamQueue is a flat list of every set
      // with a stream assigned (including live sets) and overwriting locally
      // from it created duplicate-entry and routing bugs. External assignments
      // are still detected below via set.stream + set.state and routed into
      // the local queue through addToStreamQueue.
    }

    const { freeLocs } = updateVenueDashboardUI(allSets);
    let availableStations = freeLocs.filter(l => l.type === 'station').sort((a, b) => a.sortIdx - b.sortIdx);

    allFetchedSets = allSets;
    activeSetsData = allSets.filter(s => s.state === 2 || s.state === 6);
    pendingSetsData = allSets.filter(s => s.state === 1 && s.slots?.[0]?.entrant?.id && s.slots?.[1]?.entrant?.id);

    const autoOn = document.getElementById('autoAssignToggle')?.checked;
    const bypassPhase = document.getElementById('bypassPhaseToggle')?.checked;
    const lowestPhase = getLowestIncompletePhase();
    const lockedPending = pendingSetsData.filter(s => (s.phaseGroup?.phase?.phaseOrder ?? 999) === lowestPhase);
    const usableStationCount = stationList.length - getPlaceholderStationIds().size;
    addPollLog(`📊 auto:${autoOn ? "ON" : "OFF"} | bypassPhase:${bypassPhase ? "ON" : "OFF"} | total:${allSets.length} | pending:${pendingSetsData.length}(eligible:${lockedPending.length}) | free:${freeLocs.length}(stn:${usableStationCount} str:${streamList.length}) | active:${activeSetsData.length}`);

    // Per-cycle state snapshot: streams + queues, stations + occupants,
    // tracking-set sizes. Reflects what start.gg sent us this poll, BEFORE
    // any mutations the poll is about to apply (auto-assigns, queue moves,
    // etc.) — those will show up as their own log lines below.
    try {
      for (const line of buildPollSnapshot(allSets, freeLocs)) addPollLog(line);
    } catch (e) {
      addPollLog(`⚠️ snapshot failed: ${e.message}`, 'err');
    }

    // 1. EXTERNAL CALL DETECTOR — process externally-called sets before auto-assigning
    const calledSets = allSets.filter(s => s.state === 6);
    let pingCount = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const autoDqOn = document.getElementById('autoDqToggle')?.checked !== false;

    for (const set of calledSets) {
      if (completedSetIds.has(String(set.id))) continue;

      // If this set was added to a stream queue locally, skip the entire
      // station ping flow. The queue ping has already been sent. When the TO
      // promotes the queued set to stream, they'll get the Stream Call ping.
      // We do NOT want the player getting both "you're queued for stream"
      // AND "go to station 1" — that's contradictory and confusing.
      if (isInAnyQueue(set.id)) {
        announcedSetIds.add(String(set.id)); // mark as handled so it doesn't trigger later
        continue;
      }

      // Automatically assign a station if it was called externally without one.
      // NOTE: Only stations — never streams. Streams are handled manually via
      // the Stream Queue in the Player Hub.
      if (!set.station && !set.stream && availableStations.length > 0) {
        const locToAssign = availableStations.shift();
        try {
          await sggQuery(`mutation { assignStation(setId: "${set.id}", stationId: "${locToAssign.id}") { id } }`);
          set.station = { id: locToAssign.id, number: locToAssign.sortIdx };
          recentlyAssignedLocs.set(String(locToAssign.id), Date.now());
        } catch (e) {
          addPollLog(`⚠️ Failed to auto-fix missing station for ${set.id}: ${e.message}`, 'err');
        }
      }

      if (!announcedSetIds.has(String(set.id))) {
        announcedSetIds.add(String(set.id));
        const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
        const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
        const loc = set.station?.number ? `Station ${set.station.number}` : set.stream?.streamName ? `🎥 ${set.stream.streamName}` : '';
        const dTs = Math.floor((Date.now() + DQ_MINUTES * 60 * 1000) / 1000);
        const ping = buildCallPing({ mA, mB, loc: loc || 'NO STATION', roundText: set.fullRoundText, dqTimestamp: dTs });
        await sendWebhook(ping.content);
        logMatch(nA, nB, loc || 'No Station', 'auto', set.id, set.slots[0]?.seed?.seedNum, set.slots[1]?.seed?.seedNum, ping.shiny);
        addPollLog(`${ping.shiny ? '✨ SHINY' : '✓'} Ext. Call Detected: ${nA} vs ${nB}${loc ? ' → ' + loc : ' (no station)'}`, 'new');
        if (ping.shiny) toast('✨ SHINY PING! 1/8192 — go check Discord');
        pingCount++;
      }

      const callTime = set.updatedAt || set.createdAt || nowSec;
      if ((nowSec - callTime) / 60 >= DQ_MINUTES && autoDqOn) {
        await enforceAutoDQ(set);
      }
    }

    // 1.5 EXTERNAL STREAM-ASSIGNMENT DETECTOR + AUTO-PROMOTION
    //
    // Track which streams are currently occupied by a live set (state 2 or 6).
    // The auto-promote loop later in this function uses this to skip streams
    // that already have a set live on them. The state-2/6 detector branches
    // also add to this set defensively to prevent same-poll double-promotion.
    const occupiedStreamIds = new Set();
    for (const s of allSets) {
      if ((s.state === 2 || s.state === 6) && s.stream?.id) {
        occupiedStreamIds.add(String(s.stream.id));
      }
    }

    for (const set of allSets) {
      if (!set.stream?.id) continue;
      const sid = String(set.id);
      const streamId = String(set.stream.id);
      const stream = streamList.find(s => String(s.id) === streamId) || { id: streamId, streamName: set.stream.streamName };

      // Always idempotently keep locks in sync with the source of truth.
      if (set.state === 2 || set.state === 6) {
        recentlyAssignedLocs.set(streamId, Date.now());
        if (set.station?.id) recentlyAssignedLocs.delete(String(set.station.id));
      }

      if (set.state === 1) {
        // PENDING — add to queue if not already queued
        const existing = findQueueAssignment(set.id);
        if (!existing || existing.streamId !== streamId) {
          await addToStreamQueue(set.id, streamId, { quiet: true });
          addPollLog(`📋 Ext. Pre-Assigned: ${set.fullRoundText || 'Set ' + sid} → 🎥 ${stream.streamName} (queued)`, 'new');
          await sendQueuePingForSet(set, stream);
        }
      } else if (set.state === 6) {
        // CALLED + STREAM ASSIGNED — TO assigned a stream to a called set.
        // Plan: pull it back into the local stream queue (always). The set
        // gets reset to pending and the station is freed. The auto-promote
        // loop below will pick the queue head when the stream is free.
        // Nothing ever transitions directly from "external stream assignment"
        // to "live on stream" — that path only exists via callQueuedSetToStream.
        const isQueuedHere = (streamQueues[streamId] || []).some(x => String(x) === sid);
        const alreadyAnnounced = streamAnnouncedSetIds.has(sid);
        if (isQueuedHere || alreadyAnnounced) continue;

        const wasPingedToStation = announcedSetIds.has(sid);
        const fromLoc = wasPingedToStation && set.station?.number
          ? `Station ${set.station.number}`
          : null;

        addPollLog(
          fromLoc
            ? `🔄 Ext. Reroute: ${set.fullRoundText || 'Set ' + sid} was at ${fromLoc} → 🎥 ${stream.streamName} queue`
            : `📋 Ext. Stream Assigned: ${set.fullRoundText || 'Set ' + sid} → 🎥 ${stream.streamName} queue`,
          'new'
        );
        await addToStreamQueue(set.id, streamId, { quiet: true });

        // Send appropriate ping. fromLoc → "plans changed" reroute ping.
        // No fromLoc → fresh queue ping (TO assigned stream out of nowhere).
        const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
        if (nA !== '???' && nB !== '???' && !queuePingedSetIds.has(sid)) {
          queuePingedSetIds.add(sid);
          const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
          const ping = fromLoc
            ? buildRerouteToQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText, fromLoc })
            : buildQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText });
          try { await sendWebhook(ping.content); } catch (e) { }
          if (ping.shiny) toast(fromLoc ? '✨ SHINY REROUTE! 1/8192' : '✨ SHINY QUEUE PLACEMENT! 1/8192');
        }

        // Defensively mark this stream as occupied for THIS poll cycle so
        // the auto-promote loop below doesn't immediately yank our just-
        // queued set back into live state on the same tick.
        occupiedStreamIds.add(streamId);
        continue;
      } else if (set.state === 2) {
        // IN-PROGRESS + STREAM ASSIGNED — set is actively being played and
        // has a stream. Two cases:
        //   1. We promoted it via callQueuedSetToStream → already in
        //      streamAnnouncedSetIds, all housekeeping (placeholder station,
        //      stream re-assign) was done at promotion time. Skip.
        //   2. TO assigned stream mid-game → unusual. Track silently as
        //      occupied (so auto-promote doesn't double up) and do the
        //      placeholder swap to free the real station, but NEVER reset
        //      state — players are mid-set and that would be destructive.
        if (streamAnnouncedSetIds.has(sid)) continue;

        streamAnnouncedSetIds.add(sid);
        addPollLog(`📺 Mid-game stream assignment: ${set.fullRoundText || 'Set ' + sid} → 🎥 ${stream.streamName} (no reset, no ping)`, 'new');
        const targetStnId = getPlaceholderStationForStream(streamId);
        if (targetStnId && String(set.station?.id) !== String(targetStnId)) {
          try {
            await sggQuery(`mutation { assignStation(setId: "${sid}", stationId: "${targetStnId}") { id } }`);
          } catch (e) {
            addPollLog(`⚠️ Mid-game placeholder swap failed for ${sid}: ${e.message}`, 'err');
          }
        }
      }
    }

    // AUTO-PROMOTE: If a stream is free and has a queue, promote the head.
    // Gated by the "Autocall next from queue" toggle — when OFF, the TO must
    // manually click ▶ CALL on each queue head.
    // Also respects the pgFilter: if a pool filter is active, auto-promote only
    // calls sets from those phase groups. Sets from other pools stay at the head
    // of the queue until the TO manually promotes them or clears the filter.
    const autoQueueCallOn = document.getElementById('autoQueueCallToggle')?.checked !== false;
    const _pgFilterForPromote = localStorage.getItem('abbey_pg_filter') || '';
    const _pgAllowedForPromote = _pgFilterForPromote
      ? _pgFilterForPromote.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    if (autoQueueCallOn) {
      for (const stream of streamList) {
        const sid = String(stream.id);
        if (!occupiedStreamIds.has(sid)) {
          const queue = streamQueues[sid] || [];
          if (queue.length > 0) {
            const nextSetId = queue[0];
            const nextSet = allSets.find(s => String(s.id) === String(nextSetId));
            // Only promote if both entrants are filled
            if (nextSet && nextSet.slots?.[0]?.entrant?.name && nextSet.slots?.[1]?.entrant?.name) {
              // If a pool filter is active, skip sets from non-matching phase groups.
              // This prevents pool 2 / top-bracket sets from being auto-called while
              // pool 1 is still running. The TO can still manually ▶ CALL them.
              if (_pgAllowedForPromote.length > 0) {
                const setPhaseGroupId = String(nextSet.phaseGroup?.id || '');
                const inAllowedPool = _pgAllowedForPromote.some(allowed => setPhaseGroupId.includes(allowed));
                if (!inAllowedPool) {
                  addPollLog(`⏸ Auto-promote blocked: ${stream.streamName} head (set ${nextSetId}) is outside active pool filter — promote manually`, 'new');
                  continue;
                }
              }

              addPollLog(`🎬 Stream ${stream.streamName} is free — auto-promoting next match ${nextSetId}`, 'new');

              // Mark as occupied IMMEDIATELY so we don't promote another set to the same stream this poll
              occupiedStreamIds.add(sid);

              // Remove from queue first
              streamQueues[sid].shift();
              saveStreamQueues();
              // Call it
              await callQueuedSetToStream(nextSetId, stream.id, stream.streamName);
            }
          }
        }
      }
    }

    // Drop sets from tracking sets once their stream/queue association ends —
    // so re-assigning later (after a pull or completion) pings again.
    const currentlyStreamed = new Set(allSets.filter(s => s.stream?.id && (s.state === 2 || s.state === 6)).map(s => String(s.id)));
    for (const sid of [...streamAnnouncedSetIds]) {
      if (!currentlyStreamed.has(sid)) streamAnnouncedSetIds.delete(sid);
    }
    // queuePingedSetIds GC: drop entries no longer in any queue or live on stream.
    const allQueuedAndLive = new Set([...currentlyStreamed]);
    for (const q of Object.values(streamQueues)) {
      for (const id of q) allQueuedAndLive.add(String(id));
    }
    for (const sid of [...queuePingedSetIds]) {
      if (!allQueuedAndLive.has(sid)) queuePingedSetIds.delete(sid);
    }

    // 2. AUTO-ASSIGN — STATIONS ONLY. Streams are filled manually via the
    // Stream Queue. Auto-assign never picks streams now.
    if (autoOn && pendingSetsData.length > 0 && availableStations.length > 0) {
      const lowestIncompletePhase = getLowestIncompletePhase();

      let pending = [...pendingSetsData];

      // Phase group filter
      const pgFilterRaw = localStorage.getItem('abbey_pg_filter') || '';
      const pgAllowed = pgFilterRaw ? pgFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (pgAllowed.length > 0) {
        // Pool filter active: restrict to selected pools AND strict phase lock
        pending = pending.filter(s => pgAllowed.some(allowed => String(s.phaseGroup?.id || '').includes(allowed)));
        pending = pending.filter(s => (s.phaseGroup?.phase?.phaseOrder ?? 999) === lowestIncompletePhase);
      } else {
        // No pool filter: sort by phase order so lower phases are always called first,
        // but later phases (Top 24 etc.) can fill any remaining free stations
        pending.sort((a, b) => (a.phaseGroup?.phase?.phaseOrder ?? 999) - (b.phaseGroup?.phase?.phaseOrder ?? 999));
      }

      const mainPlaceholderId = localStorage.getItem('abbey_main_stream_station_id') || '';
      const sidePlaceholderId = localStorage.getItem('abbey_side_stream_station_id') || '';
      const availableStations = freeLocs
        .filter(loc => loc.type === 'station')
        .filter(loc => String(loc.id) !== mainPlaceholderId && String(loc.id) !== sidePlaceholderId);

      const samplePgId = pending[0] ? String(pending[0].phaseGroup?.id ?? 'undefined') : (pendingSetsData[0] ? String(pendingSetsData[0].phaseGroup?.id ?? 'undefined') : 'no sets');
      addPollLog(`🔍 after-filters:${pending.length} | pgFilter:[${pgAllowed.join(',')}] | sample pgId:${samplePgId} | stns:${availableStations.length} (streams: manual queue)`);

      // Stream-priority sets (main-only, stream-preferred) are NEVER auto-assigned
      // to a station — they wait in the stream queue for a human to pick them.
      // Queued sets are also skipped — they're waiting in a stream queue and
      // shouldn't be called to a station behind the scenes.
      const stationEligible = pending
        .filter(s => getSetStreamTier(s) === 'normal')
        .filter(s => !isInAnyQueue(s.id))
        .filter(s => !s.stream?.id)
        .filter(s => !streamAnnouncedSetIds.has(String(s.id)))
        .filter(s => !announcedSetIds.has(String(s.id)));

      // Sort: phase order (lower first), then oldest first
      stationEligible.sort((a, b) => {
        const pA = a.phaseGroup?.phase?.phaseOrder ?? 999, pB = b.phaseGroup?.phase?.phaseOrder ?? 999;
        if (pA !== pB) return pA - pB;
        return (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0);
      });

      const assignments = [];
      const n = Math.min(stationEligible.length, availableStations.length);
      for (let i = 0; i < n; i++) {
        assignments.push({ loc: availableStations.shift(), set: stationEligible.shift() });
      }

      for (const { loc, set: ps } of assignments) {
        try {
          // FIX: Mark set as called FIRST, and capture the new ID if it was a preview set
          let targetId = ps.id;
          const callRes = await sggQuery(`mutation { markSetCalled(setId: "${targetId}") { id } }`);

          // Start.gg might have converted a "preview_" ID into a real numeric ID
          if (callRes?.data?.markSetCalled?.id) {
            targetId = callRes.data.markSetCalled.id;
          }
          // THEN assign the station using the updated ID
          // Lock location and announce set immediately to prevent double-calls
          recentlyAssignedLocs.set(String(loc.id), Date.now());
          announcedSetIds.add(String(ps.id));
          announcedSetIds.add(String(targetId));

          let assignOk = false;
          try {
            await sggQuery(`mutation { assignStation(setId: "${targetId}", stationId: "${loc.id}") { id } }`);
            assignOk = true;
          } catch (assignErr) { addPollLog(`⚠️ assign failed for ${targetId}: ${assignErr.message}`, 'err'); }

          if (!assignOk) throw new Error(`Assignment failed for ${targetId}`);

          // Inject into local active state so it appears in the Active Matches hub instantly!
          ps.id = targetId;
          ps.state = 6;
          ps.updatedAt = Math.floor(Date.now() / 1000);
          ps.station = { id: loc.id, number: loc.sortIdx };
          if (!activeSetsData.some(s => String(s.id) === String(targetId))) activeSetsData.push(ps);

          // announcedSetIds already set above before assignment

          const nA = ps.slots[0]?.entrant?.name || '???', nB = ps.slots[1]?.entrant?.name || '???';
          const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
          const dTs = Math.floor((Date.now() + DQ_MINUTES * 60 * 1000) / 1000);
          const ping = buildCallPing({ mA, mB, loc: loc.label, roundText: ps.fullRoundText, dqTimestamp: dTs });
          await sendWebhook(ping.content);
          logMatch(nA, nB, loc.label, 'auto', targetId, ps.slots[0]?.seed?.seedNum, ps.slots[1]?.seed?.seedNum, ping.shiny);
          addPollLog(`${ping.shiny ? '✨ SHINY' : '⚡'} Auto-assigned & Pinged: ${nA} vs ${nB} to ${loc.label}`, 'new');
          if (ping.shiny) toast('✨ SHINY PING! 1/8192 — go check Discord');
        } catch (err) { addPollLog(`⚠️ Skipped set ${ps.id}: ${err.message}`, 'err'); completedSetIds.delete(String(ps.id)); }
      }
    }


    if (pingCount === 0) document.getElementById('autoMeta').textContent = `Last poll: ${new Date().toLocaleTimeString()} · ${calledSets.length} sets active`;
    if (!document.querySelector('#activeSetList input:focus')) renderManualSets();
    if (!document.querySelector('#tab-hub input:focus')) renderPlayerHub();
    if (!document.querySelector('#tab-stream input:focus')) renderStreamQueue();
    // Ensure Setup dropdowns update when streams/stations are fetched
    renderStreamSetupSelectors();

  } catch (e) {
    addPollLog(`Error: ${e.message}`, 'err');
    document.getElementById('autoMeta').textContent = `Error at ${new Date().toLocaleTimeString()}: ${e.message}`;
  }
}

async function startPolling() {
  const interval = parseInt(document.getElementById('pollInterval').value);
  if (pollTimer) clearInterval(pollTimer);
  document.getElementById('startPollBtn').disabled = true;
  document.getElementById('stopPollBtn').disabled = false;
  document.getElementById('autoStatus').textContent = 'Watching';
  document.getElementById('autoBadge').style.display = 'inline-flex';
  document.getElementById('autoMeta').textContent = 'Watching for sets called on any device…';
  document.getElementById('manualAutoBar').style.display = 'flex';

  // Pre-populate streamAnnouncedSetIds with currently-streaming sets so that
  // resuming polling after a pause doesn't spam pings for matches that have
  // been on stream for a while. New stream assignments after this point still
  // ping normally.
  for (const s of allFetchedSets) {
    if (s.stream?.id && (s.state === 2 || s.state === 6)) {
      streamAnnouncedSetIds.add(String(s.id));
    }
  }

  // Apply the same filters as auto-assign before forcing a start.gg call
  let validPending = pendingSetsData || [];

  // Skip queued sets — they're waiting for stream promotion, not a station call
  validPending = validPending.filter(s => !isInAnyQueue(s.id));

  const pgFilterRaw = localStorage.getItem('abbey_pg_filter') || '';
  const pgAllowed = pgFilterRaw ? pgFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (pgAllowed.length > 0) {
    validPending = validPending.filter(s => pgAllowed.some(allowed => String(s.phaseGroup?.id || '').includes(allowed)));
  }

  const bypassPhase = document.getElementById('bypassPhaseToggle')?.checked;
  if (!bypassPhase && allFetchedSets.length > 0) {
    const lowestIncompletePhase = getLowestIncompletePhase();
    validPending = validPending.filter(s => (s.phaseGroup?.phase?.phaseOrder ?? 999) === lowestIncompletePhase);
  }

  // Sort oldest first just like auto-assign
  validPending.sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0));

  if (validPending.length > 0) {
    try {
      addPollLog(`⚡ Forcing start.gg call on first pending set: ${validPending[0].id}...`);
      await sggQuery(`mutation { markSetCalled(setId: "${validPending[0].id}") { id } }`);
    } catch (e) {
      addPollLog(`⚠️ Force call failed: ${e.message}`, 'err');
    }
  }

  doPoll();
  pollTimer = setInterval(doPoll, interval);
  addPollLog(`Auto watch started (every ${interval / 1000}s)`, 'new');
  updateHubWatchBtn();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById('startPollBtn').disabled = false;
  document.getElementById('stopPollBtn').disabled = true;
  document.getElementById('autoStatus').textContent = 'Stopped';
  document.getElementById('autoBadge').style.display = 'none';
  document.getElementById('autoMeta').textContent = 'Stopped';
  document.getElementById('manualAutoBar').style.display = 'none';
  addPollLog('Auto watch stopped');
  updateHubWatchBtn();
}

// ─────────────────────────────────────────────────────────────
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
      sggQuery(`query { ${eventField} { sets(page: 1, perPage: 50, filters: { state: [1,2,6] }) { nodes { id state fullRoundText createdAt updatedAt phaseGroup { id phase { id phaseOrder } } station { id number } stream { id streamName } slots { prereqType prereqId prereqPlacement seed { seedNum } entrant { id name } } } } } }`),
      sggQuery(`query { ${eventField} { tournament { streams { id streamName } stations(page: 1, perPage: 30) { nodes { id number } } } } }`).catch(() => null)
    ]);
    const allSets = setData?.data?.event?.sets?.nodes || [];
    allFetchedSets = allSets.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    activeSetsData = allSets.filter(s => s.state === 2 || s.state === 6);
    pendingSetsData = allSets.filter(s => s.state === 1 && s.slots?.[0]?.entrant?.id && s.slots?.[1]?.entrant?.id);
    if (stationData?.data?.event?.tournament) {
      const tourney = stationData.data.event.tournament;
      if (tourney.stations?.nodes) {
        stationList = tourney.stations.nodes.sort((a, b) => a.number - b.number);
      }
      if (tourney.streams) {
        streamList = tourney.streams || [];
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
  const stationsForDropdown = stationList.filter(s => !placeholderIds.has(String(s.id)));
  // Sort by bracket stage (phaseOrder ascending) then by duration (oldest first)
  // For state 6 (called) and state 2 (in progress), use updatedAt as the call/start time
  // For state 1 (pending), use createdAt
  const toRender = allFetchedSets
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
    const ciA = hubCheckins.has(`${set.id}-${a?.id}`), ciB = hubCheckins.has(`${set.id}-${b?.id}`);
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
          ${streamList.length ? `<optgroup label="Streams">${streamList.map(s => `<option value="stream:${s.id}" data-name="${s.streamName}" ${set.stream?.id == s.id ? 'selected' : ''}>🎥 ${s.streamName}</option>`).join('')}</optgroup>` : ''}
        </select>
        <button class="set-call-btn" onclick="callSetFromPanel('${set.id}')">📢 Call</button>
      </div>
    </div>`;
  }).join('');
  updateTimerCache();
}

async function callSetFromPanel(setId) {
  const set = allFetchedSets.find(s => String(s.id) === String(setId));
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
      recentlyAssignedLocs.set(String(sid), Date.now()); // Locally lock the station
    }
    else if (isStream) {
      const sid = stnValue.replace('stream:', '');
      await sggQuery(`mutation { assignStream(setId: "${targetId}", streamId: "${sid}") { id } }`);
      recentlyAssignedLocs.set(String(sid), Date.now()); // Locally lock the stream
    }

    const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
    const locName = isStation ? `Station ${selectedOpt.dataset.num}` : isStream ? `🎥 ${selectedOpt.dataset.name}` : '?';
    const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
    const dTs = Math.floor((Date.now() + DQ_MINUTES * 60 * 1000) / 1000);
    const ping = buildCallPing({ mA, mB, loc: locName, roundText: set.fullRoundText, dqTimestamp: dTs });
    await sendWebhook(ping.content);

    announcedSetIds.add(String(targetId));
    if (targetId !== setId) announcedSetIds.add(String(setId));

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
  if (hubCheckins.has(key)) hubCheckins.delete(key);
  else { hubCheckins.add(key); toast(`🟢 ${name} checked in!`); }
  saveCheckins();
  const set = activeSetsData.find(s => String(s.id) === String(setId)) || pendingSetsData.find(s => String(s.id) === String(setId));
  if (set && set.state === 6) {
    const idA = set.slots[0]?.entrant?.id, idB = set.slots[1]?.entrant?.id;
    if (hubCheckins.has(`${setId}-${idA}`) && hubCheckins.has(`${setId}-${idB}`)) {
      // Re-render first so both checkmarks are visible, then transition after a short delay
      renderPlayerHub(); renderManualSets();
      toast('Both players checked in!');
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
let _scoreKbdBuffer = '', _scoreKbdTimer = null;

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
  if (!stationList.length && !streamList.length) {
    el.innerHTML = '<div style="font-size:0.75rem;color:var(--muted);text-align:center;padding:14px 0;">No stations loaded yet</div>';
    return;
  }

  // Build a quick lookup of who's on which location.
  // Streams take precedence over stations when both are set on a single set.
  const stationOccupants = new Map(); // stationId -> set
  const streamOccupants = new Map(); // streamId  -> set
  const activeForOccupancy = activeSetsData.filter(s => s.state === 2 || s.state === 6);
  for (const s of activeForOccupancy) {
    if (s.stream?.id) streamOccupants.set(String(s.stream.id), s);
    else if (s.station?.id) stationOccupants.set(String(s.station.id), s);
  }

  const rows = [];

  // Streams first (ranked higher visually)
  for (const stream of streamList) {
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
  const sortedStations = stationList
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

// ─────────────────────────────────────────────────────────────
// Stream Queue — manual stream slot management with per-stream queue
// ─────────────────────────────────────────────────────────────

// ─── Queue mutators (all save to localStorage; caller re-renders) ───

// Find which stream queue (if any) a given setId is sitting in. Used by the
// player hub to surface "queued for stream X" state on a player's match card,
// and by other code paths to avoid duplicate queue placements.
function findQueueAssignment(setId) {
  for (const sid of Object.keys(streamQueues)) {
    if (streamQueues[sid].some(x => String(x) === String(setId))) {
      return { streamId: sid, position: streamQueues[sid].findIndex(x => String(x) === String(setId)) };
    }
  }
  return null;
}

// Cheaper boolean variant — used by auto-assign and external-call paths to
// skip any set that's currently sitting in a stream queue. Queued sets must
// not be auto-called to a station, must not be auto-assigned a station, and
// must not generate a Set Called ping if a TO calls them externally.
function isInAnyQueue(setId) {
  const target = String(setId);
  for (const sid of Object.keys(streamQueues)) {
    if (streamQueues[sid].some(x => String(x) === target)) return true;
  }
  return false;
}

function getPlaceholderStationForStream(streamId) {
  const mainStreamId = localStorage.getItem('abbey_main_stream_id');
  const sideStreamId = localStorage.getItem('abbey_side_stream_id');
  if (String(streamId) === String(mainStreamId)) {
    return localStorage.getItem('abbey_main_stream_station_id') || '';
  } else if (String(streamId) === String(sideStreamId)) {
    return localStorage.getItem('abbey_side_stream_station_id') || '';
  }
  return '';
}

// Returns the set of station IDs configured as stream placeholders in the
// Setup card. These stations exist on start.gg but are reserved exclusively
// for stream-bound sets — they should NOT appear in free-station lists,
// auto-assignment pools, or manual assignment dropdowns. The Setup card
// dropdowns themselves are the only place that lists them (since picking
// them is the whole point of those dropdowns).
function getPlaceholderStationIds() {
  const ids = new Set();
  const main = localStorage.getItem('abbey_main_stream_station_id');
  const side = localStorage.getItem('abbey_side_stream_station_id');
  if (main) ids.add(String(main));
  if (side) ids.add(String(side));
  return ids;
}

async function addToStreamQueue(setId, streamId, opts = {}) {
  const sid = String(streamId);
  if (!streamQueues[sid]) streamQueues[sid] = [];
  // Remove from any other stream's queue first (a set can only be queued once)
  for (const otherSid of Object.keys(streamQueues)) {
    if (otherSid === sid) continue;
    streamQueues[otherSid] = streamQueues[otherSid].filter(x => String(x) !== String(setId));
  }
  // Append if not already in this queue
  const alreadyHere = streamQueues[sid].some(x => String(x) === String(setId));
  if (!alreadyHere) {
    streamQueues[sid].push(String(setId));
  }
  saveStreamQueues();

  // If this set was already station-pinged before we queue it, we'll send a
  // "sorry for the double ping / plans changed" reroute message instead of the
  // generic queue ping. Capture this BEFORE we mark it announced below.
  const wasPreviouslyAnnouncedToStation = announcedSetIds.has(String(setId));

  // Defensively suppress the station ping pipeline for this set. If the set
  // is already in state 6 when queued (e.g. you queued an already-called set),
  // the external-call detector would otherwise re-announce it on its next poll.
  // Marking it announced means: "we've already handled the player communication
  // for this set; don't send a station ping for it." The queue ping below is
  // the only player communication this set generates until ▶ CALL.
  announcedSetIds.add(String(setId));

  // If the set has already been called/in-progress on a station, reset it back
  // to pending state on start.gg. This:
  //   • Removes its station assignment, freeing the station for another match
  //   • Drops it from the Active Matches tab (state 6/2 → 1)
  //   • Keeps it visible in the queue
  //
  // resetSet is safe here because queued sets haven't had scores reported yet.
  // We skip the API call if the set never had a station assigned, since there's
  // nothing to reset. Failures are non-fatal — log and continue.
  const setObj = allFetchedSets.find(s => String(s.id) === String(setId)) ||
    activeSetsData.find(s => String(s.id) === String(setId)) ||
    pendingSetsData.find(s => String(s.id) === String(setId));

  // Capture the previous station location before the reset clears it.
  const fromLoc = wasPreviouslyAnnouncedToStation && setObj?.station?.number
    ? `Station ${setObj.station.number}`
    : null;

  const autoStreamAssign = localStorage.getItem('abbey_auto_stream_assign') !== '0';
  const mainStreamId = localStorage.getItem('abbey_main_stream_id');
  const sideStreamId = localStorage.getItem('abbey_side_stream_id');
  
  let targetStationId = '';
  if (String(streamId) === String(mainStreamId)) {
    targetStationId = localStorage.getItem('abbey_main_stream_station_id') || '';
  } else if (String(streamId) === String(sideStreamId)) {
    targetStationId = localStorage.getItem('abbey_side_stream_station_id') || '';
  }

  // 1. If the set is currently active (state 2 or 6), reset it to pending (state 1).
  // This removes it from the "Active Matches" pool and frees the old station.
  // If it's already pending (state 1), we skip the reset to avoid clearing existing assignments.
  if (setObj && (setObj.state === 2 || setObj.state === 6)) {
    try {
      await sggQuery(`mutation { resetSet(setId: "${setId}") { id state } }`);
      // Locally reflect the reset
      const previousStationId = setObj.station?.id;
      setObj.station = null;
      setObj.state = 1;
      if (previousStationId) recentlyAssignedLocs.delete(String(previousStationId));
      activeSetsData = activeSetsData.filter(s => String(s.id) !== String(setId));
      if (!pendingSetsData.some(s => String(s.id) === String(setId))) {
        pendingSetsData.push(setObj);
      }
      _hubSlotIds = _hubSlotIds.filter(id => id !== String(setId));
      addPollLog(`📋 Reset ${setId} to pending for queue`, 'new');
    } catch (e) {
      addPollLog(`⚠️ resetSet failed for ${setId}: ${e.message}`, 'err');
    }
  }

  // 2. Perform stream and dedicated station assignment if enabled.
  if (autoStreamAssign && !opts.localOnly) {
    try {
      if (targetStationId) {
        addPollLog(`📍 [API] Assigning ${setId} to station ${targetStationId}...`);
        const resStn = await sggQuery(`mutation { assignStation(setId: "${setId}", stationId: "${targetStationId}") { id } }`);
        addPollLog(`✅ [API] Station assigned: ${JSON.stringify(resStn?.data?.assignStation || 'OK')}`);
        if (setObj) setObj.station = { id: targetStationId };
      }

      addPollLog(`📺 [API] Assigning ${setId} to stream ${streamId}...`);
      const resStr = await sggQuery(`mutation { assignStream(setId: "${setId}", streamId: "${streamId}") { id } }`);
      addPollLog(`✅ [API] Stream assigned: ${JSON.stringify(resStr?.data?.assignStream || 'OK')}`);
      
      const streamObj = streamList.find(s => String(s.id) === String(streamId));
      if (setObj && streamObj) {
        setObj.stream = { id: streamId, streamName: streamObj.streamName };
      }

      toast('📺 Assigned to stream');
    } catch (e) {
      addPollLog(`❌ [API] Stream/Station assign failed for ${setId}: ${e.message}`, 'err');
    }
  }

  // Ensure unfilled sets are at the bottom
  sortStreamQueue(sid);
  renderStreamQueue();
  if (alreadyHere) { toast('Already in this queue'); return; }
  toast('Added to queue');

  // Send the "you're in the queue" ping. Skip if quiet=true (used by external
  // detector that's already pinging) or if the set has no resolved entrants
  // yet (pre-assignments to unfilled sets). For unfilled sets we re-trigger
  // this when the entrants get filled in via reconcileQueueOnPoll.
  if (opts.quiet) return;
  const set = allFetchedSets.find(s => String(s.id) === String(setId)) ||
    activeSetsData.find(s => String(s.id) === String(setId)) ||
    pendingSetsData.find(s => String(s.id) === String(setId));
  if (!set) return;
  const stream = streamList.find(s => String(s.id) === sid);
  if (!stream) return;

  if (fromLoc && !queuePingedSetIds.has(String(setId))) {
    // Set was already pinged to a station — apologize and explain the change.
    const nA = set.slots[0]?.entrant?.name, nB = set.slots[1]?.entrant?.name;
    if (nA && nB) {
      queuePingedSetIds.add(String(setId));
      const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
      const ping = buildRerouteToQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText, fromLoc });
      try { await sendWebhook(ping.content); } catch (e) { }
      addPollLog(`${ping.shiny ? '✨ SHINY' : '🔄'} Rerouted to queue: ${nA} vs ${nB} → ${stream.streamName}`, 'new');
      if (ping.shiny) toast('✨ SHINY REROUTE! 1/8192');
    }
  } else {
    await sendQueuePingForSet(set, stream);
  }
}

// Wrapped helper so external code paths (the detector) can also send queue pings.
// Marks the set as queue-pinged so we don't double-fire.
async function sendQueuePingForSet(set, stream) {
  const nA = set.slots[0]?.entrant?.name, nB = set.slots[1]?.entrant?.name;
  if (!nA || !nB) return; // unfilled set — wait until entrants resolve
  if (queuePingedSetIds.has(String(set.id))) return; // already pinged
  queuePingedSetIds.add(String(set.id));
  const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
  const ping = buildQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText });
  try { await sendWebhook(ping.content); } catch (e) { }
  addPollLog(`${ping.shiny ? '✨ SHINY' : '🎬'} Queued: ${nA} vs ${nB} → ${stream.streamName}`, 'new');
  if (ping.shiny) toast('✨ SHINY QUEUE PLACEMENT! 1/8192');
}

async function removeFromStreamQueue(setId, streamId) {
  const sid = String(streamId);
  if (!streamQueues[sid]) return;
  streamQueues[sid] = streamQueues[sid].filter(x => String(x) !== String(setId));
  queuePingedSetIds.delete(String(setId));
  announcedSetIds.delete(String(setId));
  streamAnnouncedSetIds.delete(String(setId));
  saveStreamQueues();
  renderStreamQueue();

  // Must also clear the stream assignment on start.gg. Without this, the
  // external-stream-assignment detector sees "pending + stream assigned + not
  // in local queue" and silently re-adds the set on the next poll.
  const setObj = allFetchedSets.find(s => String(s.id) === String(setId)) ||
    activeSetsData.find(s => String(s.id) === String(setId)) ||
    pendingSetsData.find(s => String(s.id) === String(setId));

  if (!setObj || setObj.state === 2 || setObj.state === 6) {
    // No object found, or set is actively in-progress — don't touch assignments.
    toast('Removed from queue');
    return;
  }

  // Find a free real station (exclude stream-placeholder stations and occupied ones).
  const placeholderIds = getPlaceholderStationIds();
  const occupiedStationIds = new Set();
  for (const s of activeSetsData) {
    if (s.station?.id && !s.stream?.id) occupiedStationIds.add(String(s.station.id));
  }
  const nowMs = Date.now();
  for (const [locId, ts] of recentlyAssignedLocs.entries()) {
    if (nowMs - ts < 180000) occupiedStationIds.add(String(locId));
  }
  const openStation = stationList
    .filter(s => !placeholderIds.has(String(s.id)) && !occupiedStationIds.has(String(s.id)))
    .sort((a, b) => a.number - b.number)[0];

  try {
    if (openStation) {
      await sggQuery(`mutation { assignStation(setId: "${setId}", stationId: "${openStation.id}") { id } }`);
      const prevStationId = setObj.station?.id;
      setObj.station = openStation;
      setObj.stream = null;
      recentlyAssignedLocs.set(String(openStation.id), Date.now());
      if (prevStationId && String(prevStationId) !== String(openStation.id)) {
        recentlyAssignedLocs.delete(String(prevStationId));
      }
      addPollLog(`📍 Removed from queue → Station ${openStation.number} (${setId})`, 'new');
      toast(`📍 Removed from queue → Station ${openStation.number}`);
    } else {
      // No free station — reassign to the set's current station to clear the stream
      // on start.gg without changing its station (same technique as pullFromStream).
      const fallbackStationId = setObj.station?.id;
      if (fallbackStationId) {
        await sggQuery(`mutation { assignStation(setId: "${setId}", stationId: "${fallbackStationId}") { id } }`);
        setObj.stream = null;
        addPollLog(`📋 Removed from queue — no free station, stream cleared for ${setId}`, 'new');
        toast('Removed from queue — assign station manually when one frees up');
      } else {
        addPollLog(`⚠️ Removed from queue — ${setId} has no station to fall back on`, 'err');
        toast('Removed from queue (no station available — check start.gg)');
      }
    }
  } catch (e) {
    toast(`✗ Failed to clear stream: ${e.message}`, true);
    addPollLog(`⚠️ removeFromQueue API failed for ${setId}: ${e.message}`, 'err');
  }

  await fetchManualSets();
}

function clearAllQueues() {
  const total = Object.values(streamQueues).reduce((n, q) => n + q.length, 0);
  if (total === 0) { toast('Queues are already empty'); return; }
  showConfirmModal({
    title: '🗑 Clear All Queues',
    message: `This will remove all <strong>${total} queued set${total !== 1 ? 's' : ''}</strong> from every stream queue and wipe the saved queue storage.<br><br>Active stream matches are not affected.`,
    variant: 'danger',
    buttons: [
      {
        label: 'Yes — clear all queues',
        variant: 'danger',
        icon: '🗑',
        onClick: () => {
          streamQueues = {};
          queuePingedSetIds.clear();
          saveStreamQueues();
          renderStreamQueue();
          addPollLog('🗑 All stream queues cleared', 'err');
          toast('🗑 Queues cleared');
        },
      },
    ],
  });
}

function moveInStreamQueue(setId, streamId, dir) {
  const sid = String(streamId);
  const q = streamQueues[sid];
  if (!q) return;
  const idx = q.findIndex(x => String(x) === String(setId));
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= q.length) return;
  [q[idx], q[target]] = [q[target], q[idx]];
  saveStreamQueues();
  renderStreamQueue();
}

/**
 * Sorts a stream's queue: filled sets first (by their current order),
 * then TBD/unfilled sets, then sets whose data can't be found at all
 * ("Match loading…" stubs from stale localStorage entries) at the very bottom.
 * Returns true if the order actually changed.
 */
function sortStreamQueue(streamId) {
  const sid = String(streamId);
  const queue = streamQueues[sid] || [];
  if (!queue.length) return false;

  const filled = [], unfilled = [], missing = [];
  for (const setId of queue) {
    const set = allFetchedSets.find(s => String(s.id) === String(setId)) ||
      activeSetsData.find(s => String(s.id) === String(setId)) ||
      pendingSetsData.find(s => String(s.id) === String(setId));
    if (!set) missing.push(setId);
    else if (set.slots?.[0]?.entrant?.name && set.slots?.[1]?.entrant?.name) filled.push(setId);
    else unfilled.push(setId);
  }
  const sorted = [...filled, ...unfilled, ...missing];
  const changed = sorted.some((id, i) => id !== queue[i]);
  if (changed) {
    streamQueues[sid] = sorted;
    saveStreamQueues();
  }
  return changed;
}

// Strip out finished/missing/already-on-stream sets — runs after every poll.
// Also reconciles: any unfilled pending set in the queue that NOW has both
// entrants gets a queue ping (since we couldn't ping when it was added).
function cleanStreamQueues() {
  let changed = false;
  const newlyResolved = []; // {set, stream} pairs to ping post-cleanup

  for (const sid of Object.keys(streamQueues)) {
    const before = streamQueues[sid].length;
    streamQueues[sid] = streamQueues[sid].filter(setId => {
      const s = activeSetsData.find(x => String(x.id) === String(setId)) ||
        pendingSetsData.find(x => String(x.id) === String(setId)) ||
        allFetchedSets.find(x => String(x.id) === String(setId));

      // If the set isn't in our current fetch, it might be further down in the bracket.
      // We only remove it if we explicitly find it in a completed state.
      if (!s) return true;
      if (s.state === 3) return false; // completed
      if (s.stream?.id && String(s.stream.id) !== sid) return false; // moved to different stream by external action
      // If the set is now live on this stream (state 2 or 6), it has been promoted
      // (externally or otherwise) and should leave the queue — it's now the occupant.
      if ((s.state === 2 || s.state === 6) && s.stream?.id && String(s.stream.id) === sid) return false;
      return true;
    });
    if (streamQueues[sid].length !== before) {
      changed = true;
      sortStreamQueue(sid);
    }

    // Reconciliation pass: identify queued sets whose entrants just got filled
    // in (e.g. winners-side feeds into a Top 8 set), so we can ping them now.
    const stream = streamList.find(s => String(s.id) === sid);
    if (stream) {
      for (const setId of streamQueues[sid]) {
        const s = allFetchedSets.find(x => String(x.id) === String(setId));
        if (!s) continue;
        const filled = !!(s.slots?.[0]?.entrant?.name && s.slots?.[1]?.entrant?.name);
        if (filled && !queuePingedSetIds.has(String(s.id))) {
          newlyResolved.push({ set: s, stream });
        }
      }
    }
  }
  if (changed) saveStreamQueues();

  // Fire pings outside the loop (async; don't await — we want render to finish)
  for (const { set, stream } of newlyResolved) {
    sendQueuePingForSet(set, stream);
  }
}

// Promote head of queue: actually call assignStream API for the first queued match.
// This is the moment we ping "you're up on stream" and run the API call.
function promoteFromQueue(streamId) {
  const sid = String(streamId);
  const q = streamQueues[sid] || [];
  if (!q.length) { toast('Queue is empty for this stream', true); return; }
  const setId = q[0];
  const stream = streamList.find(s => String(s.id) === sid);
  if (!stream) { toast('Stream not found', true); return; }
  const set = activeSetsData.find(s => String(s.id) === String(setId)) ||
    pendingSetsData.find(s => String(s.id) === String(setId)) ||
    allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) {
    streamQueues[sid].shift();
    saveStreamQueues();
    renderStreamQueue();
    toast('Queued match no longer available', true);
    return;
  }
  const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
  const filled = !!(set.slots?.[0]?.entrant?.name && set.slots?.[1]?.entrant?.name);
  const fromStation = set.station?.number ? `Station ${set.station.number}` : null;

  if (!filled) {
    toast('Players not filled in yet — can\'t call', true);
    return;
  }

  showConfirmModal({
    title: '▶ Call to Stream',
    message: `Call <strong>${nA} vs ${nB}</strong> to <strong>${stream.streamName}</strong>?` +
      (fromStation
        ? `<br><br>This will free up <strong>${fromStation}</strong>, assign the set to the stream on start.gg, and ping the players in Discord that they're up.`
        : `<br><br>This will assign the set to the stream on start.gg and ping the players that they're up.`),
    variant: 'info',
    buttons: [{
      label: `Yes — call to ${stream.streamName}`,
      sublabel: fromStation ? `Frees ${fromStation}` : 'Sends Discord ping',
      variant: 'info',
      icon: '🎥',
      onClick: async () => {
        // Drop from queue first so re-renders don't show it twice
        streamQueues[sid] = streamQueues[sid].filter(x => String(x) !== String(setId));
        saveStreamQueues();
        await callQueuedSetToStream(setId, stream.id, stream.streamName);
      },
    }],
  });
}

// Actually fires the API call + the "you're up" ping. Replaces the old
// moveToStream flow for the queue path.
async function callQueuedSetToStream(setId, streamId, streamName) {
  const set = activeSetsData.find(s => String(s.id) === String(setId)) ||
    pendingSetsData.find(s => String(s.id) === String(setId)) ||
    allFetchedSets.find(s => String(s.id) === String(setId));
  if (!set) { toast('Set not found', true); return; }
  const previousStationId = set.station?.id;

  // Mark as already-announced for the external detector so it doesn't double-ping.
  streamAnnouncedSetIds.add(String(setId));

  try {
    // "Call" the set on start.gg (moves State 1 -> 6). This makes it official.
    try {
      addPollLog(`🎬 [API] Marking set ${setId} in progress...`);
      const resProg = await sggQuery(`mutation { markSetInProgress(setId: "${setId}") { id state } }`);
      addPollLog(`✅ [API] Set state: ${JSON.stringify(resProg?.data?.markSetInProgress || 'OK')}`);
    } catch (err) {
      addPollLog(`⚠️ [API] markSetInProgress failed (set might already be active): ${err.message}`, 'err');
    }

    const targetStnId = getPlaceholderStationForStream(streamId);
    if (targetStnId) {
      addPollLog(`📍 [API] Assigning promoted set ${setId} to station ${targetStnId}...`);
      const resStn = await sggQuery(`mutation { assignStation(setId: "${setId}", stationId: "${targetStnId}") { id } }`);
      addPollLog(`✅ [API] Station assigned: ${JSON.stringify(resStn?.data?.assignStation || 'OK')}`);
    }

    addPollLog(`📺 [API] Assigning promoted set ${setId} to stream ${streamId}...`);
    const resStr = await sggQuery(`mutation { assignStream(setId: "${setId}", streamId: "${streamId}") { id } }`);
    addPollLog(`✅ [API] Stream assigned: ${JSON.stringify(resStr?.data?.assignStream || 'OK')}`);

    set.stream = { id: streamId, streamName: streamName };
    set.state = 6; // Locally mark as Called
    recentlyAssignedLocs.set(String(streamId), Date.now());
    if (previousStationId) recentlyAssignedLocs.delete(String(previousStationId));

    const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
    const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
    const ping = buildStreamCallPing({ mA, mB, streamLabel: streamName, roundText: set.fullRoundText });
    await sendWebhook(ping.content);

    addPollLog(`${ping.shiny ? '✨ SHINY' : '🎥'} Called to stream: ${nA} vs ${nB} → 🎥 ${streamName}`, 'new');
    toast(`🎥 ${nA} vs ${nB} called to ${streamName}`);
    if (ping.shiny) toast('✨ SHINY STREAM CALL! 1/8192');

    fetchManualSets();
  } catch (e) {
    streamAnnouncedSetIds.delete(String(setId));
    toast(`✗ Call to stream failed: ${e.message}`, true);
    addPollLog(`⚠️ callQueuedSetToStream(${setId} → ${streamId}) failed: ${e.message}`, 'err');
  }
}

function toggleAddQueuePanel(streamId) {
  const sid = String(streamId);
  if (_expandedAddQueues.has(sid)) _expandedAddQueues.delete(sid);
  else _expandedAddQueues.add(sid);
  renderStreamQueue();
}

// ─── Renderer ───

// Returns { name, projected } for a slot.
// If the slot has an entrant, uses their name directly.
// If the slot is unfilled but has a prereqType="set", looks up the feeder set
// in allFetchedSets and takes the first listed entrant name + "?" as the projection.
// Falls back to "TBD" when no projection is available.
function getProjectedSlotName(slot) {
  if (slot?.entrant?.name) return { name: slot.entrant.name, projected: false };
  if (slot?.prereqType === 'set' && slot?.prereqId) {
    const feederSet = allFetchedSets.find(s => String(s.id) === String(slot.prereqId)) ||
      activeSetsData.find(s => String(s.id) === String(slot.prereqId));
    if (feederSet) {
      const fs0 = feederSet.slots?.[0], fs1 = feederSet.slots?.[1];
      const seed0 = fs0?.seed?.seedNum, seed1 = fs1?.seed?.seedNum;
      // prereqPlacement 1 = winner advances (pick better seed), 2 = loser advances (pick worse seed)
      const wantsWinner = (slot.prereqPlacement ?? 1) === 1;
      let projected = null;
      if (seed0 && seed1) {
        projected = wantsWinner
          ? (seed0 < seed1 ? fs0 : fs1)
          : (seed0 > seed1 ? fs0 : fs1);
      } else {
        projected = fs0; // fallback: no seed data, use slot 0
      }
      const name = projected?.entrant?.name;
      if (name) return { name: name + '?', projected: true };
    }
  }
  return { name: 'TBD', projected: false };
}

function renderStreamQueue() {
  const el = document.getElementById('streamQueueSlots');
  if (!el) return;
  if (!streamList.length) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--muted);padding:10px 0;">No streams configured for this event.</div>';
    return;
  }

  // Clean up dead queue entries before rendering, then re-sort every queue so
  // stale "Match loading…" stubs always sink to the bottom regardless of when
  // they were added (sort only runs on change, so this is cheap on steady state).
  cleanStreamQueues();
  for (const sid of Object.keys(streamQueues)) sortStreamQueue(sid);

  // Build a Set of all setIds currently queued anywhere — used to filter the candidate pool
  const allQueuedIds = new Set();
  for (const sid of Object.keys(streamQueues)) {
    for (const id of streamQueues[sid]) allQueuedIds.add(String(id));
  }

  // Apply the same phase-group filter that auto-assign uses, so disabled pools
  // never appear in the candidate picker. Empty filter = all pools allowed.
  const pgFilterRaw = localStorage.getItem('abbey_pg_filter') || '';
  const pgAllowed = pgFilterRaw ? pgFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const inAllowedPool = (s) => {
    if (!pgAllowed.length) return true;
    return pgAllowed.some(allowed => String(s.phaseGroup?.id || '').includes(allowed));
  };

  // Candidate pool for the queue picker: every actionable set in the event,
  // INCLUDING unfilled pending sets (no entrants yet) — start.gg supports
  // assigning streams to those, so the user can pre-queue Top 8 etc. before
  // the bracket fills in. State 1/2/6, not already on a stream, not already
  // queued anywhere, restricted to enabled pools.
  const candidatePool = allFetchedSets
    .filter(s => s.state === 1 || s.state === 2 || s.state === 6)
    .filter(s => !s.stream?.id)
    .filter(s => !allQueuedIds.has(String(s.id)))
    .filter(inAllowedPool)
    .sort((a, b) => getStreamScore(a) - getStreamScore(b));

  const buildCandidateRow = (set, streamId, streamName) => {
    const slotA = getProjectedSlotName(set.slots[0]);
    const slotB = getProjectedSlotName(set.slots[1]);
    const a = slotA.name, b = slotB.name;
    const filled = !!(set.slots[0]?.entrant?.name && set.slots[1]?.entrant?.name);
    const projected = !filled && (slotA.projected || slotB.projected);
    const sA = set.slots[0]?.seed?.seedNum, sB = set.slots[1]?.seed?.seedNum;
    const score = getStreamScore(set);
    const grade = streamGrade(score);
    const stateLbl = set.state === 1 ? 'pending' : set.state === 2 ? 'in progress' : 'called';
    const fromLoc = set.station?.number ? `Station ${set.station.number}` : stateLbl;
    const round = set.fullRoundText || '';
    const nameStyle = filled ? '' : projected
      ? 'color:var(--text);opacity:0.7;font-style:italic;'
      : 'color:var(--muted);font-style:italic;';
    const metaSuffix = filled ? '' : projected ? ' · projected' : ' · awaiting entrants';
    return `<div class="cand-row" onclick="addToStreamQueue('${set.id}', '${streamId}')" title="Add to ${streamName} queue">
      <div class="cand-info">
        <div class="cand-players" style="${nameStyle}">${a} <span style="color:var(--muted);font-weight:400;font-style:normal;">vs</span> ${b}</div>
        <div class="cand-meta">${round} · ${fromLoc}${sA && sB ? ` · seeds ${sA}/${sB}` : ''}${metaSuffix}</div>
      </div>
      <div class="cand-grade">${grade || ''}</div>
    </div>`;
  };

  const buildQueueItem = (setId, streamId, idx, queueLen, streamIsLive) => {
    const set = activeSetsData.find(s => String(s.id) === String(setId)) ||
      pendingSetsData.find(s => String(s.id) === String(setId)) ||
      allFetchedSets.find(s => String(s.id) === String(setId));
    if (!set) return ''; // not in current fetch — sorted to bottom, hidden until resolved
    const slotA = getProjectedSlotName(set.slots[0]);
    const slotB = getProjectedSlotName(set.slots[1]);
    const a = slotA.name, b = slotB.name;
    const filled = !!(set.slots[0]?.entrant?.name && set.slots[1]?.entrant?.name);
    const projected = !filled && (slotA.projected || slotB.projected);
    const round = set.fullRoundText || '';
    const stateLbl = set.state === 1 ? 'pending' : set.state === 2 ? 'in progress' : 'called';
    const fromLoc = set.station?.number ? `Station ${set.station.number}` : stateLbl;
    const isHead = idx === 0;
    const nameStyle = filled ? '' : projected
      ? 'color:var(--text);opacity:0.7;font-style:italic;'
      : 'color:var(--muted);font-style:italic;';
    const metaSuffix = filled ? '' : projected ? ' · projected' : ' · awaiting entrants';
    let sendBtn = '';
    if (isHead && !streamIsLive && filled) {
      sendBtn = `<button class="qi-btn send" onclick="event.stopPropagation();promoteFromQueue('${streamId}')" title="Call to stream now">▶ CALL</button>`;
    } else if (isHead && streamIsLive) {
      sendBtn = `<button class="qi-btn send" disabled title="Stream is busy — remove current match first">▶ CALL</button>`;
    } else if (isHead && !filled) {
      sendBtn = `<button class="qi-btn send" disabled title="Players not filled in yet">▶ CALL</button>`;
    }
    return `<div class="queue-item ${isHead ? 'head' : ''}">
      <div class="qi-pos">${idx + 1}</div>
      <div class="qi-info">
        <div class="qi-players" style="${nameStyle}">${a} <span style="color:var(--muted);font-weight:400;font-style:normal;">vs</span> ${b}</div>
        <div class="qi-meta">${round} · ${fromLoc}${metaSuffix}</div>
      </div>
      <div class="qi-controls">
        ${sendBtn}
        <button class="qi-btn" onclick="moveInStreamQueue('${setId}', '${streamId}', -1)" ${idx === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button class="qi-btn" onclick="moveInStreamQueue('${setId}', '${streamId}', 1)" ${idx === queueLen - 1 ? 'disabled' : ''} title="Move down">▼</button>
        <button class="qi-btn danger" onclick="removeFromStreamQueue('${setId}', '${streamId}')" title="Remove from queue">✕</button>
      </div>
    </div>`;
  };

  el.innerHTML = streamList.map(stream => {
    const sid = String(stream.id);
    const queue = streamQueues[sid] || [];
    const occupant = activeSetsData.find(s => String(s.stream?.id) === sid && (s.state === 2 || s.state === 6));
    const escName = String(stream.streamName).replace(/'/g, "\\'");

    // ─ LIVE NOW section ─
    let liveSection;
    if (occupant) {
      const a = occupant.slots[0]?.entrant?.name || '?';
      const b = occupant.slots[1]?.entrant?.name || '?';
      const eA = occupant.slots[0]?.entrant, eB = occupant.slots[1]?.entrant;
      const escA = a.replace(/'/g, "\\'"), escB = b.replace(/'/g, "\\'");
      const round = occupant.fullRoundText || '';
      const stateLbl = occupant.state === 2 ? 'IN PROGRESS' : 'CALLED';
      const locLbl = `🎥 ${stream.streamName}`;
      // The Report Score button only makes sense on in-progress matches —
      // calling a score on a state 6 (called, not yet started) match means
      // it skipped game results, which start.gg accepts but is unusual.
      // We allow it either way and let the TO judge.
      const scoreBtn = (eA?.id && eB?.id)
        ? `<button class="ss-mini-btn primary" onclick="openScoreOverlay('${occupant.id}','${eA.id}','${eB.id}','${escA}','${escB}','${locLbl}')">📝 Report Score</button>`
        : '';
      liveSection = `<div class="stream-slot live">
        <div class="ss-head">
          <div class="ss-name">🎥 ${stream.streamName}</div>
          <div class="ss-status">${stateLbl}</div>
        </div>
        <div class="ss-match">${a} <span style="color:var(--muted);font-weight:400;">vs</span> ${b}</div>
        <div class="ss-match-meta">${round}</div>
        <div class="ss-actions">
          ${scoreBtn}
          <button class="ss-mini-btn danger" onclick="pullFromStream('${occupant.id}')">⏏ Remove from stream</button>
        </div>
      </div>`;
    } else {
      liveSection = `<div class="stream-slot empty">
        <div class="ss-head">
          <div class="ss-name">🎥 ${stream.streamName}</div>
          <div class="ss-status">EMPTY</div>
        </div>
        <div class="ss-match-meta" style="margin-top:6px;">No match currently on stream${queue.length ? ' — click ▶ CALL on the head of the queue to promote.' : '.'}</div>
      </div>`;
    }

    // ─ QUEUE section ─
    const queueHtml = queue.length
      ? queue.map((id, i) => buildQueueItem(id, sid, i, queue.length, !!occupant)).join('')
      : `<div class="empty-queue-msg">Queue is empty — add matches below.</div>`;

    // ─ ADD-TO-QUEUE section (collapsible) ─
    const isExpanded = _expandedAddQueues.has(sid);
    const candHtml = candidatePool.length
      ? candidatePool.map(set => buildCandidateRow(set, sid, escName)).join('')
      : `<div class="empty-queue-msg">No matches available to queue right now.</div>`;
    const addSection = `<button class="add-queue-toggle" onclick="toggleAddQueuePanel('${sid}')">
      ${isExpanded ? '▲ Hide' : '+ Add match to queue'} ${candidatePool.length && !isExpanded ? `<span style="color:var(--blue);">(${candidatePool.length} available)</span>` : ''}
    </button>
    ${isExpanded ? `<div class="add-queue-list">${candHtml}</div>` : ''}`;

    return `<div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border);">
      ${liveSection}
      <div class="stream-section-label">
        <span>Up Next Queue</span>
        <span class="ssl-count">${queue.length} queued</span>
      </div>
      ${addSection}
      ${queueHtml}
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// Player Hub — stable fixed-size card grid
// ─────────────────────────────────────────────────────────────
function renderPlayerHub() {
  const activeEl = document.getElementById('hubActiveList');
  if (!activeEl) return;

  // Side panels are independent of the main card grid — render them
  // unconditionally so the TO sees current station + stream state.
  renderStationSidebar();
  renderStreamQueue();

  const actionSets = activeSetsData.filter(s => s.state === 2 || s.state === 6);
  const currentIds = actionSets.map(s => String(s.id));
  currentIds.forEach(id => { if (!_hubSlotIds.includes(id)) _hubSlotIds.push(id); });
  // Snapshot slots for THIS render (stale IDs show as dashed placeholders this cycle),
  // then prune _hubSlotIds to only active IDs so NEXT render is clean.
  // This prevents cards shifting the moment a score is submitted — the gap closes only
  // after the next full data refresh confirms the set is truly gone.
  const renderSlotIds = [..._hubSlotIds];
  _hubSlotIds = _hubSlotIds.filter(id => currentIds.includes(id));

  const CARD_H = '200px';

  const cards = renderSlotIds.map(slotId => {
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
    const queuedStream = queueAssignment ? streamList.find(s => String(s.id) === queueAssignment.streamId) : null;
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
      const ciA = hubCheckins.has(`${set.id}-${a?.id}`), ciB = hubCheckins.has(`${set.id}-${b?.id}`);
      const callTime = set.updatedAt || set.createdAt || Math.floor(Date.now() / 1000);
      const nowSec = Math.floor(Date.now() / 1000);
      const isExpired = (nowSec - callTime) / 60 >= DQ_MINUTES;
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
  matchLog.unshift({ p1: nameA, p2: nameB, station, source, setId, completed: false, grade: _gr, shiny, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  renderLog();
}

function resetMatch(setId) {
  announcedSetIds.delete(String(setId)); completedSetIds.delete(String(setId));
  const entry = matchLog.find(e => e.setId === setId);
  if (entry) entry.completed = false;
  renderLog();
  addPollLog(`↩ Reset set ${setId} — will re-ping on next poll`, 'new');
  toast('↩ Reset — will re-ping next poll');
}

function renderLog() {
  const el = document.getElementById('matchLog');
  if (!matchLog.length) { el.innerHTML = '<div class="empty-log">No matches called yet.</div>'; return; }
  el.innerHTML = matchLog.map(e => `
    <div class="match-entry ${e.source === 'auto' ? 'auto' : ''} ${e.completed ? 'done' : ''}">
      <div style="flex:1;min-width:0;">
        <div class="players">${e.p1} <span style="color:var(--muted)">vs</span> ${e.p2}${e.shiny ? ' <span class="shiny-badge">✨ SHINY</span>' : ''}</div>
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
let _overlaySetId = null, _overlayIdA = null, _overlayIdB = null;
let _overlayNameA = '', _overlayNameB = '';
let _overlayScoreA = null, _overlayScoreB = null;

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
  const setBeingReported = activeSetsData.find(s => String(s.id) === String(setId)) ||
    allFetchedSets.find(s => String(s.id) === String(setId));
  const reportedStreamId = setBeingReported?.stream?.id ? String(setBeingReported.stream.id) : null;

  const winnerId = sA > sB ? idA : idB;
  const winnerName = sA > sB ? nameA : nameB;
  let gameData = [], g = 1;
  for (let i = 0; i < sA; i++) gameData.push(`{winnerId: "${idA}", gameNum: ${g++}}`);
  for (let i = 0; i < sB; i++) gameData.push(`{winnerId: "${idB}", gameNum: ${g++}}`);
  try {
    await sggQuery(`mutation { reportBracketSet(setId: "${setId}", winnerId: "${winnerId}", gameData: [${gameData.join(',')}]) { id state } }`);
    toast(`🏆 Reported: ${winnerName} wins!`);
    completedSetIds.add(String(setId)); announcedSetIds.delete(String(setId));
    streamAnnouncedSetIds.delete(String(setId));
    hubCheckins.delete(`${setId}-${idA}`); hubCheckins.delete(`${setId}-${idB}`); saveCheckins();
    // Leave _hubSlotIds intact — card holds its position and shows a dashed placeholder until next poll
    const entry = matchLog.find(e => e.setId === setId);
    if (entry) { entry.completed = true; renderLog(); }

    // Auto-call the next queued match for this stream, if any.
    // We do this BEFORE fetchManualSets so the stream goes from
    // "live: just-reported set" to "live: next queued set" without a
    // visible empty state in between.
    // Gated by the "Autocall next from queue" toggle.
    const autoQueueCallOnAfterScore = document.getElementById('autoQueueCallToggle')?.checked !== false;
    if (reportedStreamId && autoQueueCallOnAfterScore) {
      const nextSetId = (streamQueues[reportedStreamId] || [])[0];
      if (nextSetId) {
        const stream = streamList.find(s => String(s.id) === reportedStreamId);
        const nextSet = activeSetsData.find(s => String(s.id) === String(nextSetId)) ||
          pendingSetsData.find(s => String(s.id) === String(nextSetId)) ||
          allFetchedSets.find(s => String(s.id) === String(nextSetId));
        const nextFilled = !!(nextSet?.slots?.[0]?.entrant?.name && nextSet?.slots?.[1]?.entrant?.name);
        if (stream && nextSet && nextFilled) {
          // Drop from queue first so re-renders don't show it twice
          streamQueues[reportedStreamId] = streamQueues[reportedStreamId].filter(x => String(x) !== String(nextSetId));
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

// --- WordPress compatibility shim ---
// Some WP optimization plugins (WP Rocket, Autoptimize, LiteSpeed, SiteGround Optimizer,
// etc.) wrap inline scripts in IIFEs or load them as modules, which scopes our top-level
// functions out of `window`. Inline `onclick=`/`onchange=` handlers can only see globals,
// so we explicitly publish every inline-handler-callable function here.
//
// ⚠️ This MUST run before any other top-level function call below — if any of
// those throw, the script halts and `Object.assign` never runs, leaving every
// inline handler undefined. Hoisted to run first; failures elsewhere don't
// strand the UI.
Object.assign(window, {
  addToStreamQueue, browseEvents, callQueuedSetToStream, callSetFromPanel,
  clearPhaseFilter, closeConfirmModal, closeScoreOverlay, copyPollLog,
  clearAllQueues, fetchAndPopulateStreams, fetchManualSets, hubToggleWatch,
  loadPhaseGroups, manualLink, markInProgressQuick, moveInStreamQueue,
  openScoreOverlay, promoteFromQueue, pullFromStream, removeFromStreamQueue,
  renderManualSets, requestDQ, requestHubDQ, requestMoveToStream, resetMatch,
  savePriorityStream, saveSettings, setScore, startPolling, stopPolling,
  submitOverlayScore, switchTab, toggleAddQueuePanel, toggleHubCheckin, toggleSetup
});

// (initDropZone moved to csv-handler.js)

try { loadSettings(); } catch (e) { console.error('loadSettings failed:', e); }
// Restore discord IDs from localStorage so page refresh doesn't wipe pings
try {
  const savedMap = JSON.parse(localStorage.getItem('abbey_discord_map') || '{}');
  for (const [tag, id] of Object.entries(savedMap)) {
    if (!tagMap.has(tag)) {
      const p = { tag, shortTag: tag, discordId: id };
      tagMap.set(tag, p);
    } else {
      tagMap.get(tag).discordId = id;
    }
  }
} catch (e) { }
try { renderLog(); } catch (e) { console.error('renderLog failed:', e); }