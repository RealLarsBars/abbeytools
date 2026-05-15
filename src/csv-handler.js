import { discordOverrides } from './state.js';
import { renderDiscordAccountsList, toast } from './hub.js';
import { state } from './state.js';

// ─────────────────────────────────────────────────────────────
// CSV & Drag-and-Drop Handler for Abbey Match Caller
// ─────────────────────────────────────────────────────────────

function renderCsvStatus() {
  const el = document.getElementById('csvStatus');
  if (!el) return;
  if (!state.players.length) {
    el.innerHTML = '<span class="badge badge-err"><span class="dot"></span>No attendee list loaded</span>';
    return;
  }
  el.innerHTML = `<span class="badge badge-ok"><span class="dot"></span>${state.players.length} entrants loaded</span>`;
}

function loadCSV(file) {
  if (!file) return;
  toast(`📂 Processing ${file.name}...`);
  const slugMatch = file.name.match(/^attendeeList_(.+?)_\d{4}-\d{2}-\d{2}_/);
  if (slugMatch) {
    const slugInput = document.getElementById('tournamentSlug');
    if (slugInput) {
      slugInput.value = slugMatch[1];
      localStorage.setItem('abbey_tournament_slug', slugMatch[1]);
    }
  }
  
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(results) {
      state.players = results.data.map(row => ({
        tag: row['GamerTag']?.trim() || '',
        shortTag: row['Short GamerTag']?.trim() || row['GamerTag']?.trim() || '',
        discordId: row['Discord ID']?.trim() || '',
      })).filter(p => p.tag);
      state.tagMap.clear();

      // Apply Discord ID overrides
      for (const p of state.players) {
        if (!p.discordId && discordOverrides[p.tag.toLowerCase()])
          p.discordId = discordOverrides[p.tag.toLowerCase()];
      }

      // ─── Priority-aware state.tagMap population ───────────────────
      // Pass 1: full tags
      for (const p of state.players) {
        state.tagMap.set(p.tag.toLowerCase(), p);
      }

      // Pass 2: normalized full tags
      for (const p of state.players) {
        const normalized = p.tag.replace(/\s*\|\s*/g, ' | ').trim().toLowerCase();
        if (!state.tagMap.has(normalized)) state.tagMap.set(normalized, p);
      }

      // Detect ambiguous short/stripped names
      const shortCounts = new Map();
      const strippedCounts = new Map();
      for (const p of state.players) {
        if (p.shortTag) {
          const st = p.shortTag.toLowerCase();
          if (st !== p.tag.toLowerCase()) shortCounts.set(st, (shortCounts.get(st) || 0) + 1);
        }
        const stripped = p.tag.replace(/^[^|]+\|\s*/, '').trim().toLowerCase();
        if (stripped && stripped !== p.tag.toLowerCase()) {
          strippedCounts.set(stripped, (strippedCounts.get(stripped) || 0) + 1);
        }
      }

      // Pass 3: short tags
      for (const p of state.players) {
        if (p.shortTag) {
          const st = p.shortTag.toLowerCase();
          if (!state.tagMap.has(st) && (shortCounts.get(st) || 0) <= 1) {
            state.tagMap.set(st, p);
          }
        }
      }

      // Pass 4: stripped tags
      for (const p of state.players) {
        const stripped = p.tag.replace(/^[^|]+\|\s*/, '').trim().toLowerCase();
        if (stripped && !state.tagMap.has(stripped) && (strippedCounts.get(stripped) || 0) <= 1) {
          state.tagMap.set(stripped, p);
        }
      }

      // Save full discord map to localStorage
      const discordMap = {};
      for (const p of state.players) { if (p.discordId) discordMap[p.tag.toLowerCase()] = p.discordId; }
      localStorage.setItem('abbey_discord_map', JSON.stringify(discordMap));
      renderCsvStatus();
      if (typeof renderDiscordAccountsList === 'function') renderDiscordAccountsList();
      toast('✓ Attendee list loaded');
    }
  });
}

function initDropZone() {
  const zone = document.getElementById('dropZone');
  if (!zone) return;

  ['dragenter', 'dragover'].forEach(name => {
    zone.addEventListener(name, e => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('drag');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    zone.addEventListener(name, e => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('drag');
    });
  });

  zone.addEventListener('drop', e => {
    const file = e.dataTransfer.files?.[0];
    if (file) loadCSV(file);
  });
}

// Publish to window for WordPress/Global access
export {  loadCSV, renderCsvStatus, initDropZone  };

// Auto-initialize when script loads (assuming DOM is ready or script is at end)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDropZone);
} else {
  initDropZone();
}
