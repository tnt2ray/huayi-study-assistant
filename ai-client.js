'use strict';

(function () {
  const config = globalThis.HuayiAIConfig;
  const catalogs = new Map();
  function headers(connection) {
    const value = { Accept: 'application/json' };
    if (connection.apiKey) value.Authorization = 'Bearer ' + connection.apiKey;
    return value;
  }
  async function requireAccess(connection) {
    if (config.provider(connection.provider).keyRequired && !connection.apiKey) throw new Error('ai-key');
    if (!await chrome.permissions.contains({ origins: [config.permissionOrigin(connection.baseUrl)] })) {
      throw new Error('ai-permission');
    }
  }
  async function checkedFetch(url, options) {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', ...options });
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'ai-auth' :
        response.status === 402 ? 'ai-quota' : response.status === 429 ? 'ai-rate-limit' : 'ai-http';
      throw new Error(code);
    }
    return response;
  }
  async function readText(response, limit, error) {
    if (!response.body) throw new Error(error);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new Error(error);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(function () {}); }
  }
  async function catalogKey(connection) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(connection.apiKey));
    const credential = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    return JSON.stringify([connection.provider, connection.baseUrl, credential]);
  }
  function describeModel(item, connection) {
    const service = config.provider(connection.provider);
    const label = item.display_name || item.magpie_label || item.name || item.id;
    return { id: item.id, label: typeof label === 'string' ? label.slice(0, 200) : item.id,
      format: service.format, answerUrl: connection.baseUrl + service.answerPath,
      maxOutputTokens: Number.isSafeInteger(item.max_output_tokens) && item.max_output_tokens > 0 ?
        Math.min(16000, item.max_output_tokens) : 16000,
      lowReasoning: (Array.isArray(item.reasoning_levels) && item.reasoning_levels.includes('low')) ||
        (Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.some(level => level?.effort === 'low')) };
  }
  async function models(input, signal, refresh) {
    const connection = config.connection(input.provider, input), service = config.provider(connection.provider);
    if (signal && signal.aborted) throw new Error('timeout');
    await requireAccess(connection);
    const key = await catalogKey(connection), cached = catalogs.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300000) return cached.models;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 10000);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    try {
      const response = await checkedFetch(connection.baseUrl + service.modelsPath, {
        headers: headers(connection), signal: controller.signal
      });
      let body;
      const text = await readText(response, 2 * 1024 * 1024, 'ai-models');
      try { body = JSON.parse(text); } catch (err) { throw new Error('ai-models'); }
      const items = body?.data;
      if (!Array.isArray(items) || items.length > 1000) throw new Error('ai-models');
      const seen = new Set(), list = [];
      for (const item of items) {
        if (!item || !config.validModel(item.id) || seen.has(item.id)) continue;
        const model = describeModel(item, connection);
        seen.add(item.id);
        list.push(model);
      }
      if (!list.length) throw new Error('ai-models');
      catalogs.delete(key);
      catalogs.set(key, { at: Date.now(), models: list });
      while (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value);
      return list;
    } catch (err) {
      if (controller.signal.aborted) throw new Error('ai-model-timeout');
      if (err instanceof TypeError) throw new Error('ai-offline');
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  function finalResponseText(response) {
    if (!Array.isArray(response.output)) return '';
    return response.output.filter(item => item.type === 'message' && Array.isArray(item.content))
      .flatMap(item => item.content || []).filter(item => item.type === 'output_text')
      .map(item => item.text || '').join('');
  }
  async function readCompletion(response, format) {
    if (!response.body) throw new Error('model-incomplete');
    let output = '', completed = null, stopped = false, model = '';
    function consumeValue(value) {
      if (!value || value.error) throw new Error('ai-http');
      if (format === 'responses') {
        if (value.type === 'response.output_text.delta') output += value.delta || '';
        if (value.type === 'response.completed') completed = value.response;
        if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw new Error('model-incomplete');
      } else {
        const choice = value.choices?.find(item => item.index === 0);
        if (choice) {
          const content = choice.delta?.content ?? choice.message?.content;
          if (content !== undefined && content !== null) {
            if (typeof content !== 'string') throw new Error('answer-format');
            output += content;
          }
          if (choice.finish_reason) {
            if (choice.finish_reason !== 'stop') throw new Error('model-incomplete');
            stopped = true;
          }
        }
        if (typeof value.model === 'string') model = value.model.slice(0, 100);
      }
      if (output.length > 200000) throw new Error('answer-format');
    }
    function consumeFrame(frame) {
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      let value;
      try { value = JSON.parse(data); } catch (err) { throw new Error('model-incomplete'); }
      consumeValue(value);
    }
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error('model-incomplete');
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            consumeFrame(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
          }
          if (completed || stopped) break;
        }
        buffer += decoder.decode();
        if (buffer.trim() && !completed && !stopped) consumeFrame(buffer);
      } finally { await reader.cancel().catch(function () {}); }
    } else {
      let value;
      const text = await readText(response, 4 * 1024 * 1024, 'model-incomplete');
      try { value = JSON.parse(text); } catch (err) { throw new Error('model-incomplete'); }
      if (format === 'responses') completed = value;
      else consumeValue(value);
    }
    if (format === 'responses') {
      if (!completed || completed.status !== 'completed') throw new Error('model-incomplete');
      output = finalResponseText(completed) || output;
      model = typeof completed.model === 'string' ? completed.model.slice(0, 100) : '';
    } else if (!stopped) throw new Error('model-incomplete');
    if (!output.trim() || output.length > 200000) throw new Error('model-incomplete');
    return { modelReply: output, model: model };
  }
  async function complete(input, selected, instructions, questions, signal, onHeaders) {
    const connection = config.connection(input.provider, input);
    await requireAccess(connection);
    if (signal.aborted) throw new Error('timeout');
    const body = selected.format === 'responses' ?
      { model: selected.id, instructions: instructions, input: JSON.stringify({ questions: questions }),
        stream: true, store: false, max_output_tokens: selected.maxOutputTokens,
        ...(selected.lowReasoning ? { reasoning: { effort: 'low' } } : {}) } :
      { model: selected.id, messages: [{ role: 'system', content: instructions },
        { role: 'user', content: JSON.stringify({ questions: questions }) }],
        stream: true, max_tokens: selected.maxOutputTokens,
        response_format: { type: 'json_object' }, thinking: { type: 'disabled' } };
    try {
      const response = await checkedFetch(selected.answerUrl, {
        method: 'POST', headers: { ...headers(connection), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body), signal: signal
      });
      onHeaders();
      const result = await readCompletion(response, selected.format);
      return { modelReply: result.modelReply, model: result.model || selected.id };
    } catch (err) {
      if (err instanceof TypeError) throw new Error('ai-offline');
      throw err;
    }
  }
  globalThis.HuayiAIClient = Object.freeze({ models, complete });
})();
