const byId = id => document.getElementById(id);
const grid = byId('asset-grid');
const filters = byId('filter-fields');
const search = byId('search');
const reset = byId('reset-filters');
const nasDialog = byId('nas-dialog');
const nasAddress = byId('nas-address');
const nasSubmit = byId('nas-submit');
const nasStatus = byId('nas-status');
const folderDialog = byId('folder-dialog');
const detailDialog = byId('detail-dialog');
const detailBody = byId('detail-body');
const feedbackDialog = byId('feedback-dialog');
const feedbackComment = byId('feedback-comment');
const feedbackSave = byId('save-feedback');
const feedbackRemove = byId('remove-feedback');
const folderPath = byId('folder-path');
const folderList = byId('folder-list');
const folderError = byId('folder-error');
const loadPath = byId('load-path');
const recursive = byId('recursive');
const refresh = byId('refresh');
const fieldChoices = new Map();
const pendingUsage = new Set();
const feedbackLabels = { unusable: '不可使用', revision: '修改反馈' };
const patternFieldNames = [
  '素材类型', '图案模式', '有效格数', '网格宽度', '网格高度',
  '颜色数', '制作人', '日期序号', '导出标记',
];
const collator = new Intl.Collator('zh-CN', { numeric: true });
const pageSize = 48;
const storageKey = 'gemcrew-image-directory';
const nasStorageKey = 'gemcrew-nas-address';
let config = {};
let scanRequest;
let browseRequest;
let nasRequest;
let parentFolder;
let toastTimer;
let feedbackEditor;

const state = {
  folder: '',
  requestedPath: '',
  recursive: true,
  images: [],
  loading: true,
  problem: '',
  usageProblem: '',
  feedbackProblem: '',
  skipped: 0,
  page: 0,
};

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', '#icon-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

async function api(route, params, { signal, method = 'GET', body } = {}) {
  const url = new URL('/api/' + route, location.origin);
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
  const headers = { 'X-GemCrew-Console': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { headers, signal, method, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { data });
  return data;
}

function updateSource() {
  const shownPath = state.folder || state.requestedPath;
  const sourcePath = byId('source-path');
  sourcePath.textContent = shownPath || '请选择本机已挂载的目录';
  sourcePath.title = shownPath;
  const scope = byId('source-scope');
  scope.hidden = !state.folder;
  scope.textContent = state.recursive ? '包含子目录' : '仅当前目录';
  refresh.disabled = state.loading || !shownPath;

  const connection = byId('connection');
  connection.dataset.state = state.loading ? 'loading' : state.problem ? 'error' : state.folder ? 'ready' : 'idle';
  byId('connection-label').textContent = {
    loading: '正在读取', error: '读取失败', ready: '目录已连接', idle: '未选择目录',
  }[connection.dataset.state];
}

function showFolderError(message = '') {
  folderError.textContent = message;
  folderError.hidden = !message;
}

async function loadDirectory(folder, includeSubfolders, { fromDialog = false, keepFilters = false } = {}) {
  scanRequest?.controller.abort();
  const controller = new AbortController();
  scanRequest = { controller, fromDialog, usageUpdates: new Map(), feedbackUpdates: new Map() };
  if (!state.folder) {
    state.requestedPath = folder;
    state.recursive = includeSubfolders;
  }
  state.loading = true;
  state.problem = '';
  updateSource();
  renderGallery();
  if (fromDialog) {
    loadPath.disabled = true;
    loadPath.textContent = '正在读取…';
    showFolderError();
  }

  try {
    const data = await api('assets', { path: folder, recursive: includeSubfolders ? '1' : '0' }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    state.folder = data.folder;
    state.requestedPath = data.folder;
    state.images = data.images;
    for (const asset of state.images) {
      asset.used = scanRequest.usageUpdates.get(asset.absolute) ?? asset.used;
      asset.feedback = scanRequest.feedbackUpdates.get(asset.absolute) ?? asset.feedback;
    }
    state.usageProblem = data.usageProblem;
    state.feedbackProblem = data.feedbackProblem;
    state.recursive = includeSubfolders;
    state.skipped = data.skipped;
    state.page = 0;
    if (!keepFilters) {
      search.value = '';
      fieldChoices.clear();
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({ folder: state.folder, recursive: state.recursive }));
    } catch {
      // 浏览器禁用站点存储时，目录选择仍可使用。
    }
    renderFields();
    scanRequest.fromDialog = false;
    if (fromDialog) folderDialog.close();
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error.message === 'Failed to fetch' ? '本地服务暂时无法访问。' : error.message;
      if (fromDialog && state.folder) showFolderError(message);
      else {
        state.problem = message;
        if (fromDialog) showFolderError(message);
      }
    }
  } finally {
    if (scanRequest?.controller === controller) {
      scanRequest = undefined;
      state.loading = false;
      updateSource();
      renderGallery();
    }
    if (fromDialog) {
      loadPath.disabled = false;
      loadPath.textContent = '读取图片';
    }
  }
}

