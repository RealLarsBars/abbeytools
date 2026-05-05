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
 * Sorts a stream's queue: filled sets first, then projected (at least one
 * slot resolvable via prereq), then pure TBD, then stale stubs at bottom.
 * Returns true if the order actually changed.
 */
function sortStreamQueue(streamId) {
  const sid = String(streamId);
  const queue = streamQueues[sid] || [];
  if (!queue.length) return false;

  const filled = [], projected = [], tbd = [], missing = [];
  for (const setId of queue) {
    const set = allFetchedSets.find(s => String(s.id) === String(setId)) ||
      activeSetsData.find(s => String(s.id) === String(setId)) ||
      pendingSetsData.find(s => String(s.id) === String(setId));
    if (!set) { missing.push(setId); continue; }
    if (set.slots?.[0]?.entrant?.name && set.slots?.[1]?.entrant?.name) { filled.push(setId); continue; }
    const slotA = getProjectedSlotName(set.slots?.[0]);
    const slotB = getProjectedSlotName(set.slots?.[1]);
    if (slotA.projected || slotB.projected) projected.push(setId);
    else tbd.push(setId);
  }
  const sorted = [...filled, ...projected, ...tbd, ...missing];
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

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60), remM = m % 60;
  return `${h}h ${remM}m`;
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
    .filter(s => {
      // Hide sets where neither slot has an entrant or a resolvable projection
      if (s.slots?.[0]?.entrant?.name || s.slots?.[1]?.entrant?.name) return true;
      const sA = getProjectedSlotName(s.slots?.[0]), sB = getProjectedSlotName(s.slots?.[1]);
      return sA.projected || sB.projected;
    })
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
    const readinessClass = filled ? 'ready' : projected ? 'proj' : 'tbd';
    return `<div class="cand-row ${readinessClass}" onclick="addToStreamQueue('${set.id}', '${streamId}')" title="Add to ${streamName} queue">
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
    const readinessClass = filled ? 'ready' : projected ? 'proj' : 'tbd';
    return `<div class="queue-item ${isHead ? 'head ' : ''}${readinessClass}">
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
    // Track how long this stream has been without an active match
    if (occupant) {
      delete streamEmptySince[sid];
    } else if (!streamEmptySince[sid]) {
      streamEmptySince[sid] = Date.now();
    }

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
      const emptySince = streamEmptySince[sid];
      const emptyDuration = emptySince ? formatElapsed(Date.now() - emptySince) : null;
      liveSection = `<div class="stream-slot empty">
        <div class="ss-head">
          <div class="ss-name">🎥 ${stream.streamName}</div>
          <div class="ss-status">EMPTY${emptyDuration ? ` · ${emptyDuration}` : ''}</div>
        </div>
        <div class="ss-match-meta" style="margin-top:6px;">No match currently on stream${queue.length ? ' — click ▶ CALL on the head of the queue to promote.' : '.'}</div>
      </div>`;
    }

    // ─ QUEUE section ─
    // Hide pure TBD-vs-TBD entries from the visible queue; they're still tracked
    // in the queue data and surface automatically once entrants are determined.
    const visibleQueue = queue.filter(id => {
      const s = allFetchedSets.find(x => String(x.id) === id) ||
        activeSetsData.find(x => String(x.id) === id) ||
        pendingSetsData.find(x => String(x.id) === id);
      if (!s) return true; // keep stubs ("Match loading…")
      if (s.slots?.[0]?.entrant?.name || s.slots?.[1]?.entrant?.name) return true;
      const sA = getProjectedSlotName(s.slots?.[0]), sB = getProjectedSlotName(s.slots?.[1]);
      return sA.projected || sB.projected;
    });
    const hiddenTbd = queue.length - visibleQueue.length;
    const tbdNote = hiddenTbd
      ? `<div style="font-size:0.72rem;color:var(--muted);padding:5px 4px 0;">+${hiddenTbd} TBD match${hiddenTbd !== 1 ? 'es' : ''} hidden (no entrants or projection yet)</div>`
      : '';
    const queueHtml = visibleQueue.length
      ? visibleQueue.map((id, i) => buildQueueItem(id, sid, i, visibleQueue.length, !!occupant)).join('') + tbdNote
      : (hiddenTbd
        ? `<div class="empty-queue-msg">Queue is empty — add matches below.</div>${tbdNote}`
        : `<div class="empty-queue-msg">Queue is empty — add matches below.</div>`);

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
// Expose to window
Object.assign(window, {
  findQueueAssignment,
  isInAnyQueue,
  getPlaceholderStationForStream,
  getPlaceholderStationIds,
  addToStreamQueue,
  sendQueuePingForSet,
  removeFromStreamQueue,
  clearAllQueues,
  moveInStreamQueue,
  sortStreamQueue,
  cleanStreamQueues,
  promoteFromQueue,
  callQueuedSetToStream,
  toggleAddQueuePanel,
  getProjectedSlotName,
  formatElapsed,
  renderStreamQueue,
});
