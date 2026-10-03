'use strict';

// ============ 通用工具 ============
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v; // textContent，天然防 XSS
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* ignore */ }
  return { ok: resp.ok, status: resp.status, data };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const newId = (p) => p + '_' + Math.random().toString(36).slice(2, 8);

// ============ 标签页 ============
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  const name = t.dataset.tab;
  $('#tab-trainer').classList.toggle('active', name === 'trainer');
  $('#tab-student').classList.toggle('active', name === 'student');
  if (name === 'student') loadStudentScenarios();
}));

// ============ 培训师：状态 ============
const T = { scenarios: [], currentId: null, model: null, meta: null };

async function loadScenarios() {
  const { data } = await api('GET', '/api/scenarios');
  T.scenarios = data.scenarios;
  const box = $('#scenario-items');
  box.innerHTML = '';
  for (const s of T.scenarios) {
    box.appendChild(el('div', {
      class: 'scenario-item' + (s.id === T.currentId ? ' active' : ''),
      onclick: () => selectScenario(s.id)
    }, [
      el('div', { class: 't', text: s.title }),
      el('div', { class: 'm', text: `最新版本：${s.latest_version ? 'v' + s.latest_version : '未发布'} · 更新于 ${new Date(s.updated_at).toLocaleString()}` })
    ]));
  }
  if (T.scenarios.length && !T.currentId) selectScenario(T.scenarios[0].id);
}

async function selectScenario(id) {
  T.currentId = id;
  const { data } = await api('GET', '/api/scenarios/' + id);
  T.model = data.draft;
  T.meta = { versions: data.versions, updatedAt: data.updatedAt };
  $('#editor-empty').hidden = true;
  $('#editor-body').hidden = false;
  hideReport();
  renderEditor();
  loadScenarios();
}

$('#btn-new-scenario').addEventListener('click', async () => {
  const draft = {
    title: '未命名情境',
    states: [
      { id: 'flag_a', label: '现场状态 A', initial: false }
    ],
    start: 'start',
    nodes: [
      { id: 'start', title: '起点', text: '事故发生，描述初始情境……', isEnd: false, options: [] },
      { id: 'end_ok', title: '结局：处置成功', text: '处置成功。', isEnd: true, options: [] }
    ]
  };
  const r = await api('POST', '/api/scenarios', { draft });
  if (!r.ok) { showReport(r.data, true); return; }
  await loadScenarios();
  selectScenario(r.data.id);
});

function renderEditor() {
  const m = T.model;
  $('#sc-title').value = m.title;
  renderStates();
  renderStartSelect();
  renderNodes();
  renderVersions();
}

$('#sc-title').addEventListener('input', (e) => { T.model.title = e.target.value; });

function renderStates() {
  const tb = $('#states-tbody');
  tb.innerHTML = '';
  T.model.states.forEach((s, i) => {
    const idInput = el('input', {
      class: 'input', type: 'text', value: s.id,
      onchange: (e) => renameState(i, e.target.value, () => (e.target.value = s.id))
    });
    const labelInput = el('input', {
      class: 'input', type: 'text', value: s.label,
      oninput: (e) => { s.label = e.target.value; }
    });
    const initSel = el('select', {
      class: 'input',
      onchange: (e) => { s.initial = e.target.value === 'true'; }
    }, [
      el('option', { value: 'false', text: 'false（初始关）' }),
      el('option', { value: 'true', text: 'true（初始开）' })
    ]);
    initSel.value = String(!!s.initial);
    const del = el('button', {
      class: 'btn small danger', text: '删除',
      onclick: () => { deleteState(i); }
    });
    tb.appendChild(el('tr', {}, [
      el('td', {}, [idInput]), el('td', {}, [labelInput]),
      el('td', {}, [initSel]), el('td', {}, [del])
    ]));
  });
}

function renameState(i, newId, revert) {
  const old = T.model.states[i].id;
  newId = newId.trim();
  if (!newId || newId === old) { revert(); return; }
  if (T.model.states.some((x, j) => j !== i && x.id === newId)) { alert('状态 ID 已存在'); revert(); return; }
  T.model.states[i].id = newId;
  for (const n of T.model.nodes) for (const o of n.options) {
    for (const c of o.requires.concat(o.sets)) if (c.state === old) c.state = newId;
  }
}

function deleteState(i) {
  const id = T.model.states[i].id;
  if (!confirm(`确定删除状态「${T.model.states[i].label}」？相关条件会一并移除。`)) return;
  T.model.states.splice(i, 1);
  for (const n of T.model.nodes) for (const o of n.options) {
    o.requires = o.requires.filter((c) => c.state !== id);
    o.sets = o.sets.filter((c) => c.state !== id);
  }
  renderEditor();
}

