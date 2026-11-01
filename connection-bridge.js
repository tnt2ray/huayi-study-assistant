(function () {
  'use strict';

  const CHANNEL = 'huayi-connection-guard-v1';
  const documentStartedAt = Date.now();
  const reasons = new Set([
    '', 'login', 'verification', 'other-login', 'concurrent-play',
    'face', 'server-rejected', 'transport'
  ]);
  let flags = { security: false, plugin: false, reason: '' };
  let video = null;
  let position = -1;
  let lastProgressAt = 0;
  let leaving = false;
  let stopped = false;
  let lastState = '';
  let lastSentAt = 0;
  let hasStarted = false;
  let startupCancelled = false;

  function number(value, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
      ? value : null;
  }

  function hasBlockingDialog() {
    return Array.from(document.querySelectorAll(
      '#div_tip, #div_tip1, .layui-layer-dialog'
    )).some(function (element) {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  }

  function readState() {
    const currentVideo = document.querySelector('#video video.pv-video, #video video');
    if (currentVideo !== video) {
      video = currentVideo;
      position = video ? video.currentTime : -1;
      lastProgressAt = 0;
    }
    if (video && !video.paused && !video.ended && !video.seeking && video.currentTime > position) {
      lastProgressAt = Date.now();
      if (Number.isFinite(video.duration) && video.duration > 0) {
        hasStarted = true;
      }
    }
    position = video ? video.currentTime : -1;
    const stalled = Boolean(video && !video.paused && lastProgressAt &&
      Date.now() - lastProgressAt > 120000);
    let issue = flags.plugin ? 'plugin' :
      flags.reason || (flags.security ? 'security' : '');
    if (!issue && !navigator.onLine) {
      issue = 'offline';
    }
    if (!issue && video && video.error) {
      issue = 'media-error';
    }
    if (!issue && stalled) {
      issue = 'stalled';
    }
    const blocked = hasBlockingDialog();
    return {
      active: Boolean(!leaving && !issue && !blocked &&
        video && !video.paused && !video.ended && !video.error &&
        lastProgressAt && Date.now() - lastProgressAt <= 120000),
      waitingForFirstPlay: !hasStarted && !startupCancelled && !leaving,
      cancelHold: Boolean((!hasStarted && startupCancelled) ||
        (hasStarted && video && !video.ended && (video.paused || video.seeking))),
      naturalEnd: Boolean(video && video.ended && Number.isFinite(video.duration) &&
        video.duration > 0 && video.currentTime >= video.duration - 0.5),
      leaving: leaving,
      blocked: blocked,
      issue: issue,
      online: navigator.onLine,
      security: flags.security,
      plugin: flags.plugin,
      paused: video ? video.paused : true,
      ended: video ? video.ended : false,
      time: video ? number(video.currentTime, 604800) : null,
      duration: video ? number(video.duration, 604800) : null,
      mediaError: video && video.error ? video.error.code : null
    };
  }

  function send(force, control) {
    if (stopped) {
      return;
    }
    const state = readState();
    const key = JSON.stringify([
      state.active, state.issue, state.paused, state.ended, state.online,
      state.waitingForFirstPlay, state.cancelHold, state.blocked, state.leaving
    ]);
    const now = Date.now();
    if (!force && key === lastState && now - lastSentAt < 20000) {
      return;
    }
    lastState = key;
    lastSentAt = now;
    try {
      const pending = chrome.runtime.sendMessage({
        type: CHANNEL,
        documentStartedAt: documentStartedAt,
        state: state,
        control: control || null
      });
      pending.catch(function () {
        try { if (chrome.runtime && chrome.runtime.id) return; } catch (err) {}
        stopped = true;
        clearInterval(timer);
      });
    } catch (err) {
      stopped = true;
      clearInterval(timer);
    }
  }

  document.addEventListener(CHANNEL, function (event) {
    if (typeof event.detail !== 'string' || event.detail.length > 2000) {
      return;
    }
    let input;
    try {
      input = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    if (!input || typeof input !== 'object') {
      return;
    }
    if (input.kind === 'transition') {
      if (input.phase === 'cancel') {
        send(true, { phase: 'cancel' });
      } else if (input.phase === 'depart' &&
        typeof input.nextId === 'string' && /^[a-f0-9-]{36}$/i.test(input.nextId)) {
        send(true, {
          phase: 'depart', nextId: input.nextId.toLowerCase()
        });
      }
      return;
    }
    if (input.kind === 'flags') {
      const next = {
        security: input.security === true,
        plugin: input.plugin === true,
        reason: reasons.has(input.reason) ? input.reason : ''
      };
      if (JSON.stringify(next) !== JSON.stringify(flags)) {
        flags = next;
        send(true);
      }
      return;
    }
  });

  ['play', 'playing', 'pause', 'ended', 'emptied', 'error', 'timeupdate'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (event.target === document.querySelector('#video video.pv-video, #video video')) {
        send();
      }
    }, true);
  });
  window.addEventListener('pagehide', function () {
    leaving = true;
    send(true);
  });
  window.addEventListener('pageshow', function () {
    leaving = false;
    send(true);
  });
  ['online', 'offline'].forEach(function (type) {
    window.addEventListener(type, function () { send(true); });
  });
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (event.isTrusted && !hasStarted) {
        startupCancelled = true;
        send(true);
      }
    }, true);
  });
  const timer = setInterval(send, 5000);
  window.postMessage({ channel: CHANNEL, request: 'flags' }, window.location.origin);
  send(true);
})();
