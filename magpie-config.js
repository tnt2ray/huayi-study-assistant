'use strict';

(function () {
  const defaultBaseUrl = 'http://127.0.0.1:3425';
  function normalizeBaseUrl(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) {
      throw new Error('magpie-address');
    }
    let url;
    try { url = new URL(input.trim()); } catch (err) { throw new Error('magpie-address'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('magpie-address');
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/(?:models|responses))?$/, '');
    return url.origin + path;
  }
  function permissionOrigin(baseUrl) {
    const url = new URL(normalizeBaseUrl(baseUrl));
    return url.protocol + '//' + url.hostname + '/*';
  }
  function validModel(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(id);
  }
  globalThis.HuayiMagpieConfig = Object.freeze({ defaultBaseUrl, normalizeBaseUrl, permissionOrigin, validModel });
})();