$('#btn-add-state').addEventListener('click', () => {
  if (T.model.states.length >= 8) { alert('至多 8 个布尔状态'); return; }
  T.model.states.push({ id: newId('flag'), label: '新状态', initial: false });
  renderStates();
  renderNodes();
});

function renderStartSelect() {
  const sel = $('#start-select');
  sel.innerHTML = '';
  for (const n of T.model.nodes) sel.appendChild(el('option', { value: n.id, text: `${n.title}（${n.id}）` }));
  sel.value = T.model.start || '';
}
$('#start-select').addEventListener('change', (e) => { T.model.start = e.target.value; renderNodes(); });

function renderNodes() {
  const box = $('#nodes-box');
  box.innerHTML = '';
  T.model.nodes.forEach((n, ni) => box.appendChild(renderNodeCard(n, ni)));
}

function renderNodeCard(n, ni) {
  const tags = [];
  if (n.id === T.model.start) tags.push(el('span', { class: 'tag start', text: '起点' }));
  if (n.isEnd) tags.push(el('span', { class: 'tag end', text: '结局' }));

  const head = el('div', { class: 'node-head' }, [
    el('input', {
      class: 'input id', type: 'text', value: n.id,
      onchange: (e) => renameNode(ni, e.target.value, () => (e.target.value = n.id))
    }),
    el('input', {
      class: 'input title', type: 'text', value: n.title, placeholder: '节点标题',
      oninput: (e) => { n.title = e.target.value; renderStartSelect(); }
    }),
    el('label', { class: 'row gap', style: 'font-size:13px' }, [
      el('input', {
        type: 'checkbox',
        onchange: (e) => { n.isEnd = e.target.checked; renderNodes(); }
      }),
      el('span', { text: '结局节点' })
    ]),
    ...tags,
    el('button', {
      class: 'btn small danger', text: '删除节点', style: 'margin-left:auto',
      onclick: () => deleteNode(ni)
    })
  ]);
  head.querySelector('input[type=checkbox]').checked = !!n.isEnd;

  const body = el('div', { class: 'node-body' }, [
    el('textarea', {
      class: 'input', placeholder: '展示给学员的情境描述……',
      oninput: (e) => { n.text = e.target.value; }
    }),
  ]);
  body.querySelector('textarea').value = n.text || '';

  if (!n.isEnd) {
    n.options.forEach((o, oi) => body.appendChild(renderOption(n, ni, o, oi)));
    body.appendChild(el('button', {
      class: 'btn small', text: '＋ 添加选项',
      onclick: () => { n.options.push({ id: newId('opt'), text: '新选项', requires: [], sets: [], next: T.model.nodes[0]?.id || '' }); renderNodes(); }
    }));
  }

  return el('div', { class: 'node-card' + (n.id === T.model.start ? ' start-node' : '') + (n.isEnd ? ' end-node' : '') }, [head, body]);
}

function renameNode(ni, newId, revert) {
  const old = T.model.nodes[ni].id;
  newId = newId.trim();
  if (!newId || newId === old) { revert(); return; }
  if (T.model.nodes.some((x, j) => j !== ni && x.id === newId)) { alert('节点 ID 已存在'); revert(); return; }
  T.model.nodes[ni].id = newId;
  if (T.model.start === old) T.model.start = newId;
  for (const x of T.model.nodes) for (const o of x.options) if (o.next === old) o.next = newId;
  renderStartSelect();
}

function deleteNode(ni) {
  const n = T.model.nodes[ni];
  if (!confirm(`确定删除节点「${n.title}」？指向它的选项会被一并删除。`)) return;
  T.model.nodes.splice(ni, 1);
  for (const x of T.model.nodes) x.options = x.options.filter((o) => o.next !== n.id);
  if (T.model.start === n.id) T.model.start = T.model.nodes[0]?.id || null;
  renderEditor();
}

function stateSelect(value, onchange) {
  const sel = el('select', { class: 'input', onchange: (e) => onchange(e.target.value) });
  if (!T.model.states.some((s) => s.id === value)) {
    sel.appendChild(el('option', { value: '', text: '（选择状态）' }));
  }
  T.model.states.forEach((s) => sel.appendChild(el('option', { value: s.id, text: `${s.label}（${s.id}）` })));
  sel.value = T.model.states.some((s) => s.id === value) ? value : '';
  return sel;
}