function fieldName(index) {
  return patternFieldNames[index] ?? '附加段 ' + (index + 1);
}

function fieldLabel(value) {
  if (value === null) return '缺少此字段';
  return value === '' ? '空字段' : value;
}

function renderFields() {
  const values = [];
  for (const asset of state.images) {
    asset.fields.forEach((value, index) => (values[index] ??= new Set()).add(value));
  }
  const rows = values.map((options, index) => {
    const row = element('div', 'filter-field');
    const label = element('label', '', fieldName(index));
    const select = element('select', 'filter-select');
    const wrap = element('div', 'select-wrap');
    const orderedOptions = [...options].sort(collator.compare);
    if (state.images.some(asset => asset.fields.length <= index)) orderedOptions.push(null);
    if (fieldChoices.has(index) && !orderedOptions.includes(fieldChoices.get(index))) {
      orderedOptions.push(fieldChoices.get(index));
    }
    label.htmlFor = select.id = 'field-' + (index + 1);
    select.append(new Option('全部', ''));
    orderedOptions.forEach((value, optionIndex) => {
      select.append(new Option(fieldLabel(value), String(optionIndex)));
    });
    select.value = fieldChoices.has(index) ? String(orderedOptions.indexOf(fieldChoices.get(index))) : '';
    select.classList.toggle('is-active', select.value !== '');
    select.addEventListener('change', () => {
      if (select.value === '') fieldChoices.delete(index);
      else fieldChoices.set(index, orderedOptions[Number(select.value)]);
      select.classList.toggle('is-active', select.value !== '');
      state.page = 0;
      renderGallery();
    });
    wrap.append(select, icon('right'));
    row.append(label, wrap);
    return row;
  });
  for (const index of fieldChoices.keys()) {
    if (index >= values.length) fieldChoices.delete(index);
  }
  filters.replaceChildren(...rows);
}

function clearFilters() {
  fieldChoices.clear();
  search.value = '';
  state.page = 0;
  for (const select of filters.querySelectorAll('select')) {
    select.value = '';
    select.classList.remove('is-active');
  }
  renderGallery();
}

function renderActiveFilters() {
  const active = byId('active-filters');
  const chips = [...fieldChoices].sort(([a], [b]) => a - b).map(([index, value]) => {
    const chip = element('button', 'filter-chip');
    chip.type = 'button';
    const name = fieldName(index);
    chip.append(element('span', '', name + ' · ' + fieldLabel(value)), icon('close'));
    chip.setAttribute('aria-label', '移除' + name + '筛选');
    chip.addEventListener('click', () => {
      fieldChoices.delete(index);
      const select = byId('field-' + (index + 1));
      select.value = '';
      select.classList.remove('is-active');
      select.focus();
      state.page = 0;
      renderGallery();
    });
    return chip;
  });
  active.replaceChildren(...chips);
  active.hidden = chips.length === 0;
}

function setEmpty(title, message, actionText, action) {
  const empty = byId('empty-state');
  empty.hidden = !title;
  empty.replaceChildren();
  if (!title) return;
  empty.append(icon('image'), element('h3', '', title), element('p', '', message));
  if (action) {
    const button = element('button', 'button', actionText);
    button.type = 'button';
    button.addEventListener('click', () => action());
    empty.append(button);
  }
}

