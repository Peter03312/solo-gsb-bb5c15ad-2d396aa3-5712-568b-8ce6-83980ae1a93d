'use strict';

const {
  optionAvailable,
  applyChanges,
  formatStateValues,
} = require('./scenario');

function nodesById(content) {
  return new Map(content.nodes.map((n) => [n.id, n]));
}

// 构造返回给前端的完整现状快照
function buildSnapshot(content, session, scenarioId, version) {
  const nodeMap = nodesById(content);
  const node = nodeMap.get(session.current_node_id);
  const stateValues = formatStateValues(content, session.state_mask);
  const path = JSON.parse(session.path || '[]');

  const available = [];
  const unavailable = [];
  if (node && !node.isEnd && session.status === 'active') {
    for (const o of node.options) {
      const ok = optionAvailable(o, session.state_mask, content);
      const failing = o.conditions
        .filter((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          const cur = stateValues.find((v) => v.id === c.stateId);
          return st && cur && cur.value !== c.value;
        })
        .map((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          return { stateId: c.stateId, stateName: st ? st.name : c.stateId, required: c.value };
        });
      const item = {
        id: o.id,
        label: o.label,
        conditions: o.conditions,
        changes: o.changes,
        toNodeId: o.toNodeId,
      };
      if (ok) available.push(item);
      else unavailable.push({ ...item, reason: '当前现场状态不满足该选项条件', failingConditions: failing });
    }
  }

  const pathView = path.map((p) => {
    const fromNode = nodeMap.get(p.fromNodeId);
    const toNode = nodeMap.get(p.toNodeId);
    const fromN = fromNode ? fromNode.options.find((o) => o.id === p.optionId) : null;
    return {
      step: p.step,
      fromNodeId: p.fromNodeId,
      fromNodeTitle: fromNode ? fromNode.title : p.fromNodeId,
      optionId: p.optionId,
      optionLabel: fromN ? fromN.label : p.optionId,
      toNodeId: p.toNodeId,
      toNodeTitle: toNode ? toNode.title : p.toNodeId,
      stateAfter: formatStateValues(content, p.stateMask),
    };
  });

  return {
    code: session.code,
    scenarioId,
    version,
    status: session.status,
    stepNo: session.step_no,
    currentNode: node ? {
      id: node.id,
      title: node.title,
      narrative: node.narrative,
      isEnd: node.isEnd,
    } : null,
    states: stateValues,
    availableOptions: available,
    unavailableOptions: unavailable,
    path: pathView,
    traineeName: session.trainee_name || null,
    startedAt: session.created_at,
  };
}

/**
 * 执行一步选择。不写库，返回 {ok, error, session}（供事务内调用）。
 * 校验：会话存在/未结束、步号严格匹配当前步号（防过期/重复提交）、
 *       选项属于当前节点、条件满足。任何不满足都不推进。
 */
function performMove(db, { code, optionId, stepNo, traineeName }) {
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  if (!session) {
    return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '会话不存在' };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  if (!versionRow) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '会话所绑定的版本内容缺失' };
  }
  const content = JSON.parse(versionRow.content);
  const nodeMap = nodesById(content);

  const fail = (status, errorCode, error) => ({
    ok: false,
    status,
    errorCode,
    error,
    current: buildSnapshot(content, session, session.scenario_id, session.version),
  });

  if (session.status !== 'active') {
    return fail(409, 'SESSION_ENDED', '该会话已结束，不能继续选择');
  }
  if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
    return fail(409, 'STEP_STALE',
      `步号不匹配：请求携带第 ${stepNo} 步，会话当前为第 ${session.step_no} 步（可能是过期或重复的选择，未推进）`);
  }
  const node = nodeMap.get(session.current_node_id);
  if (!node || node.isEnd) {
    return fail(409, 'NODE_NOT_CHOOSABLE', '当前节点不是可选择节点');
  }
  const option = node.options.find((o) => o.id === optionId);
  if (!option) {
    return fail(400, 'OPTION_NOT_FOUND', '当前节点下不存在该选项');
  }
  if (!optionAvailable(option, session.state_mask, content)) {
    const failing = option.conditions
      .filter((c) => {
        const i = content.states.findIndex((s) => s.id === c.stateId);
        const cur = i >= 0 ? ((session.state_mask >> i) & 1) === 1 : null;
        return cur !== null && cur !== c.value;
      })
      .map((c) => {
        const st = content.states.find((s) => s.id === c.stateId);
        return `${st ? st.name : c.stateId} 需要为「${c.value ? '是' : '否'}」`;
      });
    return fail(409, 'CONDITION_NOT_MET',
      `当前现场状态不满足选项「${option.label}」的条件${failing.length ? '：' + failing.join('；') : ''}`);
  }

  const newMask = applyChanges(option, session.state_mask, content);
  const nextStep = session.step_no + 1;
  const path = JSON.parse(session.path || '[]');
  path.push({
    step: nextStep,
    fromNodeId: node.id,
    optionId: option.id,
    toNodeId: option.toNodeId,
    stateMask: newMask,
  });
  const targetNode = nodeMap.get(option.toNodeId);
  const newStatus = targetNode && targetNode.isEnd ? 'ended' : 'active';

  db.prepare(`
    UPDATE sessions
       SET current_node_id = ?, state_mask = ?, step_no = ?, status = ?,
           path = ?, trainee_name = COALESCE(?, trainee_name), updated_at = datetime('now')
     WHERE code = ?
  `).run(option.toNodeId, newMask, nextStep, newStatus, JSON.stringify(path),
    traineeName ?? null, code);

  const updated = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  return { ok: true, session: updated, content };
}

module.exports = { buildSnapshot, performMove, nodesById };
