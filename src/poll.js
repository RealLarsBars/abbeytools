import { addToStreamQueue, getPlaceholderStationIds, findQueueAssignment, sendQueuePingForSet, getPlaceholderStationForStream, renderStreamQueue, isInAnyQueue, callQueuedSetToStream } from './queue.js';
import { sggQuery } from './api.js';
import { buildRerouteToQueuePing, buildCallPing, buildQueuePing, sendWebhook } from './discord.js';
import { state, getDiscordMention, saveStreamQueues, getLowestIncompletePhase, getEventField } from './state.js';
import { getSetStreamTier, enforceAutoDQ, renderStreamSetupSelectors } from './streams.js';
import { renderManualSets } from './manual.js';
import { addPollLog, buildPollSnapshot, updateVenueDashboardUI } from './actions.js';
import { updateHubWatchBtn } from './ui.js';
import { toast, renderPlayerHub, logMatch } from './hub.js';

// Poll
// ─────────────────────────────────────────────────────────────
async function doPoll() {
  addPollLog('Checking start.gg…');
  const eventField = getEventField();
  if (!eventField) return;

  try {
    const [setData, venueData] = await Promise.all([
      sggQuery(`query PollSets { ${eventField} { sets(page: 1, perPage: 100, filters: { state: [1,2,6] }) { nodes { id state fullRoundText createdAt updatedAt phaseGroup { id phase { id phaseOrder } } station { id number } stream { id streamName } slots { prereqType prereqId prereqPlacement seed { seedNum } entrant { id name } } } } } }`),
      sggQuery(`query PollVenue { ${eventField} { tournament { id streams { id streamName } stations(page: 1, perPage: 30) { nodes { id number } } } } }`).catch(() => null)
    ]);

    const allSets = setData?.data?.event?.sets?.nodes || [];
    if (venueData?.data?.event?.tournament) {
      const tourney = venueData.data.event.tournament;
      state.stationList = (tourney.stations?.nodes || []).sort((a, b) => a.number - b.number);
      state.streamList = tourney.streams || [];
      
      // NOTE: We deliberately do NOT sync from start.gg's streamQueue field.
      // The local state.streamQueues object is the authoritative source of truth for
      // queue ordering. start.gg's streamQueue is a flat list of every set
      // with a stream assigned (including live sets) and overwriting locally
      // from it created duplicate-entry and routing bugs. External assignments
      // are still detected below via set.stream + set.state and routed into
      // the local queue through addToStreamQueue.
    }

    const { freeLocs } = updateVenueDashboardUI(allSets);
    let availableStations = freeLocs.filter(l => l.type === 'station').sort((a, b) => a.sortIdx - b.sortIdx);

    state.allFetchedSets = allSets;
    state.activeSetsData = allSets.filter(s => s.state === 2 || s.state === 6);
    state.state.state.pendingSetsData = allSets.filter(s => s.state === 1 && s.slots?.[0]?.entrant?.id && s.slots?.[1]?.entrant?.id);

    // Prune hub slots once per poll cycle — after fresh data confirms which sets
    // are truly gone. Doing this here (not in renderPlayerHub) means any number
    // of renders between polls all show dashed placeholders rather than shifting.
    { const pollActiveIds = new Set(state.activeSetsData.map(s => String(s.id)));
      state._hubSlotIds = state._hubSlotIds.filter(id => pollActiveIds.has(id)); }

    const autoOn = document.getElementById('autoAssignToggle')?.checked;
    const bypassPhase = document.getElementById('bypassPhaseToggle')?.checked;
    const lowestPhase = getLowestIncompletePhase();
    const lockedPending = state.state.state.pendingSetsData.filter(s => (s.phaseGroup?.phase?.phaseOrder ?? 999) === lowestPhase);
    const usableStationCount = state.stationList.length - getPlaceholderStationIds().size;
    addPollLog(`📊 auto:${autoOn ? "ON" : "OFF"} | bypassPhase:${bypassPhase ? "ON" : "OFF"} | total:${allSets.length} | pending:${state.state.state.pendingSetsData.length}(eligible:${lockedPending.length}) | free:${freeLocs.length}(stn:${usableStationCount} str:${state.streamList.length}) | active:${state.activeSetsData.length}`);

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
      if (state.completedSetIds.has(String(set.id))) continue;

      // If this set was added to a stream queue locally, skip the entire
      // station ping flow. The queue ping has already been sent. When the TO
      // promotes the queued set to stream, they'll get the Stream Call ping.
      // We do NOT want the player getting both "you're queued for stream"
      // AND "go to station 1" — that's contradictory and confusing.
      if (isInAnyQueue(set.id)) {
        state.announcedSetIds.add(String(set.id)); // mark as handled so it doesn't trigger later
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
          state.recentlyAssignedLocs.set(String(locToAssign.id), Date.now());
        } catch (e) {
          addPollLog(`⚠️ Failed to auto-fix missing station for ${set.id}: ${e.message}`, 'err');
        }
      }

      if (!state.announcedSetIds.has(String(set.id))) {
        state.announcedSetIds.add(String(set.id));
        const nA = set.slots[0]?.entrant?.name || '???', nB = set.slots[1]?.entrant?.name || '???';
        const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
        const loc = set.station?.number ? `Station ${set.station.number}` : set.stream?.streamName ? `🎥 ${set.stream.streamName}` : '';
        const dTs = Math.floor((Date.now() + state.DQ_MINUTES * 60 * 1000) / 1000);
        const ping = buildCallPing({ mA, mB, loc: loc || 'NO STATION', roundText: set.fullRoundText, dqTimestamp: dTs });
        await sendWebhook(ping.content);
        logMatch(nA, nB, loc || 'No Station', 'auto', set.id, set.slots[0]?.seed?.seedNum, set.slots[1]?.seed?.seedNum, ping.shiny);
        addPollLog(`${ping.shiny ? '✨ SHINY' : '✓'} Ext. Call Detected: ${nA} vs ${nB}${loc ? ' → ' + loc : ' (no station)'}`, 'new');
        if (ping.shiny) toast('✨ SHINY PING! 1/8192 — go check Discord');
        pingCount++;
      }

      const callTime = set.updatedAt || set.createdAt || nowSec;
      if ((nowSec - callTime) / 60 >= state.DQ_MINUTES && autoDqOn) {
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
      const stream = state.streamList.find(s => String(s.id) === streamId) || { id: streamId, streamName: set.stream.streamName };

      // Always idempotently keep locks in sync with the source of truth.
      if (set.state === 2 || set.state === 6) {
        state.recentlyAssignedLocs.set(streamId, Date.now());
        if (set.station?.id) state.recentlyAssignedLocs.delete(String(set.station.id));
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
        const isQueuedHere = (state.streamQueues[streamId] || []).some(x => String(x) === sid);
        const alreadyAnnounced = state.state.state.streamAnnouncedSetIds.has(sid);
        if (isQueuedHere || alreadyAnnounced) continue;

        const wasPingedToStation = state.announcedSetIds.has(sid);
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
        if (nA !== '???' && nB !== '???' && !state.state.state.queuePingedSetIds.has(sid)) {
          state.state.state.queuePingedSetIds.add(sid);
          const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
          const ping = fromLoc
            ? buildRerouteToQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText, fromLoc })
            : buildQueuePing({ mA, mB, streamLabel: stream.streamName, roundText: set.fullRoundText });
          try { await sendWebhook(ping.content); } catch (e) { /* ignore */ }
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
        //      state.state.state.streamAnnouncedSetIds, all housekeeping (placeholder station,
        //      stream re-assign) was done at promotion time. Skip.
        //   2. TO assigned stream mid-game → unusual. Track silently as
        //      occupied (so auto-promote doesn't double up) and do the
        //      placeholder swap to free the real station, but NEVER reset
        //      state — state.players are mid-set and that would be destructive.
        if (state.state.state.streamAnnouncedSetIds.has(sid)) continue;

        state.state.state.streamAnnouncedSetIds.add(sid);
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
      for (const stream of state.streamList) {
        const sid = String(stream.id);
        if (!occupiedStreamIds.has(sid)) {
          const queue = state.streamQueues[sid] || [];
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
              state.streamQueues[sid].shift();
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
    for (const sid of [...state.state.streamAnnouncedSetIds]) {
      if (!currentlyStreamed.has(sid)) state.state.state.streamAnnouncedSetIds.delete(sid);
    }
    // state.state.state.queuePingedSetIds GC: drop entries no longer in any queue or live on stream.
    const allQueuedAndLive = new Set([...currentlyStreamed]);
    for (const q of Object.values(state.streamQueues)) {
      for (const id of q) allQueuedAndLive.add(String(id));
    }
    for (const sid of [...state.state.queuePingedSetIds]) {
      if (!allQueuedAndLive.has(sid)) state.state.state.queuePingedSetIds.delete(sid);
    }

    // 2. AUTO-ASSIGN — STATIONS ONLY. Streams are filled manually via the
    // Stream Queue. Auto-assign never picks streams now.
    if (autoOn && state.state.state.pendingSetsData.length > 0 && availableStations.length > 0) {
      const lowestIncompletePhase = getLowestIncompletePhase();

      let pending = [...state.state.pendingSetsData];

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

      const samplePgId = pending[0] ? String(pending[0].phaseGroup?.id ?? 'undefined') : (state.state.state.pendingSetsData[0] ? String(state.state.state.pendingSetsData[0].phaseGroup?.id ?? 'undefined') : 'no sets');
      addPollLog(`🔍 after-filters:${pending.length} | pgFilter:[${pgAllowed.join(',')}] | sample pgId:${samplePgId} | stns:${availableStations.length} (streams: manual queue)`);

      // Stream-priority sets (main-only, stream-preferred) are NEVER auto-assigned
      // to a station — they wait in the stream queue for a human to pick them.
      // Queued sets are also skipped — they're waiting in a stream queue and
      // shouldn't be called to a station behind the scenes.
      const stationEligible = pending
        .filter(s => getSetStreamTier(s) === 'normal')
        .filter(s => !isInAnyQueue(s.id))
        .filter(s => !s.stream?.id)
        .filter(s => !state.state.state.streamAnnouncedSetIds.has(String(s.id)))
        .filter(s => !state.announcedSetIds.has(String(s.id)));

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
          state.recentlyAssignedLocs.set(String(loc.id), Date.now());
          state.announcedSetIds.add(String(ps.id));
          state.announcedSetIds.add(String(targetId));

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
          if (!state.activeSetsData.some(s => String(s.id) === String(targetId))) state.activeSetsData.push(ps);

          // state.announcedSetIds already set above before assignment

          const nA = ps.slots[0]?.entrant?.name || '???', nB = ps.slots[1]?.entrant?.name || '???';
          const mA = getDiscordMention(nA), mB = getDiscordMention(nB);
          const dTs = Math.floor((Date.now() + state.DQ_MINUTES * 60 * 1000) / 1000);
          const ping = buildCallPing({ mA, mB, loc: loc.label, roundText: ps.fullRoundText, dqTimestamp: dTs });
          await sendWebhook(ping.content);
          logMatch(nA, nB, loc.label, 'auto', targetId, ps.slots[0]?.seed?.seedNum, ps.slots[1]?.seed?.seedNum, ping.shiny);
          addPollLog(`${ping.shiny ? '✨ SHINY' : '⚡'} Auto-assigned & Pinged: ${nA} vs ${nB} to ${loc.label}`, 'new');
          if (ping.shiny) toast('✨ SHINY PING! 1/8192 — go check Discord');
        } catch (err) { addPollLog(`⚠️ Skipped set ${ps.id}: ${err.message}`, 'err'); state.completedSetIds.delete(String(ps.id)); }
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
  if (state.pollTimer) clearInterval(state.pollTimer);
  document.getElementById('startPollBtn').disabled = true;
  document.getElementById('stopPollBtn').disabled = false;
  document.getElementById('autoStatus').textContent = 'Watching';
  document.getElementById('autoBadge').style.display = 'inline-flex';
  document.getElementById('autoMeta').textContent = 'Watching for sets called on any device…';
  document.getElementById('manualAutoBar').style.display = 'flex';

  // Pre-populate state.state.state.streamAnnouncedSetIds with currently-streaming sets so that
  // resuming polling after a pause doesn't spam pings for matches that have
  // been on stream for a while. New stream assignments after this point still
  // ping normally.
  for (const s of state.allFetchedSets) {
    if (s.stream?.id && (s.state === 2 || s.state === 6)) {
      state.state.state.streamAnnouncedSetIds.add(String(s.id));
    }
  }

  // Apply the same filters as auto-assign before forcing a start.gg call
  let validPending = state.state.state.pendingSetsData || [];

  // Skip queued sets — they're waiting for stream promotion, not a station call
  validPending = validPending.filter(s => !isInAnyQueue(s.id));

  const pgFilterRaw = localStorage.getItem('abbey_pg_filter') || '';
  const pgAllowed = pgFilterRaw ? pgFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (pgAllowed.length > 0) {
    validPending = validPending.filter(s => pgAllowed.some(allowed => String(s.phaseGroup?.id || '').includes(allowed)));
  }

  const bypassPhase = document.getElementById('bypassPhaseToggle')?.checked;
  if (!bypassPhase && state.allFetchedSets.length > 0) {
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
  state.pollTimer = setInterval(doPoll, interval);
  addPollLog(`Auto watch started (every ${interval / 1000}s)`, 'new');
  updateHubWatchBtn();
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
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
// Expose to window
export { 
  doPoll,
  startPolling,
  stopPolling,
 };