function renderGallery() {
  const query = search.value.trim().toLowerCase();
  const filtered = fieldChoices.size > 0 || query !== '';
  const activeFields = [...fieldChoices];
  const matches = filtered ? state.images.filter(asset =>
    asset.name.toLowerCase().includes(query) &&
    activeFields.every(([index, value]) => (asset.fields[index] ?? null) === value)
  ) : state.images;

  renderActiveFilters();
  reset.disabled = !filtered;
  search.disabled = state.images.length === 0;
  byId('asset-count').textContent = !state.folder ? '—' : filtered ?
    matches.length + ' / ' + state.images.length + ' 张' : state.images.length + ' 张';

  const warning = byId('scan-warning');
  const scanProblem = state.folder && state.problem ? state.problem :
    state.skipped ? '有 ' + state.skipped + ' 个子目录无法读取。' : '';
  warning.textContent = [scanProblem, state.usageProblem, state.feedbackProblem].filter(Boolean).join(' ');
  warning.hidden = warning.textContent === '';

  const pages = Math.ceil(matches.length / pageSize);
  state.page = Math.min(state.page, Math.max(0, pages - 1));
  byId('pagination').hidden = pages < 2;
  byId('previous').disabled = state.page === 0;
  byId('next').disabled = state.page + 1 >= pages;
  byId('page-number').textContent = (state.page + 1) + ' / ' + pages;
  const visible = matches.slice(state.page * pageSize, (state.page + 1) * pageSize);
  grid.classList.toggle('many-assets', visible.length > 2);
  grid.replaceChildren(...visible.map(renderCard));

  if (visible.length) setEmpty();
  else if (state.loading) setEmpty('正在读取图片', '正在扫描所选目录。');
  else if (!state.folder) setEmpty('请选择素材目录', state.problem || '选择 NAS 已挂载到本机的文件夹。', '选择目录', openFolderDialog);
  else if (filtered) setEmpty('没有匹配的图片', '可以清除筛选条件后重新查找。', '清除筛选', clearFilters);
  else setEmpty('目录中没有图片', '可以选择其他目录，或调整子目录读取范围。', '切换目录', openFolderDialog);
}

function bindPreview(image, fallback, asset, dimensions) {
  image.addEventListener('load', () => {
    const text = (asset.converted ? '预览 ' : '') + image.naturalWidth + ' × ' + image.naturalHeight;
    dimensions.textContent = image.naturalWidth && image.naturalHeight ? text : '';
  });
  image.addEventListener('error', () => {
    image.hidden = true;
    fallback.hidden = false;
  });
  image.src = asset.url;
}

function renderCard(asset) {
  const card = byId('asset-template').content.firstElementChild.cloneNode(true);
  const preview = card.querySelector('.asset-preview');
  preview.setAttribute('aria-label', '预览 ' + asset.name);
  preview.addEventListener('click', () => openDetail(asset));
  card.querySelector('.asset-stage').append(usageButton(asset));
  card.querySelector('.thumbnail-format').textContent = asset.extension.slice(1).toUpperCase();
  const name = card.querySelector('.asset-name');
  name.textContent = asset.name;
  name.dataset.assetPath = asset.absolute;
  name.title = copyBlockedMessage(asset) ? asset.name : asset.absolute;
  name.addEventListener('click', () => openDetail(asset));
  const location = card.querySelector('.asset-location');
  if (asset.relative !== asset.name) {
    location.textContent = asset.relative.slice(0, -asset.name.length - 1);
    location.title = location.textContent;
  }
  const copy = card.querySelector('.copy-button');
  bindCopyButton(copy, asset);
  card.querySelector('.asset-actions').prepend(...feedbackButtons(asset));
  bindPreview(card.querySelector('img'), card.querySelector('.preview-fallback'), asset,
    card.querySelector('.asset-dimensions'));
  return card;
}

