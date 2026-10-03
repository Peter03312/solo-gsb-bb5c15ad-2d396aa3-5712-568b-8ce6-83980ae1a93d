'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const db = require('./src/db');
const { validateDraft } = require('./src/validator');
const { analyze } = require('./src/analyze');
const { loadContent, buildView, applyChoice } = require('./src/engine');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'drill.db');

db.init(DB_PATH);
const getDb = db.get;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const randomId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function notFound(res, what) {
  return res.status(404).json({ error: 'not_found', message: what });
}

// ---------- 情境草稿 ----------

app.get('/api/scenarios', (req, res) => {
  const rows = getDb().prepare(`
    SELECT s.id, s.title, s.updated_at,
           (SELECT MAX(version_no) FROM versions v WHERE v.scenario_id = s.id) AS latest_version
    FROM scenarios s ORDER BY s.updated_at DESC
  `).all();
  res.json({ scenarios: rows });
});

app.post('/api/scenarios', (req, res) => {
  const result = validateDraft(req.body && req.body.draft);
  if (!result.ok) {
    return res.status(400).json({ error: 'invalid_draft', message: '草稿存在结构问题，未创建', details: result.errors, warnings: result.warnings });
  }
  const id = randomId();
  const now = nowIso();
  const draft = result.normalized;
  getDb().prepare(`INSERT INTO scenarios (id, title, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, draft.title, JSON.stringify(draft), now, now);
  res.status(201).json({ id, draft: result.normalized, warnings: result.warnings });
});

app.get('/api/scenarios/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, '情境不存在');
  const versions = getDb().prepare(
    'SELECT id, version_no, published_at FROM versions WHERE scenario_id = ? ORDER BY version_no DESC'
  ).all(req.params.id);
  res.json({ id: row.id, title: row.title, draft: JSON.parse(row.draft), versions, updatedAt: row.updated_at });
});

// 保存草稿：无效引用 / 矛盾条件等结构问题一律拒绝保存
app.put('/api/scenarios/:id/draft', (req, res) => {
  const row = getDb().prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, '情境不存在');
  const result = validateDraft(req.body && req.body.draft);
  if (!result.ok) {
    return res.status(400).json({ error: 'invalid_draft', message: '草稿存在结构问题，拒绝保存', details: result.errors, warnings: result.warnings });
  }
  const draft = result.normalized;
  const now = nowIso();
  getDb().prepare('UPDATE scenarios SET title = ?, draft = ?, updated_at = ? WHERE id = ?')
    .run(draft.title, JSON.stringify(draft), now, row.id);
  res.json({ id: row.id, draft, warnings: result.warnings, updatedAt: now });
});

// 仅校验 / 发布前分析，不落库。body.draft 缺省时校验已保存的草稿。
app.post('/api/scenarios/:id/validate', (req, res) => {
  const row = getDb().prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, '情境不存在');
  const source = req.body && req.body.draft !== undefined ? req.body.draft : JSON.parse(row.draft);
  const v = validateDraft(source);
  if (!v.ok) {
    return res.json({ passed: false, stage: 'structure', errors: v.errors, warnings: v.warnings });
  }
  const a = analyze(v.normalized);
  res.json({
    passed: a.ok,
    stage: a.ok ? 'passed' : 'reachability',
    errors: a.errors,
    warnings: [...v.warnings, ...a.warnings],
    stats: a.stats,
    normalized: v.normalized
  });
});

// ---------- 发布：冻结内容 ----------

app.post('/api/scenarios/:id/publish', (req, res) => {
  const row = getDb().prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, '情境不存在');

  // 始终对当前保存的草稿做完整检查
  const v = validateDraft(JSON.parse(row.draft));
  if (!v.ok) {
    return res.status(400).json({
      error: 'publish_rejected',
      message: '草稿存在结构问题，拒绝发布',
      stage: 'structure',
      errors: v.errors,
      warnings: v.warnings
    });
  }
  const a = analyze(v.normalized);
  if (!a.ok) {
    return res.status(422).json({
      error: 'publish_rejected',
      message: '发布前可达性检查未通过，已拒绝发布。下列问题均可按给出的路径复现：',
      stage: 'reachability',
      errors: a.errors,
      warnings: [...v.warnings, ...a.warnings],
      stats: a.stats
    });
  }

  const maxNo = getDb().prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM versions WHERE scenario_id = ?')
    .get(row.id).m;
  const versionNo = maxNo + 1;
  const versionId = randomId();
  const at = nowIso();
  // 冻结整份规范化内容；之后修改草稿不再影响任何已发布版本
  getDb().prepare(`INSERT INTO versions (id, scenario_id, version_no, frozen_content, published_at)
                   VALUES (?, ?, ?, ?, ?)`)
    .run(versionId, row.id, versionNo, JSON.stringify(v.normalized), at);
  getDb().prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').run(at, row.id);

  res.status(201).json({
    published: true,
    versionId,
    versionNo,
    publishedAt: at,
    warnings: [...v.warnings, ...a.warnings],
    stats: a.stats
  });
});

app.get('/api/scenarios/:id/versions/:vid', (req, res) => {
  const ver = getDb().prepare('SELECT * FROM versions WHERE id = ? AND scenario_id = ?')
    .get(req.params.vid, req.params.id);
  if (!ver) return notFound(res, '版本不存在');
  res.json({ versionId: ver.id, versionNo: ver.version_no, publishedAt: ver.published_at, content: JSON.parse(ver.frozen_content) });
});

// ---------- 学员会话 ----------

app.post('/api/sessions', (req, res) => {
  const scenarioId = req.body && req.body.scenarioId;
  const row = getDb().prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!row) return notFound(res, '情境不存在');

  let ver;
  if (req.body.versionId) {
    ver = getDb().prepare('SELECT * FROM versions WHERE id = ? AND scenario_id = ?')
      .get(req.body.versionId, scenarioId);
    if (!ver) return res.status(400).json({ error: 'bad_version', message: '指定版本不存在或不属于该情境' });
  } else {
    // 新会话使用最新已发布版本
    ver = getDb().prepare('SELECT * FROM versions WHERE scenario_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(scenarioId);
    if (!ver) return res.status(400).json({ error: 'not_published', message: '该情境尚未发布任何版本，无法开始演练' });
  }

  const engine = loadContent(ver.frozen_content);
  const sid = crypto.randomBytes(9).toString('base64url'); // ~12 字符，便于 URL 分享
  const at = nowIso();
  getDb().prepare(`INSERT INTO sessions (id, scenario_id, version_id, current_node, state_mask, step, path, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 0, '[]', 'active', ?, ?)`)
    .run(sid, scenarioId, ver.id, engine.draft.start, engine.initialMask, at, at);

  const session = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  res.status(201).json(buildView(engine, session));
});

app.get('/api/sessions/:sid', (req, res) => {
  const session = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sid);
  if (!session) return notFound(res, '会话不存在');
  const ver = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(session.version_id);
  if (!ver) return res.status(500).json({ error: 'broken_version', message: '该会话绑定的版本已不存在' });
  const engine = loadContent(ver.frozen_content);
  res.json(buildView(engine, session));
});

// 每步选择必须携带当前步号；过期或不满足条件返回原因与现状，不推进会话
app.post('/api/sessions/:sid/choose', asyncWrap(async (req, res) => {
  const sid = req.params.sid;
  const optionId = req.body && req.body.optionId;
  const step = req.body && req.body.step;

  const getSession = () => getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sid);

  if (typeof optionId !== 'string' || !optionId) {
    const s0 = getSession();
    if (!s0) return notFound(res, '会话不存在');
    const ver0 = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(s0.version_id);
    return res.status(400).json({ error: 'bad_request', message: '缺少 optionId', current: buildView(loadContent(ver0.frozen_content), s0) });
  }
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0) {
    const s0 = getSession();
    if (!s0) return notFound(res, '会话不存在');
    const ver0 = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(s0.version_id);
    return res.status(400).json({
      error: 'bad_request',
      message: '请求必须携带整数步号 step（从 0 开始，表示当前所处的步号）',
      current: buildView(loadContent(ver0.frozen_content), s0)
    });
  }

  // 串行化同一会话的推进，避免并发双提交
  const txn = getDb().transaction(() => {
    const session = getSession();
    if (!session) return { notFound: true };
    const ver = getDb().prepare('SELECT * FROM versions WHERE id = ?').get(session.version_id);
    if (!ver) return { broken: true };
    const engine = loadContent(ver.frozen_content);
    const result = applyChoice(engine, session, optionId, step);
    if (!result.ok) {
      return { rejected: true, result, engine, session };
    }
    getDb().prepare(`UPDATE sessions SET current_node = ?, state_mask = ?, step = ?, path = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(result.newNodeId, result.newMask, result.newStep, result.newPath, result.newStatus, nowIso(), sid);
    return { rejected: false, engine, session: getSession() };
  });

  const out = txn.immediate();
  if (out.notFound) return notFound(res, '会话不存在');
  if (out.broken) return res.status(500).json({ error: 'broken_version', message: '该会话绑定的版本已不存在' });
  if (out.rejected) {
    const status = out.result.reason === 'stale_step' || out.result.reason === 'condition_not_met' ||
      out.result.reason === 'option_not_found' || out.result.reason === 'at_end' ||
      out.result.reason === 'session_ended' ? 409 : 400;
    return res.status(status).json({
      error: 'choice_rejected',
      reason: out.result.reason,
      message: out.result.message,
      failedConditions: out.result.failedConditions,
      current: buildView(out.engine, out.session)
    });
  }
  res.json(buildView(out.engine, out.session));
}));

app.get('/api/health', (req, res) => res.json({ ok: true, time: nowIso() }));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal', message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`事故处置演练编排台已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${DB_PATH}`);
});
