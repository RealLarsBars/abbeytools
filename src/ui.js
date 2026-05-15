import { fetchManualSets } from './manual.js';
import { startPolling, stopPolling } from './poll.js';
import { loadPhaseGroups } from './api.js';
import { toast } from './hub.js';
import { state } from './state.js';

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
  if (!state.activeTimers.length) return;
  const nowSec = Math.floor(Date.now() / 1000);
  state.activeTimers.forEach(({ el, callTime }) => {
    const remaining = Math.max(0, (state.DQ_MINUTES * 60) - (nowSec - callTime));
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
  if (state.pollTimer) { stopPolling(); }
  else {
    const activeTab = document.querySelector('.tab-panel.active')?.id?.replace('tab-', '') || 'hub';
    switchTab('auto'); startPolling(); switchTab(activeTab);
  }
}

function updateHubWatchBtn() {
  for (const id of ['hubWatchBtn', 'streamWatchBtn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    if (state.pollTimer) {
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
    state.DQ_MINUTES = dqVal;
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
    state.DQ_MINUTES = parseFloat(savedDq) || 5.5;
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
// Expose to window
export { 
  toggleSetup,
  renderHubChips,
  hubToggleWatch,
  updateHubWatchBtn,
  clearPhaseFilter,
  saveSettings,
  loadSettings,
  showStatus,
  updateFilterBar,
  switchTab,
 };