function openDetail(asset) {
  const stage = element('div', 'detail-preview checkerboard');
  const image = element('img');
  image.alt = asset.name;
  const fallback = element('span', 'preview-fallback');
  fallback.hidden = true;
  fallback.append(icon('image'), element('span', '', '预览不可用'));
  stage.append(image, fallback);

  const info = element('div', 'detail-info');
  const dimensions = element('div', 'detail-dimensions');
  info.append(element('h3', '', asset.name), dimensions);
  const fields = element('dl', 'detail-fields');
  asset.fields.forEach((value, index) => {
    const field = element('div');
    field.append(element('dt', '', fieldName(index)), element('dd', '', fieldLabel(value)));
    fields.append(field);
  });
  const pathGroup = element('div', 'detail-path');
  const label = element('label', '', '资源路径');
  const pathInput = element('input');
  pathInput.id = label.htmlFor = 'detail-path';
  pathInput.readOnly = true;
  const pathMessage = element('p', 'detail-path-message');
  pathGroup.dataset.assetPath = asset.absolute;
  pathGroup.append(label, pathInput, pathMessage);
  paintDetailPath(pathGroup, asset);

  const button = element('button', 'button copy-button');
  button.type = 'button';
  button.append(icon('copy'), element('span', '', '复制路径'));
  bindCopyButton(button, asset);
  const actions = element('div', 'detail-actions');
  actions.append(button, usageButton(asset), ...feedbackButtons(asset));
  info.append(fields, pathGroup, actions);
  detailBody.replaceChildren(stage, info);
  bindPreview(image, fallback, asset, dimensions);
  detailDialog.showModal();
}

function paintUsageButton(button, asset) {
  const used = Boolean(asset.used);
  button.disabled = pendingUsage.has(asset.absolute) || Boolean(state.usageProblem);
  button.setAttribute('aria-pressed', String(used));
  button.title = used ? '取消已使用标记' : '标记为已使用';
  button.replaceChildren(icon(used ? 'check' : 'bookmark'), element('span', '', used ? '已使用' : '标记为已使用'));
}

function usageButton(asset) {
  const button = element('button', 'button usage-button');
  button.type = 'button';
  button.dataset.assetPath = asset.absolute;
  button.setAttribute('aria-label', '标记为已使用');
  paintUsageButton(button, asset);
  button.addEventListener('click', () => toggleUsage(asset, button));
  return button;
}

function refreshUsageButtons(asset) {
  for (const button of document.querySelectorAll('.usage-button')) {
    if (button.dataset.assetPath === asset.absolute) paintUsageButton(button, asset);
  }
}

async function toggleUsage(asset, button) {
  const absolute = asset.absolute;
  if (pendingUsage.has(absolute) || state.usageProblem) return;
  const current = state.images.find(entry => entry.absolute === absolute) ?? asset;
  pendingUsage.add(absolute);
  refreshUsageButtons(current);
  try {
    const route = 'usage' + current.url.slice('/image'.length);
    const { used } = await api(route, { used: current.used ? '0' : '1' }, { method: 'PUT' });
    asset.used = used;
    current.used = used;
    scanRequest?.usageUpdates.set(absolute, used);
    const visible = state.images.find(entry => entry.absolute === absolute);
    if (visible) visible.used = used;
    showToast(used ? '已标记为已使用' : '已取消使用标记', button);
  } catch (error) {
    showToast(error.message === 'Failed to fetch' ? '保存失败，请检查本地服务是否运行。' : error.message, button);
  } finally {
    pendingUsage.delete(absolute);
    refreshUsageButtons(state.images.find(entry => entry.absolute === absolute) ?? asset);
  }
}

function paintFeedbackButton(button, asset) {
  const type = button.dataset.feedbackType;
  const saved = asset.feedback?.[type] !== undefined;
  const label = feedbackLabels[type];
  button.disabled = !config.feedbackLimits?.[type] || Boolean(state.feedbackProblem);
  button.dataset.saved = String(saved);
  button.setAttribute('aria-label', saved ? '编辑' + label : label);
  const symbol = type === 'unusable' ? 'bookmark' : 'comment';
  button.replaceChildren(icon(saved ? 'check' : symbol), element('span', '', label));
}

function feedbackButtons(asset) {
  return Object.keys(feedbackLabels).map(type => {
    const button = element('button', 'button feedback-button');
    button.type = 'button';
    button.dataset.assetPath = asset.absolute;
    button.dataset.feedbackType = type;
    paintFeedbackButton(button, asset);
    button.addEventListener('click', () => openFeedback(asset, type, button));
    return button;
  });
}

function showFeedbackError(message = '') {
  const error = byId('feedback-error');
  error.textContent = message;
  error.hidden = !message;
}

