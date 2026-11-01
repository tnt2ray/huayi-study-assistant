'use strict';

(function () {
  const config = globalThis.HuayiMagpieConfig;
  const catalogs = new Map();
  async function models(baseUrl, signal, refresh) {
    baseUrl = config.normalizeBaseUrl(baseUrl);
    if (signal && signal.aborted) throw new Error('timeout');
    if (!await chrome.permissions.contains({ origins: [config.permissionOrigin(baseUrl)] })) {
      throw new Error('magpie-permission');
    }
    const cached = catalogs.get(baseUrl);
    if (!refresh && cached && Date.now() - cached.at < 300000) return cached.models;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 10000);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    try {
      const response = await fetch(baseUrl + '/v1/models', {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'magpie-auth' : 'magpie-http');
      if (!response.body) throw new Error('magpie-models');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let text = '', size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error('magpie-models');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(function () {}); }
      let body;
      try { body = JSON.parse(text); } catch (err) { throw new Error('magpie-models'); }
      if (!body || !Array.isArray(body.data) || body.data.length > 1000) throw new Error('magpie-models');
      const seen = new Set(), list = [];
      for (const item of body.data) {
        if (!item || !config.validModel(item.id) || seen.has(item.id)) continue;
        seen.add(item.id);
        const label = item.display_name || item.magpie_label || item.id;
        list.push({ id: item.id, label: typeof label === 'string' ? label.slice(0, 200) : item.id,
          lowReasoning: (Array.isArray(item.reasoning_levels) && item.reasoning_levels.includes('low')) ||
            (Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.some(level => level && level.effort === 'low')) });
      }
      if (!list.length) throw new Error('magpie-models');
      catalogs.delete(baseUrl);
      catalogs.set(baseUrl, { at: Date.now(), models: list });
      while (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value);
      return list;
    } catch (err) {
      if (controller.signal.aborted) throw new Error('magpie-model-timeout');
      if (err instanceof TypeError) throw new Error('magpie-offline');
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  globalThis.HuayiMagpieClient = Object.freeze({ models });
})();
