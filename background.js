'use strict';

const CHANNEL = 'huayi-connection-guard-v1';
const LEASE_MS = 180000;
const STARTUP_MS = 45000;
const END_DECISION_MS = 5000;
const HANDOFF_MS = 120000;
const ALARM = 'huayi-guard-cleanup';
const EXPIRY_ALARM = 'huayi-guard-handoff-expiry';
const reasons = new Set([
  '', 'login', 'verification', 'other-login', 'concurrent-play', 'face',
  'server-rejected', 'transport', 'plugin', 'security', 'offline', 'stalled', 'media-error',
  'startup-timeout'
]);
let sessions = {};
let expiryTimer = null;

const ready = (async function () {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.session.get('guardSessions');
  sessions = saved.guardSessions || {};
})();
let queue = ready;

function enqueue(operation) {
  const next = queue.then(operation);
  queue = next.catch(function () {
    chrome.power.releaseKeepAwake();
  });
  return next;
}

function validSender(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id && sender.tab &&
      sender.frameId === 0 && typeof sender.documentId === 'string' &&
      (!sender.documentLifecycle || sender.documentLifecycle === 'active') &&
      /^https?:$/.test(url.protocol) && url.hostname.endsWith('.91huayi.com') &&
      /^\/course_ware\//.test(url.pathname);
  } catch (err) {
    return false;
  }
}

function number(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? value : null;
}

function cleanState(input) {
  const state = {
    active: input.active === true,
    issue: reasons.has(input.issue) ? input.issue : '',
    online: input.online === true,
    security: input.security === true,
    plugin: input.plugin === true,
    paused: input.paused !== false,
    ended: input.ended === true,
    waitingForFirstPlay: input.waitingForFirstPlay === true,
    cancelHold: input.cancelHold === true,
    leaving: input.leaving === true,
    blocked: input.blocked === true,
    naturalEnd: input.naturalEnd === true,
    time: number(input.time, 604800),
    duration: number(input.duration, 604800),
    mediaError: number(input.mediaError, 4)
  };
  state.active = state.active && !state.issue && state.online && !state.security &&
    !state.plugin && !state.paused && !state.ended && !state.mediaError &&
    !state.blocked && !state.leaving &&
    state.time !== null && state.duration > 0;
  state.naturalEnd = state.naturalEnd && state.ended && state.duration > 0 &&
    state.time !== null && state.time >= state.duration - 0.5;
  return state;
}

function safeToHold(state) {
  return state.online && !state.issue && !state.security && !state.plugin &&
    !state.mediaError && !state.blocked && !state.cancelHold;
}

function clearHold(entry) {
  entry.holdUntil = 0;
  entry.holdReason = '';
  entry.nextKey = '';
}