function updateFeedbackForm() {
  const { limit, saving, type, marked } = feedbackEditor;
  const count = Array.from(feedbackComment.value).length;
  const overLimit = count > limit;
  const counter = byId('feedback-count');
  counter.textContent = count + ' / ' + limit + ' 字';
  counter.dataset.overLimit = String(overLimit);
  feedbackComment.setAttribute('aria-invalid', String(overLimit));
  feedbackComment.disabled = saving;
  feedbackSave.disabled = saving || overLimit;
  const saveLabel = type === 'unusable' ? (marked ? '保存评论' : '标记为不可使用') : '保存反馈';
  feedbackSave.textContent = saving ? '正在保存…' : saveLabel;
  feedbackRemove.disabled = saving;
  for (const button of feedbackDialog.querySelectorAll('[data-close]')) button.disabled = saving;
}

function openFeedback(asset, type, button) {
  const current = state.images.find(entry => entry.absolute === asset.absolute) ?? asset;
  const comment = current.feedback?.[type];
  feedbackEditor = { asset, button, type, marked: comment !== undefined, limit: config.feedbackLimits[type], saving: false };
  byId('feedback-heading').textContent = feedbackLabels[type];
  byId('feedback-asset').textContent = current.name;
  byId('feedback-copy-note').hidden = type !== 'unusable';
  feedbackComment.value = comment ?? '';
  feedbackRemove.hidden = comment === undefined;
  feedbackRemove.textContent = type === 'unusable' ? '取消不可使用标记' : '移除反馈';
  showFeedbackError();
  updateFeedbackForm();
  feedbackDialog.showModal();
}

async function submitFeedback(comment) {
  const editor = feedbackEditor;
  if (!editor || editor.saving || (comment !== null && Array.from(comment).length > editor.limit)) return;
  const { asset, button, type } = editor;
  const current = state.images.find(entry => entry.absolute === asset.absolute) ?? asset;
  editor.saving = true;
  showFeedbackError();
  updateFeedbackForm();
  try {
    const route = 'feedback' + current.url.slice('/image'.length);
    const { feedback } = await api(route, undefined, { method: 'PUT', body: { type, comment } });
    applyAssetFeedback(asset, feedback);
    feedbackDialog.close();
    const message = type === 'unusable'
      ? (comment === null ? '已取消不可使用标记' : (editor.marked ? '已保存评论' : '已标记为不可使用'))
      : (comment === null ? '已移除反馈' : '已保存反馈');
    showToast(message, button);
  } catch (error) {
    showFeedbackError(error.message);
  } finally {
    if (feedbackEditor === editor) {
      editor.saving = false;
      updateFeedbackForm();
    }
  }
}

function copyBlockedMessage(asset) {
  if (asset.feedback?.unusable !== undefined) return '已标记为不可使用，无法复制路径。';
  return state.feedbackProblem ? '反馈状态暂时无法读取，无法复制路径。' : '';
}

function paintCopyButton(button, asset) {
  const blocked = copyBlockedMessage(asset);
  button.disabled = Boolean(blocked);
  button.dataset.blocked = String(Boolean(blocked));
  button.title = blocked || asset.absolute;
  if (blocked && button.classList.contains('is-copied')) {
    button.classList.remove('is-copied');
    button.replaceChildren(icon('copy'), element('span', '', '复制路径'));
  }
}

function bindCopyButton(button, asset) {
  button.dataset.assetPath = asset.absolute;
  paintCopyButton(button, asset);
  button.addEventListener('click', () => copyPath(asset, button));
}

function paintDetailPath(group, asset) {
  const blocked = copyBlockedMessage(asset);
  const input = group.querySelector('input');
  const message = group.querySelector('.detail-path-message');
  input.value = input.title = blocked ? '' : asset.absolute;
  input.hidden = Boolean(blocked);
  message.textContent = blocked;
  message.hidden = !blocked;
}

function applyAssetFeedback(asset, feedback) {
  const absolute = asset.absolute;
  asset.feedback = feedback;
  scanRequest?.feedbackUpdates.set(absolute, feedback);
  const visible = state.images.find(entry => entry.absolute === absolute);
  if (visible) visible.feedback = feedback;
  for (const button of document.querySelectorAll('.feedback-button, .copy-button, .asset-name')) {
    if (button.dataset.assetPath !== absolute) continue;
    if (button.classList.contains('feedback-button')) paintFeedbackButton(button, asset);
    else if (button.classList.contains('copy-button')) paintCopyButton(button, asset);
    else button.title = copyBlockedMessage(asset) ? asset.name : absolute;
  }
  const pathGroup = detailBody.querySelector('.detail-path');
  if (pathGroup?.dataset.assetPath === absolute) paintDetailPath(pathGroup, asset);
}

