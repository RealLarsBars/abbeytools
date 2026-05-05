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
// Expose to window
Object.assign(window, {
  sggQuery,
  browseEvents,
  selectEvent,
  loadPhaseGroups,
  resolvePlayer,
});
