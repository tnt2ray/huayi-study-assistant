'use strict';

const gateway = globalThis.HuayiMagpieConfig;
const examEnabled = document.getElementById('exam-enabled');
const examMode = document.getElementById('exam-mode');
const magpieSettings = document.getElementById('magpie-settings');
const examEndpoint = document.getElementById('exam-endpoint');
const examModel = document.getElementById('exam-model');
const examLoadModels = document.getElementById('exam-load-models');
const examSave = document.getElementById('exam-save');
const examStatus = document.getElementById('exam-setting-status');
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
let savedSettings = null, loadedBaseUrl = '', busy = false;
const settingErrors = {
  'magpie-address': '请填写有效的 HTTP(S) 地址',
  'magpie-permission': '请点“刷新”授权访问',
  'magpie-offline': '无法连接，请检查地址',
  'magpie-auth': '访问被拒绝，请检查授权',
  'magpie-http': '服务异常，请稍后重试',
  'magpie-models': '未获取到模型，请检查地址',
  'magpie-model-timeout': '连接超时，请重试'
};
function message(action, fields) {
  return chrome.runtime.sendMessage({ type: 'huayi-exam-v1', action: action, ...fields });
}
function setStatus(text, tone) {
  examStatus.textContent = text;
  examStatus.dataset.tone = tone || '';
}
function setBusy(value, action) {
  busy = value;
  examEnabled.disabled = examMode.disabled = examSave.disabled = value;
  const ai = examMode.value === 'ai';
  examEndpoint.disabled = examLoadModels.disabled = value || !ai;
  examModel.disabled = value || !ai || !loadedBaseUrl;
  examLoadModels.dataset.loading = String(value && action === 'models');
  examSave.textContent = value && action === 'save' ? '保存中…' : '保存设置';
}
function clearModels() {
  loadedBaseUrl = '';
  examModel.replaceChildren(new Option('请刷新模型', ''));
  examModel.title = '';
  examModel.disabled = true;
}
function showChanged() {
  const changed = savedSettings && (examEnabled.checked !== savedSettings.enabled ||
    examMode.value !== savedSettings.mode || (examMode.value === 'ai' &&
      (examEndpoint.value.trim() !== savedSettings.baseUrl || examModel.value !== savedSettings.model)));
  setStatus(changed ? '未保存' : '');
}
async function loadModels(askPermission) {
  if (busy || examMode.value !== 'ai') return;
  let baseUrl;
  const preferred = examModel.value || (savedSettings && savedSettings.model);
  try { baseUrl = gateway.normalizeBaseUrl(examEndpoint.value); }
  catch (err) { setStatus(settingErrors[err.message], 'error'); return; }
  setBusy(true, 'models');
  setStatus('连接中…');
  try {
    // Keep the permission request directly in the user's refresh click.
    const permission = { origins: [gateway.permissionOrigin(baseUrl)] };
    const granted = await (askPermission ? chrome.permissions.request(permission) : chrome.permissions.contains(permission));
    if (!granted) throw new Error('magpie-permission');
    const result = await message('models-list', { baseUrl: baseUrl, refresh: askPermission });
    if (!result || !Array.isArray(result.models) || !result.models.length) throw new Error(result && result.error || 'magpie-models');
    examEndpoint.value = result.baseUrl;
    loadedBaseUrl = result.baseUrl;
    const labels = new Map();
    for (const item of result.models) labels.set(item.label, (labels.get(item.label) || 0) + 1);
    examModel.replaceChildren(...result.models.map(item => new Option(
      labels.get(item.label) > 1 && item.label !== item.id ? item.label + ' (' + item.id + ')' : item.label, item.id)));
    const missingPreferred = preferred && !result.models.some(item => item.id === preferred);
    if (missingPreferred) {
      const placeholder = new Option('请选择模型', '');
      placeholder.disabled = true;
      examModel.prepend(placeholder);
    }
    examModel.value = missingPreferred ? '' : preferred || result.models[0].id;
    examModel.title = examModel.value;
    if (missingPreferred) setStatus('原模型不可用，请重新选择', 'error');
    else showChanged();
  } catch (err) {
    clearModels();
    setStatus(settingErrors[err.message] || '加载失败，请重试', 'error');
  } finally { setBusy(false); }
}
examEndpoint.addEventListener('input', function () {
  clearModels();
  setStatus('地址已修改，请刷新模型');
});
examEnabled.addEventListener('change', showChanged);
examMode.addEventListener('change', function () {
  magpieSettings.hidden = examMode.value !== 'ai';
  setBusy(false);
  showChanged();
  if (examMode.value === 'ai' && !loadedBaseUrl) loadModels(false);
});
examModel.addEventListener('change', function () {
  examModel.title = examModel.value;
  showChanged();
});
examLoadModels.addEventListener('click', () => loadModels(true));
examSave.addEventListener('click', async function () {
  if (busy) return;
  const fields = { enabled: examEnabled.checked, mode: examMode.value };
  if (fields.mode === 'ai') {
    try { fields.baseUrl = gateway.normalizeBaseUrl(examEndpoint.value); }
    catch (err) { setStatus(settingErrors[err.message], 'error'); return; }
    if (fields.enabled && (fields.baseUrl !== loadedBaseUrl || !gateway.validModel(examModel.value))) {
      setStatus('请先刷新并选择模型', 'error');
      return;
    }
    fields.model = loadedBaseUrl === fields.baseUrl ? examModel.value : '';
  }
  setBusy(true, 'save');
  setStatus('');
  try {
    const result = await message('settings-set', fields);
    if (!result || !result.settings) throw new Error(result && result.error || 'unavailable');
    savedSettings = result.settings;
    setStatus('已保存', 'success');
  } catch (err) {
    setStatus(settingErrors[err.message] || '保存失败，请重试', 'error');
  } finally { setBusy(false); }
});
message('settings-get').then(function (result) {
  if (!result || !result.settings) throw new Error('unavailable');
  savedSettings = result.settings;
  examEnabled.checked = savedSettings.enabled;
  examMode.value = savedSettings.mode || 'ai';
  magpieSettings.hidden = examMode.value !== 'ai';
  examEndpoint.value = savedSettings.baseUrl;
  setBusy(false);
  if (examMode.value === 'ai') return loadModels(false);
  setStatus('');
}).catch(function () {
  setStatus('设置加载失败，请重载扩展', 'error');
});
