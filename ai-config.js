'use strict';

(function () {
  const providers = Object.freeze({
    magpie: Object.freeze({ label: 'Magpie', baseUrl: 'http://127.0.0.1:3425',
      modelsPath: '/v1/models', answerPath: '/v1/responses', format: 'responses', keyRequired: false,
      note: '保留原有 Magpie 连接方式，无需 API Key。' }),
    deepseek: Object.freeze({ label: 'DeepSeek API', baseUrl: 'https://api.deepseek.com',
      modelsPath: '/models', answerPath: '/chat/completions', format: 'chat', keyRequired: true,
      note: '官方接口地址已内置，填写 DeepSeek API Key 后刷新模型。' })
  });
  function provider(id) {
    if (!Object.prototype.hasOwnProperty.call(providers, id)) throw new Error('ai-provider');
    return providers[id];
  }
  function normalizeBaseUrl(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) {
      throw new Error('ai-address');
    }
    let url;
    try { url = new URL(input.trim()); } catch (err) { throw new Error('ai-address'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('ai-address');
    }
    let path = url.pathname.replace(/\/+$/, '');
    const suffixes = ['/v1/models', '/v1/responses', '/v1'];
    const suffix = suffixes.find(value => path.endsWith(value));
    if (suffix) path = path.slice(0, -suffix.length);
    return url.origin + path;
  }
  function permissionOrigin(baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('ai-address');
    }
    return url.protocol + '//' + url.hostname + '/*';
  }
  function validModel(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(id);
  }
  function normalizeKey(value) {
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value.trim())) {
      throw new Error('ai-key');
    }
    return value.trim();
  }
  function connection(providerId, value = {}) {
    const service = provider(providerId);
    return { provider: providerId, baseUrl: providerId === 'magpie' ?
      normalizeBaseUrl(value.baseUrl === undefined ? service.baseUrl : value.baseUrl) : service.baseUrl,
      model: validModel(value.model) ? value.model : '', apiKey: providerId === 'magpie' ? '' : normalizeKey(value.apiKey) };
  }
  function normalizeSettings(value = {}) {
    const knownProvider = value.provider === undefined || Object.prototype.hasOwnProperty.call(providers, value.provider);
    const providerId = knownProvider && value.provider !== undefined ? value.provider : 'magpie';
    const profiles = {};
    for (const id of Object.keys(providers)) {
      // Migrate the original flat Magpie settings without replacing the user's address or model.
      const profile = value.profiles?.[id] || (!value.profiles && value.provider === undefined && id === 'magpie' ? value : {});
      const item = connection(id, profile);
      profiles[id] = { ...(id === 'magpie' ? { baseUrl: item.baseUrl } : {}), model: item.model, apiKey: item.apiKey };
    }
    return { enabled: value.enabled !== false && (knownProvider || value.mode === 'sequential'),
      mode: value.mode === 'sequential' ? 'sequential' : 'ai',
      provider: providerId, profiles: profiles };
  }
  function active(settings) { return connection(settings.provider, settings.profiles[settings.provider]); }
  function sameConnection(a, b) {
    return a && b && a.provider === b.provider && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
  }
  globalThis.HuayiAIConfig = Object.freeze({ providers, provider, normalizeBaseUrl,
    permissionOrigin, validModel, connection, normalizeSettings, active, sameConnection });
})();
