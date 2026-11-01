'use strict';

(function () {
  if (window.top !== window || !/^\/pages\/exam(?:_result)?\.aspx$/i.test(location.pathname)) return;
  const CHANNEL = 'huayi-exam-v1';
  const resultPage = /exam_result\.aspx$/i.test(location.pathname);
  const errors = {
    'magpie-offline': '无法连接 Magpie，请检查地址。',
    'magpie-auth': '访问被拒绝，请检查授权。',
    'magpie-http': '服务异常，请稍后重试。',
    'magpie-address': '请在扩展中修改 Magpie 地址。',
    'magpie-permission': '请在扩展中点“刷新”授权访问。',
    'magpie-models': '未获取到模型，请刷新列表。',
    'magpie-model-timeout': '连接超时，请重试。',
    'magpie-model-unavailable': '模型不可用，请重新选择。',
    'timeout': '回答超时，请重试。',
    'model-incomplete': '答案不完整，请重试或换模型。',
    'answer-format': '答案与选项不匹配，请重试。',
    'interrupted': '请求已中断，请重试。',
    'changed': '题目或状态已变化，请核对。',
    'questions': '题型暂不支持，请手动作答。',
    'cancelled': '可手动作答或重试。',
    'feedback': '未读到完整对错标记。',
    'feedback-question': '结果页题干与本轮不符。',
    'feedback-option': '结果页选项与本轮不符。',
    'feedback-submission': '结果页答案与提交记录不符。',
    'feedback-conflict': '对错记录冲突，请核对。',
    'exhausted': '可选答案已耗尽，请人工核对。',
    'no-progress': '没有新增错题反馈，请核对。',
    'disabled': '可在扩展中开启。',
    'unavailable': '连接已断开，请刷新本页。'
  };
  let stopped = false, submitting = false, working = false, navigating = false, runId = 0;
  let pollTimer = null, waitingTimer = null, countdownTimer = null;
  let originalSignature = '', currentAnswers = null, panel = null;

  function normalized(value) { return value.normalize('NFC').replace(/\s+/g, ' ').trim(); }
  function send(action, payload) {
    return chrome.runtime.sendMessage({ type: CHANNEL, action: action, ...payload });
  }
  function enteredFromResultPage() {
    const navigation = performance.getEntriesByType('navigation')[0];
    if (!navigation || navigation.type !== 'navigate') return false;
    try {
      const previous = new URL(document.referrer), current = new URL(location.href);
      const course = current.searchParams.get('cwid');
      return !!course && previous.origin === current.origin &&
        /^\/pages\/exam_result\.aspx$/i.test(previous.pathname) &&
        (previous.searchParams.get('cwid') || '').toLowerCase() === course.toLowerCase();
    } catch (err) { return false; }
  }
  function visible(element) {
    if (!element || !element.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  function siteBlocked() {
    return Array.from(document.querySelectorAll(
      '#div_tip, #div_tip1, .layui-layer-content, .study_diaog, [role="alertdialog"], [role="dialog"], dialog[open], ' +
      '[id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i]'
    )).some(visible);
  }
  function notice(title, detail, retry) {
    if (!panel) {
      const host = document.createElement('div');
      host.id = 'huayi-exam-assistant';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;' +
        'display:block;width:320px;max-width:calc(100vw - 40px);font:13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;color:#21303d}' +
        'section{background:white;border:1px solid #e0e7ec;border-radius:12px;padding:16px;box-shadow:0 4px 24px #163b4f12;max-height:65vh;overflow:auto}' +
        'strong{display:block;font-size:14px;font-weight:600}p{margin:6px 0;color:#657583;white-space:pre-wrap;overflow-wrap:anywhere}' +
        'button{border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font:inherit;margin:10px 8px 0 0;background:#087f8c;color:white}' +
        'button:disabled{opacity:.5;cursor:default}button:focus-visible,summary:focus-visible{outline:2px solid #1698ad;outline-offset:3px}' +
        '[hidden]{display:none!important}' +
        '.model-answer{margin:10px 0;padding:8px 0;border-top:1px solid #e9edf1}' +
        '.model-answer b{font-weight:500;color:#9b6a1a}' +
        '.model-answer p{font-size:12px;margin:4px 0}' +
        'details{margin:10px 0 0}summary{cursor:pointer;font-size:12px;color:#087f8c}' +
        'pre{font:12px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:250px;overflow:auto}';
      const section = document.createElement('section');
      section.setAttribute('role', 'status');
      const heading = document.createElement('strong');
      const detailText = document.createElement('p');
      const pause = document.createElement('button');
      pause.type = 'button'; pause.textContent = '暂停';
      pause.addEventListener('click', () => stop('已暂停', '可手动继续或重试。', true, true));
      const restart = document.createElement('button');
      restart.type = 'button'; restart.textContent = '重试'; restart.hidden = true;
      restart.addEventListener('click', () => resultPage ? startResult(true) : start(true));
      const modelInfo = document.createElement('div');
      modelInfo.hidden = true;
      section.append(heading, detailText, modelInfo, pause, restart);
      root.append(style, section);
      document.body.append(host);
      panel = { heading: heading, detail: detailText, pause: pause, restart: restart, modelInfo: modelInfo };
    }
    panel.heading.textContent = title;
    panel.detail.textContent = detail;
    panel.detail.hidden = !detail;
    panel.pause.hidden = stopped || submitting || !working;
    panel.restart.hidden = !retry || submitting;
  }
  function showAnswerInfo(reply) {
    const info = panel.modelInfo;
    info.replaceChildren();
    info.hidden = false;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '答案详情';
    const model = document.createElement('p');
    model.textContent = reply.mode === 'sequential' ? '无 AI · 第 ' + (reply.attempt || 1) + ' 轮' :
      reply.requested === 0 ? '全部复用已确认答案' : '模型：' + (reply.model || 'Magpie');
    const choices = document.createElement('p');
    choices.textContent = reply.answers.map(answer => answer.n + '. ' + answer.answer).join('  ');
    details.append(summary, model, choices);
    info.append(details);
    if (!reply.modelReply) return;
    const pending = reply.answers.filter(answer => answer.confident !== true);
    for (const answer of pending) {
      const item = document.createElement('div');
      item.className = 'model-answer pending';
      const title = document.createElement('b');
      title.textContent = '第 ' + answer.n + ' 题存疑';
      const suggestion = document.createElement('p');
      suggestion.textContent = answer.answer ? '已填：' + answer.answer + '、' + answer.text : '无候选答案';
      const confidence = document.createElement('p');
      const label = { high: '高', medium: '中', low: '低' }[answer.confidence];
      confidence.textContent = '模型置信度：' + (label ||
        (typeof answer.confidence === 'number' ? Math.round(answer.confidence * 100) + '%' : '未提供'));
      const reason = document.createElement('p');
      reason.textContent = answer.reason || '';
      reason.hidden = !answer.reason;
      item.append(title, suggestion, confidence, reason);
      if (answer.note) {
        const note = document.createElement('p');
        note.textContent = answer.note;
        item.append(note);
      }
      details.append(item);
    }
    const response = document.createElement('details');
    const responseSummary = document.createElement('summary');
    responseSummary.textContent = '模型答复';
    const content = document.createElement('pre');
    // Display only the model's final answer as inert text, never reasoning events or HTML.
    content.textContent = reply.modelReply;
    response.append(responseSummary, content);
    details.append(response);
  }
  function clearTimers() {
    clearTimeout(pollTimer); clearTimeout(waitingTimer); clearInterval(countdownTimer);
  }
  function stop(title, detail, retry, manual) {
    stopped = true; working = false; runId += 1;
    clearTimers();
    if (!submitting && !navigating) send('cancel', { manual: manual === true }).catch(function () {});
    notice(title, detail, retry);
  }

  function extract() {
    const form = document.getElementById('form1');
    const submit = document.getElementById('btn_submit');
    if (!form || !submit || submit.form !== form || !visible(submit) || submit.disabled) throw new Error('questions');
    const controls = Array.from(form.querySelectorAll('input[type="radio"]'));
    if (!controls.length || form.querySelector('input[type="checkbox"]')) throw new Error('questions');
    const groups = new Map();
    for (const input of controls) {
      if (!input.name || input.disabled || !visible(input)) throw new Error('questions');
      if (!groups.has(input.name)) groups.set(input.name, []);
      groups.get(input.name).push(input);
    }
    if (groups.size > 50) throw new Error('questions');
    const questions = [], bindings = [];
    for (const inputs of groups.values()) {
      const table = inputs[0].closest('table');
      if (!table || inputs.some(input => input.closest('table') !== table) ||
          table.querySelector('img, svg, canvas, video, math, iframe')) throw new Error('questions');
      const headings = table.querySelectorAll('th');
      if (headings.length !== 1 || !normalized(headings[0].textContent)) throw new Error('questions');
      const options = [], byLabel = new Map();
      for (const input of inputs) {
        const label = input.labels && input.labels[0];
        const cell = input.closest('td');
        const text = normalized((label && label.textContent) || (cell && cell.textContent) || '');
        const match = /^([A-Z])[、.．:：)）]\s*(.+)$/u.exec(text);
        if (!match || byLabel.has(match[1])) throw new Error('questions');
        options.push({ label: match[1], text: match[2] });
        byLabel.set(match[1], input);
      }
      if (options.length < 2 || options.length > 10) throw new Error('questions');
      questions.push({ n: questions.length + 1, question: normalized(headings[0].textContent), options: options });
      bindings.push(byLabel);
    }
    return { form: form, submit: submit, questions: questions, bindings: bindings,
      signature: JSON.stringify(questions) };
  }

  function unchanged() {
    if (stopped || submitting || siteBlocked()) throw new Error('changed');
    const current = extract();
    if (current.signature !== originalSignature) throw new Error('changed');
    return current;
  }
  function selectionMatches(current, answers, partial) {
    if (partial) {
      return answers.every(function (answer) {
        const group = current.bindings[answer.n - 1];
        if (!group) return false;
        const selected = Array.from(group.entries()).filter(entry => entry[1].checked);
        return selected.length === 1 && selected[0][0] === answer.answer;
      });
    }
    return current.bindings.every(function (group, index) {
      const answer = answers[index];
      if (!answer || answer.n !== index + 1) return false;
      const selected = Array.from(group.entries()).filter(entry => entry[1].checked);
      if (answer.valid !== true) return false;
      return selected.length === 1 && selected[0][0] === answer.answer;
    });
  }
  function fillSelections(current, answers, id, partial) {
    if (!Array.isArray(answers) || answers.length > current.questions.length ||
        (!partial && answers.length !== current.questions.length)) throw new Error('changed');
    const numbers = new Set();
    // Validate every target before changing even the first selection.
    const targets = answers.map(function (answer, index) {
      if (!answer || !Number.isInteger(answer.n) || answer.n < 1 || answer.n > current.questions.length ||
          numbers.has(answer.n) || (!partial && answer.n !== index + 1)) throw new Error('changed');
      numbers.add(answer.n);
      const q = current.questions[answer.n - 1];
      if (answer.valid !== true || (partial && answer.source !== 'site')) throw new Error('answer-format');
      const option = q.options.find(option => option.label === answer.answer);
      if (!option || typeof answer.text !== 'string' || normalized(answer.text) !== option.text) throw new Error('changed');
      const target = current.bindings[answer.n - 1].get(answer.answer);
      if (!target) throw new Error('changed');
      return target;
    });
    for (const target of targets) {
      if (stopped || submitting || id !== runId) return false;
      unchanged();
      if (!target.checked) target.click();
      if (stopped || submitting || id !== runId) return false;
      if (!target.checked) throw new Error('changed');
    }
    if (!selectionMatches(unchanged(), answers, partial)) throw new Error('changed');
    return true;
  }
  async function fillAndSubmit(reply, id) {
    const current = unchanged();
    currentAnswers = reply.answers;
    if (!fillSelections(current, currentAnswers, id)) return;
    showAnswerInfo(reply);
    let seconds = 5;
    const uncertain = currentAnswers.filter(answer => !answer.confident).length;
    const summary = reply.mode === 'sequential' ?
      '无 AI · 第 ' + (reply.attempt || 1) + ' 轮\n复用 ' + reply.retained + ' 题，尝试 ' + reply.tried + ' 题' :
      '复用 ' + reply.retained + ' 题，模型处理 ' + reply.requested + ' 题' +
      (uncertain ? '\n存疑 ' + uncertain + ' 题，见答案详情' : '');
    notice(seconds + ' 秒后交卷', summary, false);
    countdownTimer = setInterval(function () {
      if (stopped || id !== runId) { clearInterval(countdownTimer); return; }
      seconds -= 1;
      notice(Math.max(seconds, 0) + ' 秒后交卷', summary, false);
      if (seconds > 0) return;
      clearInterval(countdownTimer);
      commit(id).catch(err => {
        if (id === runId) stop('交卷已停止', errors[err.message] || errors.unavailable, false);
      });
    }, 1000);
  }

  async function commit(id) {
    const current = unchanged();
    // Keep the selected strategy's choices; taking over requires the panel's pause button.
    if (!fillSelections(current, currentAnswers, id)) return;
    const claim = await send('claim-submit', { questions: current.questions });
    if (stopped || id !== runId) return;
    if (!claim || !claim.permitted) throw new Error(claim && claim.error || 'changed');
    // Recheck after awaiting the persistent submission latch; no bypass of the site's normal handlers.
    const latest = unchanged();
    if (!fillSelections(latest, currentAnswers, id)) return;
    submitting = true; working = false;
    clearTimers();
    notice('正在交卷', '等待考试结果。', false);
    latest.submit.click();
    waitingTimer = setTimeout(function () {
      notice('等待结果', '暂无结果，请查看页面提示。', false);
    }, 15000);
  }

  async function processReply(reply, id) {
    if (stopped || id !== runId) return;
    if (!reply || reply.enabled === false || reply.status === 'disabled') {
      stop('自动答题已关闭', errors.disabled, false); return;
    }
    if (siteBlocked()) { stop('需要处理页面提示', '处理后点重试。', true); return; }
    if (reply.status === 'requesting') {
      if (!Array.isArray(reply.retainedAnswers) || reply.retainedAnswers.length !== reply.retained) throw new Error('changed');
      if (reply.retainedAnswers.length && !fillSelections(unchanged(), reply.retainedAnswers, id, true)) return;
      notice('正在答题', '第 ' + (reply.attempt || 1) + ' 轮，复用 ' + reply.retained + ' 题\n模型处理 ' + reply.requested + ' 题' +
        (reply.excluded ? '，已排除 ' + reply.excluded + ' 个错选项' : ''), false);
      pollTimer = setTimeout(function () {
        send('status').then(next => processReply(next, id)).catch(function (err) {
          if (id === runId) stop('答题已暂停', errors[err.message] || errors.unavailable, true);
        });
      }, 4000);
    } else if (reply.status === 'ready') {
      await fillAndSubmit(reply, id);
    } else if (reply.status === 'passed') {
      stop('考试通过', '', false);
    } else if (reply.status === 'submitting') {
      stop(reply.sameDocument ? '已交卷' : '等待重考',
        reply.sameDocument ? '等待考试结果。' : '请从结果页点“重新考试”。', false);
    } else if (reply.status === 'failed') {
      stop('等待重考', errors[reply.error] ||
        '请从结果页点“重新考试”。', false);
    } else if (reply.status === 'retrying') {
      stop('正在重考', '等待页面跳转。', false);
    } else if (reply.status === 'other-page') {
      stop('本课件正在其他页面处理', '请切回原考试页。', false);
    } else if (reply.status === 'cancelled' && reply.error === 'mode-changed') {
      await start(true);
    } else {
      stop('答题已暂停', errors[reply.error] || errors.cancelled, true);
    }
  }

  async function start(retry) {
    if (submitting) return;
    clearTimers(); stopped = false; working = true; currentAnswers = null;
    const id = ++runId;
    notice('读取题目中', '', false);
    panel.modelInfo.replaceChildren();
    panel.modelInfo.hidden = true;
    try {
      if (siteBlocked()) { stop('需要处理页面提示', '处理后点重试。', true); return; }
      const current = extract();
      originalSignature = current.signature;
      await processReply(await send('start', { questions: current.questions, retry: retry === true,
        fromResultPage: enteredFromResultPage() }), id);
    } catch (err) {
      if (id === runId) stop('答题已暂停', errors[err.message] || errors.unavailable, true);
    }
  }

  function readResult() {
    // Grounded in the original result page: the same CSS class is used for BOTH verdict icons.
    const statuses = Array.from(document.querySelectorAll('p.tips_text')).filter(visible)
      .map(element => normalized(element.textContent));
    const failed = statuses.includes('考试未通过');
    const passed = statuses.includes('考试通过');
    if (failed === passed) return null;
    if (passed) return { outcome: 'passed', rows: [], signature: 'passed' };
    const elements = Array.from(document.querySelectorAll('li.state_cour_lis'))
      .filter(element => visible(element) && element.textContent.includes('您的答案'));
    if (!elements.length || elements.length > 50) throw new Error('feedback');
    const rows = elements.map(function (element) {
      const parts = element.querySelectorAll('p.state_lis_text');
      const icons = element.querySelectorAll('img.state_error');
      if (parts.length !== 2 || icons.length !== 1 || !visible(parts[0]) || !visible(parts[1]) || !visible(icons[0])) throw new Error('feedback');
      const question = normalized(parts[0].textContent);
      const number = /^(\d+)\s*[、.．]\s*(.+)$/.exec(question);
      const answer = /^【您的答案[：:]\s*([A-Z])[、.．]\s*(.+)】$/.exec(normalized(parts[1].textContent));
      const icon = new URL(icons[0].getAttribute('src'), location.href);
      const verdict = icon.origin === location.origin && icon.pathname === '/images/images_20221112/error_icon.png' ? 'wrong' :
        icon.origin === location.origin && icon.pathname === '/images/images_20221112/bar_img.png' ? 'correct' : null;
      if (!number || !answer || !verdict) throw new Error('feedback');
      return { n: Number(number[1]), question: number[2], text: normalized(answer[2]), verdict: verdict };
    });
    if (!rows.some(row => row.verdict === 'wrong')) throw new Error('feedback');
    return { outcome: 'failed', rows: rows, signature: JSON.stringify(rows) };
  }

  function retryButton() {
    const buttons = Array.from(document.querySelectorAll('input.state_foot_btn[type="button"]'))
      .filter(element => element.value === '重新考试' && visible(element) && !element.disabled);
    if (buttons.length !== 1) throw new Error('feedback');
    return buttons[0];
  }

  async function retryExam(result, reply, id) {
    if (stopped || id !== runId || siteBlocked()) throw new Error('changed');
    const current = readResult();
    if (!current || current.signature !== result.signature) throw new Error('changed');
    retryButton();
    const claim = await send('claim-retry', { resultDigest: reply.resultDigest });
    if (stopped || id !== runId) return;
    if (!claim || !claim.permitted) throw new Error(claim && claim.error || 'changed');
    const latest = readResult();
    if (siteBlocked() || !latest || latest.signature !== result.signature) throw new Error('changed');
    navigating = true; working = false;
    clearTimers();
    notice('正在重考', '等待页面跳转。', false);
    retryButton().click();
    waitingTimer = setTimeout(function () {
      notice('等待重考', '暂无跳转，请查看页面提示。', false);
    }, 15000);
  }

  async function processResult(result, resume, id) {
    const reply = await send('result', { outcome: result.outcome, rows: result.rows, resume: resume === true });
    if (stopped || id !== runId) return;
    if (!reply) throw new Error('unavailable');
    if (reply.status === 'passed') {
      if (reply.enabled === false || !reply.continuation || !reply.continuation.nextUrl) {
        stopped = true; working = false;
        notice('考试通过', '', false);
        return;
      }
      let seconds = 3;
      notice('考试通过', seconds + ' 秒后进入下一课', false);
      countdownTimer = setInterval(function () {
        if (stopped || id !== runId) { clearInterval(countdownTimer); return; }
        seconds -= 1;
        notice('考试通过', Math.max(0, seconds) + ' 秒后进入下一课', false);
        if (seconds > 0) return;
        clearInterval(countdownTimer);
        continueCourse(reply.continuation.nextUrl, id).catch(function (err) {
          if (id === runId) stop('连播已暂停', errors[err.message] || errors.unavailable, true);
        });
      }, 1000);
      return;
    }
    if (reply.enabled === false) { stop('自动答题已关闭', errors.disabled, true); return; }
    if (reply.status !== 'failed' || !reply.retryAvailable) {
      stop('重考已暂停', errors[reply.error] ||
        (reply.status === 'other-page' ? '本课件正在其他页面处理，请回到该页面。' :
          '请查看本轮结果。'), reply.status === 'failed' && !reply.error);
      return;
    }
    retryButton();
    let seconds = 5;
    const wrong = result.rows.filter(row => row.verdict === 'wrong').map(row => row.n).join('、');
    const detail = '错题：' + wrong + '。已排除错选项。';
    notice(seconds + ' 秒后重考', detail, false);
    countdownTimer = setInterval(function () {
      if (stopped || id !== runId) { clearInterval(countdownTimer); return; }
      seconds -= 1;
      notice(Math.max(seconds, 0) + ' 秒后重考', detail, false);
      if (seconds > 0) return;
      clearInterval(countdownTimer);
      retryExam(result, reply, id).catch(err => {
        if (id === runId) stop('重考已暂停', errors[err.message] || errors.unavailable, false);
      });
    }, 1000);
  }

  function courseTarget(raw) {
    try {
      const url = new URL(raw, location.href);
      const course = (url.searchParams.get('cwid') || '').toLowerCase();
      if (url.origin !== location.origin || url.username || url.password ||
          !/^\/course_ware\/course_ware(?:_[a-z0-9]+)?\.aspx$/i.test(url.pathname) ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(course) ||
          course === (new URL(location.href).searchParams.get('cwid') || '').toLowerCase()) return null;
      return { course: course, url: url.href };
    } catch (err) { return null; }
  }

  function nativeNextCourse(target) {
    const candidates = [];
    for (const row of document.querySelectorAll('li.state_cour_lis')) {
      // Match the recorded course ID, never the first button or a recommended elective.
      for (const element of row.querySelectorAll('input[type="button"], button, a[href]')) {
        const label = normalized(element.value || element.textContent || '');
        if (!/^(立即学习|继续学习|下一课件|下一课|下一集|学习下一课)$/.test(label) || !visible(element)) continue;
        const assignment = (element.getAttribute('onclick') || '').match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
        const link = courseTarget(assignment ? assignment[1] : element.getAttribute('href'));
        if (link && link.course === target.course) candidates.push(element);
      }
    }
    if (candidates.length > 1) throw new Error('changed');
    const element = candidates[0];
    if (element && (element.disabled || element.getAttribute('aria-disabled') === 'true')) throw new Error('changed');
    return element || null;
  }

  async function continueCourse(nextUrl, id) {
    if (stopped || id !== runId || submitting || navigating) return;
    if (siteBlocked() || readResult()?.outcome !== 'passed') throw new Error('changed');
    const target = courseTarget(nextUrl);
    if (!target) throw new Error('changed');
    const native = nativeNextCourse(target);
    const claim = await send('claim-next', { method: native ? 'native' : 'saved' });
    if (stopped || id !== runId) return;
    if (!claim || !claim.permitted || siteBlocked() || readResult()?.outcome !== 'passed') throw new Error('changed');
    if (native && (!native.isConnected || nativeNextCourse(target) !== native)) throw new Error('changed');
    if (!native && courseTarget(claim.nextUrl)?.course !== target.course) throw new Error('changed');
    navigating = true; working = false;
    clearTimers();
    notice('进入下一课', '', false);
    if (native) native.click();
    else location.href = claim.nextUrl;
    waitingTimer = setTimeout(function () {
      notice('等待跳转', '请查看原站提示。', false);
    }, 15000);
  }

  function startResult(resume) {
    clearTimers(); stopped = false; working = true;
    const id = ++runId, until = Date.now() + 15000;
    notice('读取结果中', '', false);
    async function observe() {
      if (stopped || id !== runId) return;
      try {
        if (siteBlocked()) { stop('需要处理页面提示', '处理后点重试。', true); return; }
        const result = readResult();
        if (result) { await processResult(result, resume, id); return; }
        if (Date.now() >= until) throw new Error('feedback');
        waitingTimer = setTimeout(observe, 500);
      } catch (err) {
        if (id === runId) stop('重考已暂停', errors[err.message] || errors.unavailable, true);
      }
    }
    observe();
  }

  // Save manual retake feedback before the native onclick changes location. This listener
  // never pauses for ordinary input, prevents navigation, or issues a second button click.
  document.addEventListener('click', function (event) {
    if (!resultPage || navigating || !(event.target instanceof Element)) return;
    const button = event.target.closest('input.state_foot_btn[type="button"]');
    if (!button || button.value !== '重新考试' || button.disabled || !visible(button) || siteBlocked()) return;
    navigating = true; working = false; runId += 1;
    clearTimers();
    try {
      const result = readResult();
      if (result && result.outcome === 'failed') {
        send('manual-retake', { outcome: result.outcome, rows: result.rows }).catch(function () {});
      }
    } catch (err) {
      // Unknown feedback must not produce guessed correctness records or block the site's button.
    }
  }, true);

  // Ordinary clicks, changes and keys do not pause automation. Observe an actual form
  // submission only to avoid sending another one while the original navigation is pending.
  window.addEventListener('submit', function (event) {
    if (resultPage || stopped || submitting || !working || event.defaultPrevented ||
        event.target !== document.getElementById('form1')) return;
    submitting = true; working = false; runId += 1;
    clearTimers();
    send('cancel').catch(function () {});
    notice('正在交卷', '等待考试结果。', false);
  });
  window.addEventListener('pagehide', function () {
    stopped = true; runId += 1; clearTimers();
    if (!submitting && !navigating) send('cancel').catch(function () {});
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) stop('页面已恢复', '请手动继续。', false);
  });
  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (sender.id !== chrome.runtime.id || !message || message.type !== CHANNEL ||
        message.action !== 'settings-changed') return;
    if (message.enabled === false && !submitting) {
      stop('自动答题已关闭', errors.disabled, false);
    } else if (message.enabled && message.restart === true && !resultPage &&
        !stopped && working && !submitting && !navigating) {
      start(true);
    }
  });
  if (resultPage) { startResult(false); return; }
  const until = Date.now() + 15000;
  function waitForQuestions() {
    if (stopped) return;
    if (document.querySelector('#form1 input[type="radio"]') || Date.now() >= until) start(false);
    else waitingTimer = setTimeout(waitForQuestions, 500);
  }
  waitForQuestions();
})();