function boolSelect(value, onchange) {
  const sel = el('select', { class: 'input', onchange: (e) => onchange(e.target.value === 'true') });
  sel.appendChild(el('option', { value: 'true', text: 'true' }));
  sel.appendChild(el('option', { value: 'false', text: 'false' }));
  sel.value = String(!!value);
  return sel;
}

function renderClauses(n, o, kind /* 'requires' | 'sets' */) {
  const wrap = el('div', { class: 'opt-row' }, [
    el('span', { class: 'opt-label', text: kind === 'requires' ? '生效条件' : '状态变更' })
  ]);
  if (o[kind].length === 0) wrap.appendChild(el('span', { class: 'muted', style: 'font-size:12px', text: '（无）' }));
  o[kind].forEach((c, ci) => {
    const chip = el('span', { class: 'clause' }, [
      stateSelect(c.state, (v) => { c.state = v; }),
      kind === 'requires' ? el('span', { text: '必须 =' }) : el('span', { text: '设为' }),
      boolSelect(c.value, (v) => { c.value = v; }),
      el('button', {
        class: 'btn small', text: '×', title: '删除',
        onclick: () => { o[kind].splice(ci, 1); renderNodes(); }
      })
    ]);
    wrap.appendChild(chip);
  });
  wrap.appendChild(el('button', {
    class: 'btn small', text: '＋',
    onclick: () => {
      if (!T.model.states.length) { alert('请先定义至少一个状态'); return; }
      o[kind].push({ state: T.model.states[0].id, value: false });
      renderNodes();
    }
  }));
  return wrap;
}

function renderOption(n, ni, o, oi) {
  const head = el('div', { class: 'option-head' }, [
    el('input', {
      class: 'input id', type: 'text', value: o.id,
      onchange: (e) => {
        const v = e.target.value.trim();
        if (!v) { e.target.value = o.id; return; }
        if (n.options.some((x, j) => j !== oi && x.id === v)) { alert('选项 ID 已存在'); e.target.value = o.id; return; }
        o.id = v;
      }
    }),
    el('input', {
      class: 'input text', type: 'text', value: o.text, placeholder: '学员看到的选项文案',
      oninput: (e) => { o.text = e.target.value; }
    })
  ]);

  const nextRow = el('div', { class: 'opt-row' }, [
    el('span', { class: 'opt-label', text: '跳转目标' }),
    (() => {
      const sel = el('select', { class: 'input', onchange: (e) => { o.next = e.target.value; } });
      sel.appendChild(el('option', { value: '', text: '（请选择）' }));
      T.model.nodes.forEach((x) => sel.appendChild(el('option', { value: x.id, text: `${x.title}（${x.id}）` })));
      sel.value = T.model.nodes.some((x) => x.id === o.next) ? o.next : '';
      return sel;
    })(),
    el('button', {
      class: 'btn small danger', style: 'margin-left:auto', text: '删除选项',
      onclick: () => { n.options.splice(oi, 1); renderNodes(); }
    })
  ]);

  return el('div', { class: 'option-card' }, [head, nextRow, renderClauses(n, o, 'requires'), renderClauses(n, o, 'sets')]);
}

$('#btn-add-node').addEventListener('click', () => {
  let id = newId('node');
  while (T.model.nodes.some((n) => n.id === id)) id = newId('node');
  T.model.nodes.push({ id, title: '新节点', text: '', isEnd: false, options: [] });
  renderEditor();
});

// ============ 报告区 ============
function hideReport() { const r = $('#report-box'); r.hidden = true; r.className = 'report'; r.innerHTML = ''; }

