const state = {
  config: null,
  db: {},
  activeTab: '',
  batchKey: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
  } catch (error) {
    const wrapped = new Error('网络连接不可用');
    wrapped.network = true;
    throw wrapped;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || '请求失败');
    error.status = res.status;
    error.conflict = Boolean(body.conflict);
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}

// 当前处置人：每次提交和状态变化都会随请求留痕
function operator() {
  return ($('#operatorInput')?.value || '').trim() || '系统';
}

function getTerminalId() {
  let id = localStorage.getItem('terminalId');
  if (!id) {
    id = `term-${Math.random().toString(16).slice(2, 10)}`;
    localStorage.setItem('terminalId', id);
  }
  return id;
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.by ? `${entry.by} · ` : '')}${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

// ---- 巡测批次 ----

function todayLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function newBatchKey() {
  return `bk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function batchRoutes() {
  return [...new Set((state.db.sites || []).map((site) => site.route).filter(Boolean))];
}

function renderBatchesView(view) {
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" id="batchForm">
        <h2>${escapeHtml(view.formTitle || '按路线录入批次')}</h2>
        <div class="form-grid">
          <label>巡测路线<select id="batchRoute" required>${batchRoutes().map((route) => `<option>${escapeHtml(route)}</option>`).join('')}</select></label>
          <label>班次日期<input id="batchDate" type="date" required value="${todayLocal()}"></label>
          <label class="wide">巡测人员<input id="batchSurveyor" required placeholder="当班巡测人员"></label>
        </div>
        <div id="batchReadings"></div>
        <div class="actions">
          <button type="button" class="ghost" id="saveDraftBtn">暂存草稿</button>
          <button type="submit" id="submitBatchBtn">提交批次</button>
        </div>
        <p class="meta">断网时提交会自动保留本地草稿，恢复连接后可补交；同一批次重复提交不会生成重复记录，两个终端补交同一批次只保留一份。</p>
      </form>
      <div class="panel">
        <h2>批次列表</h2>
        <div id="localPending"></div>
        <div class="list" id="batchList"></div>
      </div>
    </div>
  </section>`;
}

function renderReadingRows() {
  const box = $('#batchReadings');
  if (!box) return;
  const route = $('#batchRoute').value;
  const sites = (state.db.sites || []).filter((site) => site.route === route);
  if (!sites.length) {
    box.innerHTML = '<div class="empty">该路线下没有样点</div>';
    return;
  }
  box.innerHTML = sites.map((site) => `
    <div class="reading-row" data-site="${site.id}">
      <div class="reading-site">
        <strong>${escapeHtml(site.pointCode)}</strong> ${escapeHtml(site.zone)}
        <span>基准 ${escapeHtml(site.baselineTemp)}℃ / ${escapeHtml(site.baselineHumidity)}% / ${escapeHtml(site.baselineCo2)}ppm</span>
      </div>
      <div class="reading-inputs">
        <input name="temperature" type="number" step="0.1" placeholder="温度℃">
        <input name="humidity" type="number" step="0.1" placeholder="湿度%">
        <input name="co2" type="number" step="1" placeholder="CO2">
        <input name="dripRate" type="number" step="0.1" placeholder="滴水/分">
        <input name="disturbance" class="wide" placeholder="干扰痕迹（有则填写，越基准且有痕迹将自动待复核）">
      </div>
    </div>
  `).join('');
}

function collectReadings() {
  const readings = [];
  for (const row of $$('#batchReadings .reading-row')) {
    const val = (name) => $(`input[name="${name}"]`, row).value.trim();
    const nums = ['temperature', 'humidity', 'co2', 'dripRate'].map(val);
    const disturbance = val('disturbance');
    if (nums.every((v) => v === '') && !disturbance) continue;
    readings.push({
      siteId: row.dataset.site,
      temperature: nums[0],
      humidity: nums[1],
      co2: nums[2],
      dripRate: nums[3],
      disturbance
    });
  }
  return readings;
}

function batchPayload() {
  return {
    batchKey: state.batchKey,
    terminalId: getTerminalId(),
    route: $('#batchRoute').value,
    shiftDate: $('#batchDate').value,
    surveyor: $('#batchSurveyor').value.trim(),
    by: operator(),
    readings: collectReadings()
  };
}

// 本地待补交草稿：断网时留下，恢复连接后补交
function pendingStore() {
  try {
    return JSON.parse(localStorage.getItem('pendingBatches') || '{}');
  } catch {
    return {};
  }
}

function storePending(payload) {
  const store = pendingStore();
  store[payload.batchKey] = payload;
  localStorage.setItem('pendingBatches', JSON.stringify(store));
}

function removePending(batchKey) {
  const store = pendingStore();
  delete store[batchKey];
  localStorage.setItem('pendingBatches', JSON.stringify(store));
}

function renderLocalPending() {
  const el = $('#localPending');
  if (!el) return;
  const items = Object.values(pendingStore());
  el.innerHTML = items.length
    ? `<div class="pending-strip"><strong>本地待补交 ${items.length} 个批次</strong>${items.map((p) => `<button class="ghost" data-pending-submit="${escapeHtml(p.batchKey)}">补交 ${escapeHtml(p.route)} · ${escapeHtml(p.shiftDate)}</button>`).join('')}</div>`
    : '';
}

function resetBatchForm() {
  state.batchKey = newBatchKey();
  const form = $('#batchForm');
  if (!form) return;
  form.reset();
  $('#batchDate').value = todayLocal();
  $('#batchSurveyor').value = operator() === '系统' ? '' : operator();
  renderReadingRows();
}

async function submitPayload(payload, { keepForm = false } = {}) {
  try {
    const result = await api('/api/batches/submit', { method: 'POST', body: JSON.stringify(payload) });
    removePending(payload.batchKey);
    if (result.deduplicated) toast('该批次已提交过，未生成重复记录');
    else if (result.status === '待复核') toast('批次已提交，部分读数自动进入待复核');
    else toast('批次已提交');
    if (!keepForm) resetBatchForm();
    await load();
    return true;
  } catch (error) {
    if (error.conflict) {
      removePending(payload.batchKey);
      toast(error.message);
      await load();
    } else if (error.network) {
      storePending(payload);
      toast('连接不可用，已保存本地草稿，恢复连接后可补交');
      renderLocalPending();
    } else {
      toast(error.message);
    }
    return false;
  }
}

async function saveBatchDraft() {
  const form = $('#batchForm');
  if (!form.reportValidity()) return;
  const payload = batchPayload();
  try {
    await api(`/api/batches/draft/${encodeURIComponent(payload.batchKey)}`, { method: 'PUT', body: JSON.stringify(payload) });
    toast('草稿已暂存，恢复连接后可补交');
    await load();
  } catch (error) {
    if (error.conflict) toast(error.message);
    else if (error.network) {
      storePending(payload);
      toast('连接不可用，草稿已保存在本地，恢复连接后可补交');
      renderLocalPending();
    } else toast(error.message);
  }
}

function batchCard(batch) {
  const readings = batch.readings || [];
  const flagged = readings.filter((reading) => reading.flagged).length;
  const actions = [];
  if (batch.status === '草稿') {
    actions.push(`<button class="ghost" data-batch-submit="${escapeHtml(batch.batchKey)}">提交</button>`);
  }
  if (batch.status === '已提交' || batch.status === '待复核') {
    actions.push(`<button data-action="batch-complete" data-id="${batch.id}">完成批次</button>`);
  }
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(batch.route)} · ${escapeHtml(batch.shiftDate)}</h3>${pill(batch.status, toneFor(batch.status))}</div>
    <div class="meta">巡测人员 ${escapeHtml(batch.surveyor || '-')} · 样点 ${readings.length} 个${flagged ? ` · 待复核 ${flagged} 条` : ''}</div>
    <div class="meta">批次号 ${escapeHtml(batch.batchKey)}${batch.terminalId ? ` · 终端 ${escapeHtml(batch.terminalId)}` : ''}</div>
    ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    ${historyHtml(batch)}
  </article>`;
}

function renderBatchList() {
  const list = $('#batchList');
  if (!list) return;
  const batches = state.db.batches || [];
  list.innerHTML = batches.length ? batches.map(batchCard).join('') : '<div class="empty">暂无巡测批次</div>';
  renderLocalPending();
}

function initBatchView() {
  const form = $('#batchForm');
  if (!form) return;
  if (!state.batchKey) state.batchKey = newBatchKey();
  if (!$('#batchSurveyor').value && operator() !== '系统') $('#batchSurveyor').value = operator();
  renderReadingRows();
  $('#batchRoute').addEventListener('change', renderReadingRows);
  $('#saveDraftBtn').addEventListener('click', saveBatchDraft);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = batchPayload();
    if (!payload.readings.length) return toast('请至少填写一个样点的读数');
    await submitPayload(payload);
  });
  renderBatchList();
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'batches') return renderBatchesView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
  initBatchView();
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const batchSubmit = event.target.closest('[data-batch-submit]');
  const pendingSubmit = event.target.closest('[data-pending-submit]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    const label = action.textContent.trim();
    const note = window.prompt(`「${label}」处置原因（可留空）`, '');
    if (note === null) return;
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, {
        method: 'POST',
        body: JSON.stringify({ by: operator(), note })
      });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (batchSubmit) {
    const draft = (state.db.batches || []).find((entry) => entry.batchKey === batchSubmit.dataset.batchSubmit);
    if (!draft) return toast('草稿不存在');
    await submitPayload({
      batchKey: draft.batchKey,
      terminalId: draft.terminalId || getTerminalId(),
      route: draft.route,
      shiftDate: draft.shiftDate,
      surveyor: draft.surveyor,
      by: operator(),
      readings: draft.readings || []
    });
  }
  if (pendingSubmit) {
    const payload = pendingStore()[pendingSubmit.dataset.pendingSubmit];
    if (!payload) return toast('本地草稿不存在');
    payload.by = operator();
    await submitPayload(payload, { keepForm: true });
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const payload = values(form, view);
  payload.by = operator();
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
  form.reset();
  await load();
  toast('已保存');
});

window.addEventListener('online', async () => {
  const pending = Object.values(pendingStore());
  if (!pending.length) return;
  toast(`连接已恢复，正在补交 ${pending.length} 个本地批次`);
  for (const payload of pending) {
    payload.by = operator();
    await submitPayload(payload, { keepForm: true });
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  const operatorInput = $('#operatorInput');
  operatorInput.value = localStorage.getItem('operator') || '';
  operatorInput.addEventListener('input', () => localStorage.setItem('operator', operatorInput.value.trim()));
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
