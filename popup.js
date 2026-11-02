'use strict';

const gateway = globalThis.HuayiAIConfig;
const examEnabled = document.getElementById('exam-enabled');
const examMode = document.getElementById('exam-mode');
const aiSettings = document.getElementById('ai-settings');
const sequentialWarning = document.getElementById('sequential-warning');
const examProvider = document.getElementById('exam-provider');
const providerNote = document.getElementById('ai-provider-note');
const examEndpoint = document.getElementById('exam-endpoint');
const endpointField = document.getElementById('magpie-endpoint-field');
const apiKeyField = document.getElementById('api-key-field');
const examApiKey = document.getElementById('exam-api-key');
const examModel = document.getElementById('exam-model');
const examLoadModels = document.getElementById('exam-load-models');
const examSave = document.getElementById('exam-save');
const examStatus = document.getElementById('exam-setting-status');
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
let savedSettings = null, profiles = {}, currentProvider = 'magpie', loadedConnection = null, busy = false;
const settingErrors = {
  'ai-address': '请填写有效的 HTTP(S) Magpie 地址',
  'ai-provider': '请选择 AI 供应商',
  'ai-key': '请填写有效的 API Key，勿填写 Cookie 或请求头',
  'ai-permission': '请点“刷新”授权访问',
  'ai-offline': '无法连接，请检查网络或服务状态',
  'ai-auth': '访问被拒绝，请检查密钥及账号权限',
  'ai-http': '服务异常，请稍后重试',
  'ai-models': '未获取到模型，请检查服务设置后刷新',
  'ai-model-timeout': '连接超时，请重试',
  'ai-quota': '账号额度不足，请检查所选供应商账户',
  'ai-rate-limit': '服务请求受限，请稍后重试'
};
function message(action, fields) {
  return chrome.runtime.sendMessage({ type: 'huayi-exam-v1', action: action, ...fields });
}
function setStatus(text, tone) {
  examStatus.textContent = text;
  examStatus.dataset.tone = tone || '';
}
function settingError(err, fallback) {
  if (err.message === 'ai-permission' && currentProvider === 'deepseek') {
    return '请在 Chrome 扩展设置中允许助手访问 DeepSeek，再刷新模型';
  }
  return settingErrors[err.message] || fallback;
}
function setBusy(value, action) {
  busy = value;
  examEnabled.disabled = examMode.disabled = examSave.disabled = value;
  const ai = examMode.value === 'ai';
  examProvider.disabled = examLoadModels.disabled = value || !ai;
  examEndpoint.disabled = value || !ai || currentProvider !== 'magpie';
  examApiKey.disabled = value || !ai || !gateway.provider(currentProvider).keyRequired;
  examModel.disabled = value || !ai || !loadedConnection;
  examLoadModels.dataset.loading = String(value && action === 'models');
  examSave.textContent = value && action === 'save' ? '保存中…' : '保存设置';
}
function clearModels() {
  loadedConnection = null;
  examModel.replaceChildren(new Option('请刷新模型', ''));
  examModel.title = '';
  examModel.disabled = true;
}
function captureProfile() {
  const profile = profiles[currentProvider];
  if (currentProvider === 'magpie') profile.baseUrl = examEndpoint.value.trim();
  profile.apiKey = examApiKey.value.trim();
  if (examModel.value) profile.model = examModel.value;
  return profile;
}
function updateMode() {
  aiSettings.hidden = examMode.value !== 'ai';
  sequentialWarning.hidden = examMode.value !== 'sequential';
  setBusy(busy);
}
function showProvider() {
  const service = gateway.provider(currentProvider), profile = profiles[currentProvider];
  examProvider.value = currentProvider;
  examEndpoint.value = currentProvider === 'magpie' ? profile.baseUrl : '';
  examEndpoint.placeholder = service.baseUrl;
  endpointField.hidden = currentProvider !== 'magpie';
  examApiKey.value = profile.apiKey;
  apiKeyField.hidden = !service.keyRequired;
  providerNote.textContent = service.note;
  clearModels();
  setBusy(busy);
}
function showChanged() {
  if (!savedSettings) return;
  const draft = captureProfile(), saved = savedSettings.profiles[currentProvider];
  const changed = savedSettings && (examEnabled.checked !== savedSettings.enabled ||
    examMode.value !== savedSettings.mode || (examMode.value === 'ai' &&
      (currentProvider !== savedSettings.provider || (currentProvider === 'magpie' && draft.baseUrl !== saved.baseUrl) ||
        draft.apiKey !== saved.apiKey || draft.model !== saved.model)));
  const warning = examMode.value === 'sequential' && examEnabled.checked;
  setStatus(changed ? warning ? '未保存；开启无 AI 前请阅读提醒' : '未保存' :
    warning ? '无 AI 模式可能停住，请留意提醒' : '', warning ? 'warning' : '');
}
async function loadModels(askPermission) {
  if (busy || examMode.value !== 'ai') return;
  let connection;
  const profile = captureProfile(), preferred = profile.model;
  try {
    connection = gateway.connection(currentProvider, profile);
    if (gateway.provider(currentProvider).keyRequired && !connection.apiKey) throw new Error('ai-key');
  }
  catch (err) { setStatus(settingError(err, '设置无效，请检查后重试'), 'error'); return; }
  setBusy(true, 'models');
  setStatus('连接中…');
  try {
    // DeepSeek access is declared in the manifest; only custom Magpie hosts request it here.
    const permission = { origins: [gateway.permissionOrigin(connection.baseUrl)] };
    const requestAccess = askPermission && currentProvider === 'magpie';
    const granted = await (requestAccess ? chrome.permissions.request(permission) : chrome.permissions.contains(permission));
    if (!granted) throw new Error('ai-permission');
    const result = await message('models-list', { ...connection, refresh: askPermission });
    if (!result || !Array.isArray(result.models) || !result.models.length) throw new Error(result && result.error || 'ai-models');
    if (result.provider !== connection.provider || result.baseUrl !== connection.baseUrl ||
        result.models.some(item => !gateway.validModel(item.id) || typeof item.label !== 'string')) throw new Error('ai-models');
    if (currentProvider === 'magpie') {
      examEndpoint.value = result.baseUrl;
      profile.baseUrl = result.baseUrl;
    }
    loadedConnection = connection;
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
    if (!missingPreferred) profile.model = examModel.value;
    examModel.title = examModel.value;
    if (missingPreferred) setStatus('原模型不可用，请重新选择', 'error');
    else showChanged();
  } catch (err) {
    clearModels();
    setStatus(settingError(err, '加载失败，请重试'), 'error');
  } finally { setBusy(false); }
}
examEndpoint.addEventListener('input', function () {
  captureProfile();
  clearModels();
  setStatus('地址已修改，请刷新模型');
});
examApiKey.addEventListener('input', function () {
  captureProfile();
  clearModels();
  setStatus('密钥已修改，请刷新模型');
});
examEnabled.addEventListener('change', showChanged);
examMode.addEventListener('change', function () {
  updateMode();
  showChanged();
  if (examMode.value === 'ai' && !loadedConnection) loadModels(false);
});
examProvider.addEventListener('change', function () {
  captureProfile();
  currentProvider = examProvider.value;
  showProvider();
  showChanged();
  loadModels(false);
});
examModel.addEventListener('change', function () {
  profiles[currentProvider].model = examModel.value;
  examModel.title = examModel.value;
  showChanged();
});
examLoadModels.addEventListener('click', () => loadModels(true));
examSave.addEventListener('click', async function () {
  if (busy) return;
  const fields = { enabled: examEnabled.checked, mode: examMode.value };
  if (fields.mode === 'ai') {
    let connection;
    try {
      connection = gateway.connection(currentProvider, captureProfile());
      if (fields.enabled && gateway.provider(currentProvider).keyRequired && !connection.apiKey) throw new Error('ai-key');
    }
    catch (err) { setStatus(settingError(err, '设置无效，请检查后重试'), 'error'); return; }
    if (fields.enabled && (!gateway.sameConnection(connection, loadedConnection) || !gateway.validModel(examModel.value))) {
      setStatus('请先刷新并选择模型', 'error');
      return;
    }
    Object.assign(fields, connection);
    if (gateway.sameConnection(connection, loadedConnection) && gateway.validModel(examModel.value)) fields.model = examModel.value;
  }
  setBusy(true, 'save');
  setStatus('');
  try {
    const result = await message('settings-set', fields);
    if (!result || !result.settings) throw new Error(result && result.error || 'unavailable');
    savedSettings = gateway.normalizeSettings(result.settings);
    if (fields.mode === 'ai') profiles[currentProvider] = { ...savedSettings.profiles[currentProvider] };
    const warning = fields.mode === 'sequential' && fields.enabled;
    setStatus(warning ? '已保存；无 AI 模式可能因文字差异停住' : '已保存', warning ? 'warning' : 'success');
  } catch (err) {
    setStatus(settingError(err, '保存失败，请重试'), 'error');
  } finally { setBusy(false); }
});
message('settings-get').then(function (result) {
  if (!result || !result.settings) throw new Error('unavailable');
  savedSettings = gateway.normalizeSettings(result.settings);
  profiles = Object.fromEntries(Object.entries(savedSettings.profiles).map(([id, profile]) => [id, { ...profile }]));
  currentProvider = savedSettings.provider;
  examEnabled.checked = savedSettings.enabled;
  examMode.value = savedSettings.mode;
  showProvider();
  updateMode();
  if (examMode.value === 'ai') return loadModels(false);
  showChanged();
}).catch(function () {
  setStatus('设置加载失败，请重载扩展', 'error');
});
