'use strict';

(function () {
  if (window.top !== window) return;
  const CHANNEL = 'huayi-study-flow-v1';
  let pending = false;
  function courseUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('route');
    const url = new URL(raw, location.href);
    const id = url.searchParams.get('cwid') || '';
    if (url.origin !== location.origin || url.username || url.password ||
        !/^\/course_ware\/course_ware(?:_[a-z0-9]+)?\.aspx$/i.test(url.pathname) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new Error('route');
    url.search = ''; url.hash = '';
    url.searchParams.set('cwid', id.toLowerCase());
    return url.href;
  }
  function listed(raw) {
    const target = courseUrl(raw);
    if (new URL(target).searchParams.get('cwid') === new URL(location.href).searchParams.get('cwid')?.toLowerCase()) throw new Error('route');
    const found = Array.from(document.querySelectorAll('.lis-content li')).some(function (item) {
      const match = (item.getAttribute('onclick') || '').match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
      const id = item.querySelector('[data-cwrid]')?.getAttribute('data-cwrid');
      const href = match ? match[1] : item.querySelector('a[href]')?.getAttribute('href') ||
        (id ? 'course_ware.aspx?cwid=' + encodeURIComponent(id) : '');
      try { return courseUrl(href) === target; } catch (err) { return false; }
    });
    if (!found) throw new Error('route');
    return target;
  }
  document.addEventListener(CHANNEL, async function (event) {
    if (typeof event.detail !== 'string' || event.detail.length > 3000) return;
    let input;
    try { input = JSON.parse(event.detail); } catch (err) { return; }
    if (!input || !['cache', 'complete'].includes(input.phase) || typeof input.requestId !== 'string' || input.requestId.length > 64) return;
    if (pending && input.phase === 'cache') return;
    pending = true;
    let reply = { saved: false };
    try {
      if (input.phase === 'complete') {
        const video = document.querySelector('#video video.pv-video, #video video');
        if (!video || !video.ended || !Number.isFinite(video.duration) || video.duration <= 0 ||
            !Number.isFinite(video.currentTime) || video.currentTime < video.duration - .5) throw new Error('incomplete');
      }
      const nextUrl = input.nextUrl === '' ? '' : listed(input.nextUrl);
      reply = await chrome.runtime.sendMessage({ type: 'huayi-exam-v1', action: 'remember-next',
        nextUrl: nextUrl, complete: input.phase === 'complete' }) || reply;
    } catch (err) { /* Keep the exam button available for manual entry. */ }
    finally { pending = false; }
    if (input.phase === 'complete') document.dispatchEvent(new CustomEvent(CHANNEL + '-reply', {
      detail: JSON.stringify({ requestId: input.requestId, saved: reply.saved === true, enabled: reply.enabled !== false })
    }));
  });
})();