async function courseKey(rawUrl, nextId) {
  const url = new URL(rawUrl);
  const id = String(nextId || url.searchParams.get('cwid') || '').toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    return '';
  }
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(url.origin + '\n' + id));
  return Array.from(new Uint8Array(digest), function (byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

async function setProtection(tabId, entry, active) {
  if (active && !entry.protected) {
    const tab = await chrome.tabs.get(tabId);
    entry.originalAutoDiscardable = tab.autoDiscardable !== false;
    if (entry.originalAutoDiscardable) {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    }
    entry.protected = true;
  } else if (!active && entry.protected) {
    if (entry.originalAutoDiscardable) {
      try {
        await chrome.tabs.update(tabId, { autoDiscardable: true });
      } catch (err) {
        // The tab may already have been closed.
      }
    }
    entry.protected = false;
  }
}

function updatePower() {
  const now = Date.now();
  const wanted = Object.values(sessions).some(function (entry) {
    return entry.phase && entry.protected && now - entry.updatedAt < LEASE_MS &&
      (entry.phase === 'playing' || entry.holdUntil > now);
  });
  if (wanted) {
    // This prevents idle sleep only; it cannot override lid-close or explicit sleep.
    chrome.power.requestKeepAwake('system');
  } else {
    chrome.power.releaseKeepAwake();
  }
}

async function updateBadge(tabId, entry) {
  const issue = entry && entry.state.issue;
  const active = entry && entry.phase && entry.protected;
  const waiting = active && entry.phase !== 'playing';
  try {
    await chrome.action.setBadgeText({
      tabId: tabId, text: issue ? '!' : waiting ? 'WAIT' : active ? 'ON' : ''
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId: tabId, color: issue ? '#b43c2e' : '#236d53'
    });
    await chrome.action.setBadgeTextColor({ tabId: tabId, color: '#ffffff' });
    await chrome.action.setTitle({
      tabId: tabId,
      title: issue ? '连接异常，请查看原站提示' :
        waiting ? '等待播放' :
          active ? '播放保护中' : '华医网课件免打扰学习助手'
    });
  } catch (err) {
    // Badge updates are optional when a tab is closing.
  }
}

async function saveSessions() {
  await chrome.storage.session.set({ guardSessions: sessions });
  if (Object.keys(sessions).length) {
    if (!await chrome.alarms.get(ALARM)) {
      await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    }
  } else {
    await chrome.alarms.clear(ALARM);
  }
  clearTimeout(expiryTimer);
  const deadlines = Object.values(sessions).map(function (entry) { return entry.holdUntil; })
    .filter(function (deadline) { return deadline > Date.now(); });
  if (deadlines.length) {
    const deadline = Math.min.apply(null, deadlines);
    expiryTimer = setTimeout(function () {
      enqueue(reconcile).catch(function () {});
    }, Math.max(1, deadline - Date.now()));
    const alarm = await chrome.alarms.get(EXPIRY_ALARM);
    if (!alarm || Math.abs(alarm.scheduledTime - deadline) > 1) {
      await chrome.alarms.create(EXPIRY_ALARM, { when: deadline });
    }
  } else {
    await chrome.alarms.clear(EXPIRY_ALARM);
  }
}

async function refreshProtection(tabId, entry) {
  const now = Date.now();
  const state = entry.state;
  if (!safeToHold(state) || (state.leaving && !entry.nextKey)) {
    clearHold(entry);
  }
  const pending = entry.holdUntil > now &&
    (state.waitingForFirstPlay || state.naturalEnd || (state.leaving && entry.nextKey));
  const phase = state.active ? 'playing' : pending ? entry.holdReason : '';
  if (!phase && !entry.started && state.waitingForFirstPlay && safeToHold(state) &&
      now >= entry.startupDeadline) {
    state.issue = 'startup-timeout';
  }
  entry.phase = phase;
  try {
    await setProtection(tabId, entry, Boolean(phase));
  } catch (err) {
    entry.protected = false;
  }
  await updateBadge(tabId, entry);
}

async function removeSession(tabId) {
  const entry = sessions[tabId];
  if (!entry) {
    return;
  }
  await setProtection(Number(tabId), entry, false);
  delete sessions[tabId];
  updatePower();
  await updateBadge(Number(tabId), null);
  await saveSessions();
}

async function receive(message, sender) {
  const tabId = sender.tab.id;
  const now = Date.now();
  const documentStartedAt = number(message.documentStartedAt, Number.MAX_SAFE_INTEGER) || now;
  let entry = sessions[tabId];
  if (entry && entry.documentId !== sender.documentId) {
    if (documentStartedAt < entry.documentStartedAt) {
      return { received: false };
    }
  }
  if (!entry || entry.documentId !== sender.documentId) {
    const previous = entry;
    const inherited = previous && previous.holdUntil > now && previous.nextKey &&
      previous.nextKey === await courseKey(sender.url);
    const deadline = inherited ? previous.holdUntil : now + STARTUP_MS;
    // Preserve the existing browser assertion while the new document takes over.
    entry = {
      documentId: sender.documentId,
      documentStartedAt: documentStartedAt,
      protected: previous ? previous.protected : false,
      originalAutoDiscardable: previous ? previous.originalAutoDiscardable : true,
      started: false,
      naturalEndAt: 0,
      startupDeadline: deadline,
      holdUntil: deadline,
      holdReason: inherited ? 'switching' : 'starting',
      nextKey: ''
    };
    sessions[tabId] = entry;
  }
  entry.state = cleanState(message.state);
  entry.updatedAt = now;
  if (entry.state.active) {
    entry.started = true;
    entry.naturalEndAt = 0;
    clearHold(entry);
  } else if (entry.state.naturalEnd && entry.started && !entry.naturalEndAt) {
    entry.naturalEndAt = now;
    entry.holdUntil = now + END_DECISION_MS;
    entry.holdReason = 'ending';
  }
  const control = message.control;
  if (control && control.phase === 'cancel') {
    clearHold(entry);
  } else if (control && control.phase === 'depart' && entry.state.naturalEnd &&
      entry.started && entry.naturalEndAt && safeToHold(entry.state)) {
    const key = typeof control.nextId === 'string' && await courseKey(sender.url, control.nextId);
    if (key) {
      entry.nextKey = key;
      entry.holdUntil = entry.naturalEndAt + HANDOFF_MS;
      entry.holdReason = 'switching';
    }
  }
  await refreshProtection(tabId, entry);
  updatePower();
  await saveSessions();
  return { received: true };
}

chrome.runtime.onMessage.addListener(function (message, sender, respond) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type !== CHANNEL || !message.state || !validSender(sender)) {
    return;
  }
  enqueue(function () { return receive(message, sender); })
    .then(respond, function () { respond({ error: 'guard-unavailable' }); });
  return true;
});

async function reconcile() {
  for (const [tabId, entry] of Object.entries(sessions)) {
    let exists = true;
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      exists = !tab.discarded;
    } catch (err) {
      exists = false;
    }
    if (!exists || Date.now() - entry.updatedAt >= LEASE_MS) {
      await removeSession(tabId);
    } else {
      await refreshProtection(Number(tabId), entry);
    }
  }
  updatePower();
  await saveSessions();
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM || alarm.name === EXPIRY_ALARM) {
    enqueue(reconcile).catch(function () {});
  }
});
chrome.tabs.onRemoved.addListener(function (tabId) {
  enqueue(function () { return removeSession(tabId); }).catch(function () {});
});
chrome.tabs.onUpdated.addListener(function (tabId, change) {
  if (change.status === 'loading' || change.discarded === true) {
    enqueue(function () {
      const entry = sessions[tabId];
      if (change.discarded !== true && entry && entry.holdUntil > Date.now() &&
          (entry.nextKey || entry.state.naturalEnd || entry.state.waitingForFirstPlay)) {
        return saveSessions();
      }
      return removeSession(tabId);
    }).catch(function () {});
  }
});
chrome.runtime.onStartup.addListener(function () {
  enqueue(reconcile).catch(function () {});
});
enqueue(reconcile).catch(function () {});

// The exam workflow has its own short message queue; model calls never block playback protection.
importScripts('magpie-config.js', 'magpie-client.js', 'exam-background.js');