async function copyPath(asset, button) {
  let path;
  try {
    const current = state.images.find(entry => entry.absolute === asset.absolute) ?? asset;
    if (copyBlockedMessage(current)) return;
    const route = 'copy' + current.url.slice('/image'.length);
    ({ path } = await api(route));
    const latest = state.images.find(entry => entry.absolute === asset.absolute) ?? asset;
    if (copyBlockedMessage(latest)) return;
  } catch (error) {
    if (error.data?.feedback) applyAssetFeedback(asset, error.data.feedback);
    showToast(error.message === 'Failed to fetch' ? '复制失败，请检查素材库连接。' : error.message, button);
    return;
  }
  try {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      const input = element('textarea', 'clipboard-input');
      input.value = path;
      input.readOnly = true;
      (button.closest('dialog') ?? document.body).append(input);
      let copied;
      try {
        input.select();
        copied = document.execCommand('copy');
      } finally {
        input.remove();
        button.focus();
      }
      if (!copied) throw new Error('剪贴板不可用');
    }
    button.classList.add('is-copied');
    button.replaceChildren(icon('check'), element('span', '', '已复制'));
    setTimeout(() => {
      button.classList.remove('is-copied');
      button.replaceChildren(icon('copy'), element('span', '', '复制路径'));
    }, 1600);
    showToast('已复制资源路径', button);
  } catch {
    showToast('无法访问剪贴板，可在图片详情中选中路径手动复制。', button);
  }
}

function showToast(message, button) {
  const toast = byId('toast');
  (button.closest('dialog') ?? document.body).append(toast);
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
}

async function browseFolder(path, { preserveInput = false } = {}) {
  browseRequest?.abort();
  const controller = new AbortController();
  browseRequest = controller;
  const originalInput = folderPath.value;
  showFolderError();
  byId('parent').disabled = true;
  folderList.replaceChildren(element('p', '', '正在读取子目录…'));
  try {
    const data = await api('folders', { path }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!preserveInput && folderPath.value === originalInput) folderPath.value = data.folder;
    parentFolder = data.parent;
    byId('parent').disabled = parentFolder === data.folder;
    const rows = data.folders.map(folder => {
      const button = element('button', 'folder-row');
      button.type = 'button';
      button.append(icon('folder'), element('span', '', folder.name), icon('right'));
      button.addEventListener('click', () => browseFolder(folder.path));
      return button;
    });
    if (!rows.length) rows.push(element('p', '', '当前目录没有子文件夹'));
    folderList.replaceChildren(...rows);
  } catch (error) {
    if (!controller.signal.aborted) {
      folderList.replaceChildren();
      showFolderError(error.message);
    }
  }
}

function openFolderDialog(
  startFolder = state.folder || config.volumesFolder || '/',
  selectedFolder = state.folder || state.requestedPath || startFolder,
) {
  folderPath.value = selectedFolder;
  recursive.checked = state.recursive;
  folderDialog.showModal();
  browseFolder(startFolder, { preserveInput: startFolder !== selectedFolder });
}

function showNasStatus(message = '', isError = false) {
  nasStatus.textContent = message;
  nasStatus.dataset.error = String(isError);
  nasStatus.hidden = !message;
}

function openNasDialog() {
  try {
    if (!nasAddress.value) nasAddress.value = localStorage.getItem(nasStorageKey) ?? '';
  } catch {
    // 禁用浏览器存储时仍可输入共享地址。
  }
  showNasStatus();
  nasDialog.showModal();
  nasAddress.focus();
}

