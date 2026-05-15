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
// Expose to window
export { 
  sendWebhook,
  buildNormalCallPing,
  buildNormalQueuePing,
  buildNormalRerouteToQueuePing,
  buildNormalStreamCallPing,
  pick,
  isSFMeleeStream,
  buildCringeCallPing,
  buildCringeQueuePing,
  buildCringeRerouteToQueuePing,
  buildCringeStreamCallPing,
  rollShiny,
  rollCringe,
  buildCallPing,
  buildQueuePing,
  buildRerouteToQueuePing,
  buildStreamCallPing,
  buildStreamMovePing,
 };
