(function () {
  'use strict';

  const PATCH_FLAG = '__huayiSilentSignPatched__';
  const PLAY_OVER_PATCH_FLAG = '__huayiAutoNextPlayOverPatched__';
  const PLAY_START_PATCH_FLAG = '__huayiInitialRestorePatched__';
  const FINISHED_STATUS_TEXTS = ['待考试', '已完成', '已通过', '已学习', '考试通过'];
  const AUTO_NEXT_DELAY_MS = 1000;
  const STUDY_CHANNEL = 'huayi-study-flow-v1';
  const INITIAL_RESTORE_WINDOW_MS = 15000;
  const INITIAL_AUTOPLAY_WINDOW_MS = 45000;
  const initialAutoPlayDeadline = Date.now() + INITIAL_AUTOPLAY_WINDOW_MS;

  let autoNextScheduled = false;
  let autoNextTimer = null;
  let autoNextNavigated = false;
  let pageLeaving = false;
  const observedVideos = new WeakSet();
  const observedSeekSources = new WeakSet();
  let pendingInitialRestore = null;
  let publishedRoute = null;
  let navigationGeneration = 0;
  let initialAutoPlayStopped = false;
  let initialPlayAttempt = null;
  let lastInitialPlayAttemptAt = 0;

  function clearExistingSignDialog() {
    if (pageLeaving || window.abnormalPluginBlocked || window.securityAlertShown) {
      return false;
    }
    const existingDialog = document.querySelector('.study_diaog');
    if (!existingDialog) {
      return false;
    }

    if (typeof window.$ === 'function') {
      window.$('.sign-in-menu').empty();
    } else {
      const menu = document.querySelector('.sign-in-menu');
      if (menu) {
        menu.innerHTML = '';
      } else {
        existingDialog.remove();
      }
    }

    if (typeof window.player !== 'undefined' && window.player) {
      if (typeof window.player.j2s_resumeVideo === 'function') {
        window.player.j2s_resumeVideo();
      } else if (typeof window.player.resume === 'function') {
        window.player.resume();
      }
    }

    if (typeof window.addPlaySign === 'function') {
      window.addPlaySign();
    }

    if (typeof window.isInitialSign !== 'undefined') {
      window.isInitialSign = true;
    }
    if (typeof window.timerSign !== 'undefined' && window.timerSign) {
      clearInterval(window.timerSign);
    }
    return true;
  }

  function silentInitialSign() {
    try {
      if (pageLeaving || window.abnormalPluginBlocked || window.securityAlertShown) {
        return;
      }
      if (typeof window.isInitialSign !== 'undefined' && window.isInitialSign) {
        return;
      }
      window.isInitialSign = true;

      if (typeof window.timerSign !== 'undefined' && window.timerSign) {
        clearInterval(window.timerSign);
      }

      if (typeof window.$ === 'function') {
        window.$('.sign-in-menu').empty();
      } else {
        const menu = document.querySelector('.sign-in-menu');
        if (menu) {
          menu.innerHTML = '';
        }
      }

      if (typeof window.addPlaySign === 'function') {
        window.addPlaySign();
      }
    } catch (err) {
      // 保持静默，避免影响原页面逻辑
    }
  }
  silentInitialSign[PATCH_FLAG] = true;

  function isElementVisible(el) {
    if (!el) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function showNativeTip(message) {
    try {
      if (typeof window.initialTip === 'function') {
        window.initialTip(message);
      }
    } catch (err) {
      // 忽略提示渲染异常
    }
  }

  function getCurrentCoursewareId() {
    if (typeof window.cwrid === 'string' && window.cwrid.trim()) {
      return window.cwrid.trim().toLowerCase();
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const cwid = params.get('cwid');
      return cwid ? cwid.trim().toLowerCase() : '';
    } catch (err) {
      return '';
    }
  }

  function cancelInitialRestore() {
    if (pendingInitialRestore) {
      pendingInitialRestore.cancelled = true;
      pendingInitialRestore = null;
    }
  }

  function observeInitialRestore(player) {
    const events = player && player.HTML5;
    if (!events || typeof events.on !== 'function' || observedSeekSources.has(events)) {
      return;
    }
    events.on('videoSeeked', function () {
      const restore = pendingInitialRestore;
      if (!restore || restore.player !== player || restore.consumed) {
        return;
      }
      const elapsed = Date.now() - restore.startedAt;
      let currentTime;
      try {
        currentTime = Number(player.j2s_getCurrentTime());
      } catch (err) {
        cancelInitialRestore();
        return;
      }
      if (
        elapsed > INITIAL_RESTORE_WINDOW_MS ||
        !Number.isFinite(currentTime) ||
        currentTime < restore.target - 0.5 ||
        currentTime > restore.target + elapsed / 1000 + 2
      ) {
        cancelInitialRestore();
        return;
      }

      restore.consumed = true;
      // Run after the page's seek listeners, whichever order they were registered in.
      setTimeout(function () {
        if (
          restore.cancelled ||
          pendingInitialRestore !== restore ||
          pageLeaving ||
          window.abnormalPluginBlocked ||
          window.securityAlertShown
        ) {
          return;
        }
        const notice = document.getElementById('div_processbar_tip');
        if (notice === restore.notice) {
          notice.style.display = 'none';
        }
        cancelInitialRestore();
      }, 0);
    });
    observedSeekSources.add(events);
  }

  function wrapOnPlayStart() {
    if (
      typeof window.s2j_onPlayStart !== 'function' ||
      window.s2j_onPlayStart[PLAY_START_PATCH_FLAG]
    ) {
      return;
    }
    const originalOnPlayStart = window.s2j_onPlayStart;
    const patchedOnPlayStart = function () {
      const player = window.player;
      if (
        window.ifFirstPlay !== 1 ||
        !player ||
        typeof player.j2s_seekVideo !== 'function' ||
        typeof window.getMaxPlayTime !== 'function'
      ) {
        return originalOnPlayStart.apply(this, arguments);
      }

      observeInitialRestore(player);
      const originalSeek = player.j2s_seekVideo;
      const initialSeek = function (time) {
        cancelInitialRestore();
        const notice = document.getElementById('div_processbar_tip');
        let savedProgress;
        try {
          savedProgress = Number(window.getMaxPlayTime());
        } catch (err) {
          savedProgress = NaN;
        }
        const target = Number(time);
        // Only correlate the page's own first resume at its existing saved progress.
        if (
          notice &&
          !isElementVisible(notice) &&
          Number.isFinite(target) &&
          target >= 0 &&
          target === savedProgress
        ) {
          pendingInitialRestore = {
            player: player,
            notice: notice,
            target: target,
            startedAt: Date.now(),
            consumed: false,
            cancelled: false
          };
        }
        return originalSeek.apply(this, arguments);
      };
      player.j2s_seekVideo = initialSeek;
      try {
        return originalOnPlayStart.apply(this, arguments);
      } catch (err) {
        cancelInitialRestore();
        throw err;
      } finally {
        if (player.j2s_seekVideo === initialSeek) {
          player.j2s_seekVideo = originalSeek;
        }
      }
    };
    patchedOnPlayStart[PLAY_START_PATCH_FLAG] = true;
    window.s2j_onPlayStart = patchedOnPlayStart;
  }

  function getPlaybackVideo() {
    return document.querySelector('#video video.pv-video, #video video');
  }

  function signalConnectionTransition(phase, targetUrl) {
    try {
      const record = { kind: 'transition', phase: phase };
      if (phase === 'depart') {
        record.nextId = new URL(targetUrl, window.location.href).searchParams.get('cwid');
      }
      document.dispatchEvent(new CustomEvent('huayi-connection-guard-v1', {
        detail: JSON.stringify(record)
      }));
    } catch (err) {
      // Optional connection protection must not interrupt natural navigation.
    }
  }

  function cancelAutoNext() {
    navigationGeneration += 1;
    if (autoNextScheduled && !autoNextNavigated) {
      signalConnectionTransition('cancel');
    }
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
    autoNextScheduled = false;
  }

  function observePlaybackEnd() {
    const video = getPlaybackVideo();
    if (!video || observedVideos.has(video)) {
      return;
    }
    video.addEventListener('ended', function () {
      scheduleAutoNextCourseware(video);
    });
    ['play', 'seeking', 'emptied'].forEach(function (type) {
      video.addEventListener(type, function () {
        if (getPlaybackVideo() === video) {
          cancelAutoNext();
        }
      });
    });
    observedVideos.add(video);
  }

  function hasNavigationBlocker() {
    return (
      pageLeaving ||
      window.abnormalPluginBlocked ||
      window.securityAlertShown ||
      isElementVisible(document.getElementById('div_tip1')) ||
      isElementVisible(document.getElementById('div_tip')) ||
      Array.from(document.querySelectorAll('.layui-layer-dialog')).some(function (dialog) {
        if (!isElementVisible(dialog)) {
          return false;
        }
        const content = dialog.querySelector('.layui-layer-content');
        // A transport-error notice must not reinstate the removed report-success gate.
        return !content || content.textContent.trim() !== '网络异常，请重新进入学习';
      })
    );
  }

  function isPlaybackComplete(video) {
    video = video || getPlaybackVideo();
    return Boolean(
      video &&
      video.ended &&
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      Number.isFinite(video.currentTime) &&
      video.currentTime >= video.duration - 0.5
    );
  }

  function validatedCoursewareUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return '';
    }
    try {
      const url = new URL(rawUrl, window.location.href);
      if (
        url.origin === window.location.origin &&
        /^\/course_ware\/course_ware(?:_[a-z0-9]+)?\.aspx$/i.test(url.pathname) &&
        url.searchParams.get('cwid')
      ) {
        return url.href;
      }
    } catch (err) {
      // A malformed course link must not interrupt the page's completion handler.
    }
    return '';
  }

  function parseCoursewareItems() {
    const currentCwrid = getCurrentCoursewareId();
    const lis = Array.from(
      document.querySelectorAll('.lis-content li.lis-inside-content, .lis-content li')
    );

    return lis.map(function (li) {
      const onclick = li.getAttribute('onclick') || '';
      const onclickMatch = onclick.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
      const anchor = li.querySelector('a[href]');
      const linkHref = anchor ? anchor.getAttribute('href') || '' : '';
      const progressRow = li.querySelector('.cw-progress-row');
      const dataCwrid = progressRow ? (progressRow.getAttribute('data-cwrid') || '').trim() : '';

      let targetUrl = onclickMatch ? onclickMatch[1].trim() : linkHref.trim();
      if (!targetUrl && dataCwrid) {
        targetUrl = 'course_ware.aspx?cwid=' + encodeURIComponent(dataCwrid);
      }
      targetUrl = validatedCoursewareUrl(targetUrl);

      const cwidMatch = targetUrl.match(/[?&]cwid=([^&#'"]+)/i);
      const itemCwid = (dataCwrid || (cwidMatch ? cwidMatch[1] : '')).trim().toLowerCase();

      const isCurrent =
        li.classList.contains('current-playing') ||
        Boolean(li.querySelector('#top_play')) ||
        Boolean(itemCwid && currentCwrid && itemCwid === currentCwrid);

      const statusBtn = li.querySelector('.cw-tag-row button, button');
      const statusText = statusBtn ? statusBtn.textContent.trim() : '';
      const tagTexts = Array.from(li.querySelectorAll('.cw-tag-list span')).map(function (s) {
        return s.textContent.trim();
      });
      const h2 = li.querySelector('h2');
      const totalTimeAttr = progressRow ? progressRow.getAttribute('data-totaltime') : null;

      const isInteractive =
        tagTexts.indexOf('互动') !== -1 ||
        Boolean(li.querySelector('.hd-flag')) ||
        totalTimeAttr === '0';

      const isElective =
        tagTexts.indexOf('选修') !== -1 ||
        Boolean(h2 && h2.classList.contains('again-text'));

      const isFinished =
        FINISHED_STATUS_TEXTS.indexOf(statusText) !== -1 ||
        Boolean(progressRow && progressRow.getAttribute('data-completed') === '1');

      return {
        targetUrl: targetUrl,
        isCurrent: isCurrent,
        isInteractive: isInteractive,
        isElective: isElective,
        isFinished: isFinished
      };
    });
  }

  function findNextCourseware() {
    const items = parseCoursewareItems();
    if (!items.length) {
      return null;
    }

    const currentIndex = items.findIndex(function (item) {
      return item.isCurrent;
    });
    if (currentIndex < 0) {
      return null;
    }
    const currentItem = items[currentIndex];
    const orderedCandidates = items.slice(currentIndex + 1).concat(items.slice(0, currentIndex));

    // 优先查找下一个未完成学习的必修视频课件（跳过互动病例与选修课）
    const nextRequired = orderedCandidates.find(function (item) {
      return (
        Boolean(item.targetUrl) &&
        !item.isCurrent &&
        !item.isInteractive &&
        !item.isElective &&
        !item.isFinished
      );
    });
    if (nextRequired) {
      return nextRequired;
    }

    // 若当前用户正在主动观看选修视频，则允许继续查找下一个未完成的选修视频课件（仍跳过非视频互动项）
    if (currentItem && currentItem.isElective) {
      const nextElective = orderedCandidates.find(function (item) {
        return (
          Boolean(item.targetUrl) &&
          !item.isCurrent &&
          !item.isInteractive &&
          !item.isFinished
        );
      });
      if (nextElective) {
        return nextElective;
      }
    }

    return null;
  }

  function publishStudyRoute(phase, requestId) {
    try {
      const next = findNextCourseware();
      const nextUrl = next ? next.targetUrl : '';
      if (phase === 'cache' && publishedRoute === nextUrl) return true;
      document.dispatchEvent(new CustomEvent(STUDY_CHANNEL, { detail: JSON.stringify({
        phase: phase, nextUrl: nextUrl, requestId: requestId || ''
      }) }));
      publishedRoute = nextUrl;
      return true;
    } catch (err) {
      // Route discovery must not interrupt the original playback handlers.
      return false;
    }
  }

  function prepareExamRoute() {
    return new Promise(function (resolve) {
      const requestId = Date.now() + '-' + Math.random().toString(36).slice(2);
      const eventName = STUDY_CHANNEL + '-reply';
      const timeout = setTimeout(() => finish(null), 5000);
      function finish(reply) {
        clearTimeout(timeout);
        document.removeEventListener(eventName, receive);
        resolve(reply);
      }
      function receive(event) {
        if (typeof event.detail !== 'string' || event.detail.length > 500) return;
        try {
          const reply = JSON.parse(event.detail);
          if (reply.requestId === requestId) finish(reply);
        } catch (err) { /* Ignore unrelated page events. */ }
      }
      document.addEventListener(eventName, receive);
      if (!publishStudyRoute('complete', requestId)) finish(null);
    });
  }

  function scheduleExam(video, sourceUrl) {
    const until = Date.now() + 10000;
    const generation = navigationGeneration;
    async function enter() {
      autoNextTimer = null;
      if (generation !== navigationGeneration) return;
      if (hasNavigationBlocker() || location.href !== sourceUrl || getPlaybackVideo() !== video || !isPlaybackComplete(video)) {
        cancelAutoNext();
        return;
      }
      const entry = document.getElementById('jrks');
      if (!entry || !isElementVisible(entry) || entry.hasAttribute('disabled') || entry.getAttribute('aria-disabled') === 'true') {
        if (Date.now() < until) autoNextTimer = setTimeout(enter, 150);
        else showNativeTip('考试入口尚未就绪，请查看页面。');
        return;
      }
      const route = await prepareExamRoute();
      if (generation !== navigationGeneration || !autoNextScheduled || hasNavigationBlocker() || location.href !== sourceUrl || getPlaybackVideo() !== video ||
          !isPlaybackComplete(video) || !isElementVisible(entry) || !entry.isConnected ||
          entry.hasAttribute('disabled') || entry.getAttribute('aria-disabled') === 'true') return;
      if (!route || !route.saved) { showNativeTip('连接已断开，请重新加载扩展并刷新本页。'); return; }
      if (route.enabled === false) { showNativeTip('自动处理已关闭。'); return; }
      // The original completion callback has already reported progress and enabled this button.
      // Preserve its payment/eligibility checks; never construct or submit an exam request here.
      autoNextNavigated = true;
      signalConnectionTransition('cancel');
      entry.click();
    }
    // Let the native ended handlers finish; there is no one-second next-video delay for exams.
    autoNextTimer = setTimeout(enter, 0);
  }

  function scheduleAutoNextCourseware(video) {
    video = video || getPlaybackVideo();
    if (
      autoNextScheduled ||
      autoNextNavigated ||
      hasNavigationBlocker() ||
      !validatedCoursewareUrl(window.location.href) ||
      getPlaybackVideo() !== video ||
      !isPlaybackComplete(video)
    ) {
      return;
    }

    autoNextScheduled = true;
    const sourceUrl = window.location.href;
    const exam = document.getElementById('jrks');
    if (exam && /进入考试/.test(exam.textContent)) {
      scheduleExam(video, sourceUrl);
      return;
    }

    function tryNavigate() {
      autoNextTimer = null;
      if (
        hasNavigationBlocker() ||
        window.location.href !== sourceUrl ||
        getPlaybackVideo() !== video ||
        !isPlaybackComplete(video)
      ) {
        signalConnectionTransition('cancel');
        autoNextScheduled = false;
        return;
      }

      const nextItem = findNextCourseware();
      if (!nextItem || !nextItem.targetUrl) {
        signalConnectionTransition('cancel');
        showNativeTip('未找到下一课件。');
        return;
      }

      try {
        if (typeof window.clearCurrentCourseWarePlayState === 'function') {
          window.clearCurrentCourseWarePlayState();
        }
      } catch (err) {
        signalConnectionTransition('cancel');
        showNativeTip('播放状态异常，请刷新本页。');
        return;
      }

      autoNextNavigated = true;
      signalConnectionTransition('depart', nextItem.targetUrl);
      window.location.href = nextItem.targetUrl;
    }

    autoNextTimer = setTimeout(tryNavigate, AUTO_NEXT_DELAY_MS);
  }

  function wrapOnPlayOver() {
    if (
      typeof window.s2j_onPlayOver !== 'function' ||
      window.s2j_onPlayOver.__huayiAutoNextVersion__ === '1.0.1'
    ) {
      return;
    }

    const currentOnPlayOver = window.s2j_onPlayOver;
    const originalOnPlayOver =
      currentOnPlayOver[PLAY_OVER_PATCH_FLAG] && currentOnPlayOver.__originalOnPlayOver__
        ? currentOnPlayOver.__originalOnPlayOver__
        : currentOnPlayOver;
    const patchedOnPlayOver = function () {
      const result = originalOnPlayOver.apply(this, arguments);
      try {
        scheduleAutoNextCourseware();
      } catch (err) {
        // 保持静默，不影响原页面结算
      }
      return result;
    };
    patchedOnPlayOver[PLAY_OVER_PATCH_FLAG] = true;
    patchedOnPlayOver.__huayiAutoNextVersion__ = '1.0.1';
    patchedOnPlayOver.__originalOnPlayOver__ = originalOnPlayOver;
    window.s2j_onPlayOver = patchedOnPlayOver;
  }

  function stopInitialAutoPlay() {
    initialAutoPlayStopped = true;
    initialPlayAttempt = null;
  }

  function initialPlaybackBlocked() {
    // The transport-dialog exception applies to completed-video navigation only.
    return hasNavigationBlocker() || !navigator.onLine ||
      Boolean(document.querySelector('.study_diaog')) ||
      Array.from(document.querySelectorAll('.layui-layer-dialog')).some(isElementVisible);
  }

  function canContinueInitialPlay(attempt) {
    const video = attempt.video;
    return !initialAutoPlayStopped && Date.now() < initialAutoPlayDeadline &&
      initialPlayAttempt === attempt && getPlaybackVideo() === video &&
      window.player === attempt.player &&
      (video.currentSrc || video.src) === attempt.source &&
      video.paused && !video.ended && !video.seeking && !video.error &&
      !initialPlaybackBlocked();
  }

  async function startInitialPlay(attempt) {
    const video = attempt.video;
    try {
      try {
        const pending = attempt.player.j2s_resumeVideo();
        if (pending && typeof pending.catch === 'function') pending.catch(function () {});
      } catch (err) {
        // The media element below reports whether autoplay was actually denied.
      }
      if (!canContinueInitialPlay(attempt)) return;
      try {
        await video.play();
      } catch (err) {
        if (!err || err.name !== 'NotAllowedError' || !canContinueInitialPlay(attempt)) return;
        // Only autoplay-policy rejection permits a muted retry on this same source.
        video.muted = true;
        await video.play();
      }
    } catch (err) {
      // A later readiness event may retry; never interrupt the site's player.
    } finally {
      if (initialPlayAttempt === attempt) initialPlayAttempt = null;
    }
  }

  function ensureInitialAutoPlay() {
    if (initialAutoPlayStopped) return;
    if (pageLeaving || Date.now() >= initialAutoPlayDeadline) {
      stopInitialAutoPlay();
      return;
    }
    const video = getPlaybackVideo();
    if (!video) return;
    // A saved currentTime or the site's first-play flag does not prove playback.
    // Once this document really played, later pauses belong to the user/site.
    if (video.ended || video.played.length > 0 || (!video.paused && video.readyState >= 3)) {
      stopInitialAutoPlay();
      return;
    }
    if (!video.paused || video.seeking || video.error || initialPlaybackBlocked()) return;
    const player = window.player;
    if (!player || typeof player.j2s_resumeVideo !== 'function') return;
    const source = video.currentSrc || video.src;
    if (initialPlayAttempt && initialPlayAttempt.video === video &&
        initialPlayAttempt.player === player && initialPlayAttempt.source === source) return;
    if (Date.now() - lastInitialPlayAttemptAt < 1000) return;
    // Readiness can arrive between installer polls; attach callbacks before starting.
    wrapOnPlayStart();
    wrapOnPlayOver();
    observePlaybackEnd();
    lastInitialPlayAttemptAt = Date.now();
    const attempt = { video: video, player: player, source: source };
    initialPlayAttempt = attempt;
    startInitialPlay(attempt);
  }

  function installPatch() {
    publishStudyRoute('cache');
    wrapOnPlayStart();
    observePlaybackEnd();
    clearExistingSignDialog();

    if (typeof window.initialSign === 'function' && !window.initialSign[PATCH_FLAG]) {
      window.initialSign = silentInitialSign;
    }

    wrapOnPlayOver();

    if (
      !autoNextScheduled &&
      isPlaybackComplete()
    ) {
      scheduleAutoNextCourseware();
    }
    ensureInitialAutoPlay();
  }

  ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (event.target === getPlaybackVideo()) ensureInitialAutoPlay();
    }, true);
  });
  installPatch();
  window.addEventListener('load', installPatch, { once: true });
  window.addEventListener('pagehide', function () {
    pageLeaving = true;
    stopInitialAutoPlay();
    if (!autoNextNavigated) {
      signalConnectionTransition('cancel');
    }
    cancelInitialRestore();
    cancelAutoNext();
  });
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (event.isTrusted) {
        cancelInitialRestore();
        stopInitialAutoPlay();
      }
    }, true);
  });

  // 在页面初始化阶段做短暂巡检，确保播放器就绪后重写与自动起播生效
  let checks = 0;
  const checkTimer = setInterval(function () {
    installPatch();
    checks += 1;
    if (checks >= 20) {
      clearInterval(checkTimer);
    }
  }, 1000);

  // Ended events handle normal completion; polling also covers a late-ready or replaced player.
  setInterval(function () {
    installPatch();
  }, 3000);
})();