function showValidationReport(payload, isError) {
  const r = $('#report-box');
  r.hidden = false;
  r.innerHTML = '';
  const errors = payload.errors || [];
  const warnings = payload.warnings || [];
  r.className = 'report ' + (isError || errors.length ? 'err' : warnings.length ? 'warn' : 'ok');

  if (isError && payload.message) r.appendChild(el('div', { text: payload.message, style: 'font-weight:700' }));

  if (errors.length) {
    r.appendChild(el('div', { class: 'sec-title', text: `❌ ${errors.length} 个阻断问题（按以下路径可复现）：` }));
    r.appendChild(el('ul', {}, errors.map((x) => el('li', { text: x, style: 'margin-bottom:8px;white-space:pre-wrap' }))));
  }
  if (warnings.length) {
    r.appendChild(el('div', { class: 'sec-title', text: `⚠️ ${warnings.length} 条警告（不阻断保存/发布）：` }));
    r.appendChild(el('ul', {}, warnings.map((x) => el('li', { text: x }))));
  }
  if (!errors.length && payload.passed) {
    const s = payload.stats;
    const stat = s ? ` 可达配置 ${s.reachableConfigs}/${s.totalConfigs}，可达节点 ${s.reachableNodes}/${s.totalNodes}，结局可达 ${s.reachableEnds}/${s.endNodes}。` : '';
    r.appendChild(el('div', { text: '✅ 检查通过：所有可达的非结局局面均有出路，且不存在可无限循环而不抵达结局的路径。' + stat }));
  }
  r.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 保存草稿
async function saveDraft() {
  const r = await api('PUT', `/api/scenarios/${T.currentId}/draft`, { draft: T.model });
  if (!r.ok) { showValidationReport(r.data, true); return null; }
  T.model = r.data.draft;
  T.meta.updatedAt = r.data.updatedAt;
  renderEditor();
  return r.data;
}

$('#btn-save').addEventListener('click', async () => {
  hideReport();
  const saved = await saveDraft();
  if (saved) {
    showValidationReport({ passed: true, errors: [], warnings: saved.warnings || [] }, false);
    loadScenarios();
  }
});

// 发布前检查（不落库）
$('#btn-check').addEventListener('click', async () => {
  hideReport();
  const r = await api('POST', `/api/scenarios/${T.currentId}/validate`, { draft: T.model });
  if (r.ok) {
    if (r.data.normalized) T.model = r.data.normalized;
    showValidationReport(r.data, false);
  } else {
    showValidationReport(r.data, true);
  }
});

// 保存并发布
$('#btn-publish').addEventListener('click', async () => {
  hideReport();
  const saved = await saveDraft();
  if (!saved) return;
  const r = await api('POST', `/api/scenarios/${T.currentId}/publish`);
  if (!r.ok) { showValidationReport(r.data, true); return; }
  showValidationReport({ passed: true, errors: [], warnings: r.data.warnings, stats: r.data.stats }, false);
  await selectScenario(T.currentId);
  loadScenarios();
  alert(`已发布版本 v${r.data.versionNo}，内容已冻结。进行中的老会话继续沿旧版进行，新会话使用 v${r.data.versionNo}。`);
});

function renderVersions() {
  const box = $('#versions-box');
  box.innerHTML = '';
  const versions = (T.meta?.versions) || [];
  if (!versions.length) { box.appendChild(el('div', { class: 'muted', text: '尚未发布。' })); return; }
  for (const v of versions) {
    box.appendChild(el('div', { class: 'version-item' }, [
      el('b', { text: `v${v.version_no}` }),
      document.createTextNode(` · 发布于 ${new Date(v.published_at).toLocaleString()} · 版本ID ${v.id}`)
    ]));
  }
}

// ============ 学员端 ============
const S = { view: null, sid: null };

async function loadStudentScenarios() {
  const { data } = await api('GET', '/api/scenarios');
  const sel = $('#start-scenario');
  sel.innerHTML = '';
  const published = data.scenarios.filter((s) => s.latest_version);
  if (!published.length) {
    sel.appendChild(el('option', { value: '', text: '（暂无可演练的情境，请先发布）' }));
    $('#btn-start').disabled = true;
  } else {
    $('#btn-start').disabled = false;
    published.forEach((s) => sel.appendChild(el('option', { value: s.id, text: `${s.title}（最新 v${s.latest_version}）` })));
  }
}

$('#btn-start').addEventListener('click', async () => {
  const scenarioId = $('#start-scenario').value;
  if (!scenarioId) return;
  const r = await api('POST', '/api/sessions', { scenarioId });
  if (!r.ok) { alert(r.data?.message || '开始失败'); return; }
  openSession(r.data);
});

$('#btn-resume').addEventListener('click', async () => {
  const sid = $('#resume-sid').value.trim();
  if (!sid) return;
  await resumeSession(sid);
});

async function resumeSession(sid) {
  const r = await api('GET', '/api/sessions/' + encodeURIComponent(sid));
  if (!r.ok) { alert(r.data?.message || '会话不存在'); return false; }
  openSession(r.data);
  return true;
}

function openSession(view) {
  S.view = view;
  S.sid = view.sessionId;
  $('#student-start').hidden = true;
  $('#student-session').hidden = false;
  location.hash = '#/s/' + S.sid;
  renderSession(view, null);
}

$('#btn-exit-session').addEventListener('click', () => {
  $('#student-session').hidden = true;
  $('#student-start').hidden = false;
  location.hash = '';
  S.view = null; S.sid = null;
  $('#choice-toast').hidden = true;
  loadStudentScenarios();
});

$('#btn-copy-link').addEventListener('click', async () => {
  const link = location.origin + '/#/s/' + S.sid;
  try { await navigator.clipboard.writeText(link); alert('恢复链接已复制：\n' + link); }
  catch (_) { prompt('请手动复制：', link); }
});

function renderSession(view, toast) {
  $('#ss-title').textContent = view.scenarioTitle;
  $('#ss-sid').textContent = view.sessionId;
  $('#ss-step').textContent = view.step;
  $('#ss-version').textContent = view.node.isEnd ? '已结束' : '进行中';
  $('#ss-node-title').textContent = `${view.step === 0 ? '' : '第 ' + view.step + ' 步后 · '}${view.node.title}`;
  $('#ss-node-text').textContent = view.node.text || '';
  $('#ss-end-badge').hidden = !view.node.isEnd;

  const states = $('#ss-states');
  states.innerHTML = '';
  view.states.forEach((s) => {
    states.appendChild(el('span', { class: 'chip ' + (s.value ? 'on' : 'off'), text: `${s.label}：${s.value ? '是' : '否'}` }));
  });

  const opts = $('#ss-options');
  opts.innerHTML = '';
  const un = $('#ss-unavailable');
  un.innerHTML = '';

  if (view.status === 'active' && !view.node.isEnd) {
    if (view.availableOptions.length === 0) {
      opts.appendChild(el('div', { class: 'no-option', text: '当前状态下没有任何可选操作（若该情境已通过发布检查，不应出现此情况）。' }));
    }
    view.availableOptions.forEach((o) => {
      opts.appendChild(el('button', {
        class: 'option-btn',
        onclick: () => choose(o.id)
      }, [
        el('span', { text: o.text }),
        el('span', { class: 'step-hint', text: `提交步号 step=${view.step}` })
      ]));
    });
    if (view.unavailableOptions.length) {
      un.appendChild(el('div', { class: 'unavailable-title', text: '条件不满足、当前不可选：' }));
      view.unavailableOptions.forEach((o) => {
        const cond = o.requires.map((r) => `${r.label} 必须 = ${r.value}`).join('且');
        un.appendChild(el('div', { class: 'locked-option' }, [
          el('div', { text: '🔒 ' + o.text }),
          el('div', { class: 'cond', text: '条件：' + cond })
        ]));
      });
    }
  } else {
    opts.appendChild(el('div', { style: 'font-size:15px;font-weight:600;color:#1f6f43', text: '演练结束，已抵达结局。' }));
  }

  const path = $('#ss-path');
  path.innerHTML = '';
  view.path.forEach((p) => {
    const after = p.stateAfter.map((s) => `${s.label}=${s.value ? '是' : '否'}`).join('，');
    path.appendChild(el('li', {}, [
      el('span', { text: `第 ${p.step} 步：在「${p.fromNode}」选择「${p.optionText}」 → 「${p.toNode}」` }),
      el('span', { class: 'st-after', text: `　[${after}]` })
    ]));
  });
  if (!view.path.length) path.appendChild(el('li', { class: 'muted', text: '（尚未做出任何选择）' }));

  const toastBox = $('#choice-toast');
  if (toast) {
    toastBox.hidden = false;
    toastBox.className = 'toast' + (toast.kind === 'info' ? ' info' : '');
    toastBox.textContent = toast.text;
  } else {
    toastBox.hidden = true;
  }
}

async function choose(optionId) {
  const step = S.view.step; // 每步携带当前步号
  const r = await api('POST', `/api/sessions/${S.sid}/choose`, { optionId, step });
  if (r.ok) {
    S.view = r.data;
    renderSession(r.data, null);
  } else {
    // 过期或不满足条件：返回原因和现状，不推进会话
    const msg = r.data?.message || '选择被拒绝';
    if (r.data?.current) {
      S.view = r.data.current;
      const changed = r.data.current.step !== step;
      renderSession(r.data.current, {
        kind: changed ? 'warn' : 'info',
        text: `⛔ ${msg}\n你的请求未推进，页面已刷新为服务器当前状态（当前为第 ${r.data.current.step} 步）。`
      });
    } else {
      alert(msg);
    }
  }
}

// ============ 启动 ============
loadScenarios();
loadStudentScenarios();
(async () => {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) {
    document.querySelector('.tab[data-tab=student]').click();
    const ok = await resumeSession(decodeURIComponent(m[1]));
    if (!ok) location.hash = '';
  }
})();
