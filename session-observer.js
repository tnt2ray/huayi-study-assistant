(function () {
  'use strict';

  const CHANNEL = 'huayi-connection-guard-v1';
  const attached = new WeakSet();
  let lastFlags = '';
  let blockedReason = '';
  let transportEndpoint = '';

  function publish(record) {
    // Deliver safety state before the page can navigate.
    document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(record) }));
  }

  function endpoint(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.origin !== window.location.origin) {
        return '';
      }
      const path = url.pathname.toLowerCase();
      if (path === '/ashx/addcoursewareprocess.ashx') {
        return 'progress';
      }
      if (path === '/ashx/getcoursewareplaystate.ashx') {
        return 'play-state';
      }
    } catch (err) {
      // Ignore unrelated or malformed request URLs.
    }
    return '';
  }

  function responseCode(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 9999 ? number : null;
  }

  function classify(name, http, code, message) {
    if (/异地|其他设备|其它设备|重复登录|另.*登录/.test(message)) {
      return 'other-login';
    }
    if (http === 401 || code === 401 || /重新登录|登录.{0,8}(失效|过期)/.test(message)) {
      return 'login';
    }
    if ([403, 405].includes(http) || [403, 405].includes(code)) {
      return 'verification';
    }
    if (name === 'play-state' && code === 2) {
      return 'concurrent-play';
    }
    if (name === 'progress' && code === 4) {
      return 'face';
    }
    if (name === 'progress' && code === 1) {
      return 'server-rejected';
    }
    if (http === 0 || http >= 400) {
      return 'transport';
    }
    return '';
  }

  function publishFlags() {
    const record = {
      kind: 'flags',
      security: Boolean(window.securityAlertShown),
      plugin: Boolean(window.abnormalPluginBlocked),
      reason: blockedReason
    };
    const key = JSON.stringify(record);
    if (key !== lastFlags) {
      lastFlags = key;
      publish(record);
    }
  }

  function attachAjaxObserver() {
    const jq = window.jQuery || window.$;
    if (typeof jq !== 'function' || !jq.fn || !jq.fn.on || attached.has(jq)) {
      return;
    }
    // Global AJAX events leave the native transport, payload and callbacks untouched.
    jq(document).on('ajaxComplete.huayiConnectionGuard', function (event, xhr, settings) {
      try {
        const name = endpoint(settings.url);
        if (!name) {
          return;
        }
        const response = xhr.responseJSON || {};
        const code = responseCode(name === 'progress' ? response.code : response.errorCode);
        const http = Number(xhr.status) || 0;
        const message = String(response.message || response.msg || '').slice(0, 300);
        const reason = classify(name, http, code, message);
        if (reason && reason !== 'transport') {
          blockedReason = reason;
        } else if (reason === 'transport' && (!blockedReason || blockedReason === 'transport')) {
          blockedReason = reason;
          transportEndpoint = name;
        } else if (!reason && blockedReason === 'transport' && transportEndpoint === name &&
          http >= 200 && http < 300 && code === (name === 'progress' ? 0 : 1)) {
          blockedReason = '';
          transportEndpoint = '';
        }
        publishFlags();
      } catch (err) {
        // Observing safety state must not interrupt the original request lifecycle.
      }
    });
    attached.add(jq);
  }

  function tick() {
    attachAjaxObserver();
    publishFlags();
  }

  window.addEventListener('message', function (event) {
    if (
      event.source === window &&
      event.origin === window.location.origin &&
      event.data &&
      event.data.channel === CHANNEL &&
      event.data.request === 'flags'
    ) {
      lastFlags = '';
      publishFlags();
    }
  });
  document.addEventListener('DOMContentLoaded', tick, { once: true });
  document.addEventListener('load', attachAjaxObserver, true);
  document.addEventListener('visibilitychange', tick);
  ['online', 'offline', 'pageshow'].forEach(function (type) {
    window.addEventListener(type, tick);
  });
  tick();
  setInterval(tick, 1000);
})();