async function connectNas() {
  const controller = new AbortController();
  const { signal } = controller;
  nasRequest = controller;
  nasAddress.disabled = nasSubmit.disabled = true;
  nasSubmit.textContent = '连接中…';
  showNasStatus(config.linuxNasMountPoint ? '正在连接系统配置的 SMB 共享…' : '正在检查 SMB 挂载状态…');

  try {
    const params = config.linuxNasMountPoint ? undefined : { address: nasAddress.value };
    let data = await api('nas', params, { method: 'POST', signal });
    if (signal.aborted) return;
    if (!data.folder) {
      showNasStatus('请在 Finder 中完成连接。检测到挂载后会自动打开目录选择。');
      const address = data.address;
      const deadline = Date.now() + 90000;
      while (!data.folder && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (signal.aborted) return;
        data = await api('nas', { address }, { signal });
      }
    }
    if (signal.aborted) return;
    if (!data.folder) {
      showNasStatus('暂未检测到挂载。请检查 Finder 中的连接结果，或浏览挂载卷。', true);
      return;
    }

    if (data.address) {
      nasAddress.value = data.address;
      try {
        localStorage.setItem(nasStorageKey, data.address);
      } catch {
        // 已挂载的共享仍可继续使用。
      }
    }
    const preferredFolders = [state.folder || state.requestedPath, config.suggestedFolder];
    const start = preferredFolders.find(folder =>
      folder === data.folder || folder?.startsWith(data.folder + '/')) || data.folder;
    nasDialog.close();
    openFolderDialog(start, start);
  } catch (error) {
    if (!signal.aborted) showNasStatus(error.message, true);
  } finally {
    if (nasRequest === controller) {
      nasRequest = undefined;
      nasAddress.disabled = nasSubmit.disabled = false;
      nasSubmit.textContent = '连接';
    }
  }
}

byId('connect-nas').addEventListener('click', openNasDialog);
byId('nas-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!nasRequest) connectNas();
});
byId('browse-mounts').addEventListener('click', () => {
  nasDialog.close();
  const volumes = config.volumesFolder || '/';
  openFolderDialog(volumes, volumes);
});
nasDialog.addEventListener('close', () => nasRequest?.abort());
byId('choose-folder').addEventListener('click', () => openFolderDialog());
refresh.addEventListener('click', () => loadDirectory(state.folder || state.requestedPath,
  state.recursive, { keepFilters: true }));
reset.addEventListener('click', clearFilters);
search.addEventListener('input', () => { state.page = 0; renderGallery(); });
byId('previous').addEventListener('click', () => { state.page--; renderGallery(); });
byId('next').addEventListener('click', () => { state.page++; renderGallery(); });
byId('parent').addEventListener('click', () => browseFolder(parentFolder));
byId('volumes').addEventListener('click', () => browseFolder(config.volumesFolder || '/'));
byId('browse-path').addEventListener('click', () => browseFolder(folderPath.value));
byId('folder-form').addEventListener('submit', event => {
  event.preventDefault();
  browseRequest?.abort();
  loadDirectory(folderPath.value, recursive.checked, { fromDialog: true });
});
document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
folderDialog.addEventListener('close', () => {
  browseRequest?.abort();
  if (scanRequest?.fromDialog) scanRequest.controller.abort();
});
detailDialog.addEventListener('close', () => detailBody.replaceChildren());
feedbackComment.addEventListener('input', () => {
  showFeedbackError();
  updateFeedbackForm();
});
byId('feedback-form').addEventListener('submit', event => {
  event.preventDefault();
  submitFeedback(feedbackComment.value);
});
feedbackRemove.addEventListener('click', () => submitFeedback(null));
feedbackDialog.addEventListener('cancel', event => {
  if (feedbackEditor?.saving) event.preventDefault();
});
feedbackDialog.addEventListener('close', () => { feedbackEditor = undefined; });

async function initialize() {
  renderGallery();
  try {
    config = await api('config');
    byId('connect-nas').hidden = !config.canConnectNas;
    if (config.linuxNasMountPoint) {
      nasAddress.value = config.linuxNasMountPoint;
      nasAddress.readOnly = true;
      nasAddress.removeAttribute('placeholder');
      byId('nas-address-label').textContent = '系统挂载路径';
      byId('nas-help').textContent = '共享地址和登录凭据由 Linux 主机配置。点击连接后开始挂载。';
    }
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey));
    } catch {
      // 初次启动或站点存储不可用时使用默认目录。
    }
    state.recursive = saved?.recursive !== false;
    await loadDirectory(saved?.folder || config.suggestedFolder, state.recursive);
  } catch {
    state.loading = false;
    state.problem = '本地服务暂时无法访问。';
    updateSource();
    renderGallery();
  }
}

initialize();
