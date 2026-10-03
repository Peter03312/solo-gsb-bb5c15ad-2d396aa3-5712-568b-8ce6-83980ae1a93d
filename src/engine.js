'use strict';

// 运行时引擎：在冻结版本内容上执行学员会话。
// 所有推进都基于“选择发生时”的快照内容，保证老会话永远沿原版继续。

const { buildStateIndex, optionMatches, applySets } = require('./analyze');

function loadContent(frozenJson) {
  const draft = JSON.parse(frozenJson);
  const nodeMap = new Map(draft.nodes.map((n) => [n.id, n]));
  const { index: stateBits, initialMask } = buildStateIndex(draft.states);
  return { draft, nodeMap, stateBits, initialMask };
}

function stateList(draft, mask) {
  return draft.states.map((s, i) => ({
    id: s.id,
    label: s.label,
    value: (mask & (1 << i)) !== 0
  }));
}

// 构造返回给学员端的当前局面（可选项、状态、走过的路径）
function buildView(engine, session, pathJson) {
  const { draft, nodeMap, stateBits } = engine;
  const node = nodeMap.get(session.current_node);
  const path = pathJson || JSON.parse(session.path || '[]');

  // 路径上补充每一步到达时的节点标题
  const enrichedPath = path.map((p) => ({
    step: p.step,
    optionId: p.optionId,
    optionText: p.optionText,
    fromNode: nodeMap.get(p.from)?.title || p.from,
    toNode: nodeMap.get(p.to)?.title || p.to,
    stateAfter: stateList(draft, p.maskAfter)
  }));

  let availableOptions = [];
  let unavailableOptions = [];
  if (session.status === 'active' && node && !node.isEnd) {
    for (const o of node.options) {
      const item = {
        id: o.id,
        text: o.text,
        requires: o.requires.map((r) => ({
          state: r.state,
          label: draft.states.find((s) => s.id === r.state)?.label || r.state,
          value: r.value
        }))
      };
      if (optionMatches(o, session.state_mask, stateBits)) availableOptions.push(item);
      else unavailableOptions.push(item);
    }
  }

  return {
    sessionId: session.id,
    status: session.status,
    step: session.step,
    scenarioTitle: draft.title,
    node: {
      id: node.id,
      title: node.title,
      text: node.text,
      isEnd: !!node.isEnd
    },
    states: stateList(draft, session.state_mask),
    availableOptions,
    unavailableOptions,
    path: enrichedPath
  };
}

// 执行一次选择；不修改数据库，只返回结果描述，由调用方落库
function applyChoice(engine, session, optionId, clientStep) {
  if (session.status !== 'active') {
    return { ok: false, reason: 'session_ended', message: '会话已结束，不能继续选择' };
  }
  if (typeof clientStep !== 'number' || clientStep !== session.step) {
    return {
      ok: false,
      reason: 'stale_step',
      message: `步号过期：你提交的是第 ${clientStep} 步，当前应为第 ${session.step} 步。页面可能不是最新状态，请求未推进。`,
      currentStep: session.step
    };
  }
  const { nodeMap, stateBits } = engine;
  const node = nodeMap.get(session.current_node);
  if (!node) {
    return { ok: false, reason: 'broken_snapshot', message: '当前节点在该版本内容中不存在（内容异常）' };
  }
  if (node.isEnd) {
    return { ok: false, reason: 'at_end', message: '当前已处于结局节点，无可选项' };
  }
  const option = node.options.find((o) => o.id === optionId);
  if (!option) {
    return {
      ok: false,
      reason: 'option_not_found',
      message: `选项 “${optionId}” 不属于当前节点「${node.title}」，请求未推进。`,
      currentStep: session.step
    };
  }
  if (!optionMatches(option, session.state_mask, stateBits)) {
    const failed = option.requires
      .filter((r) => {
        const on = (session.state_mask & stateBits.get(r.state)) !== 0;
        return on !== r.value;
      })
      .map((r) => {
        const label = engine.draft.states.find((s) => s.id === r.state)?.label || r.state;
        return `需要「${label}」=${r.value}，当前为 ${!r.value}`;
      });
    return {
      ok: false,
      reason: 'condition_not_met',
      message: `选项「${option.text}」当前条件不满足，请求未推进。${failed.join('；')}`,
      failedConditions: failed,
      currentStep: session.step
    };
  }
  if (!nodeMap.has(option.next)) {
    return { ok: false, reason: 'broken_snapshot', message: `选项指向的节点 “${option.next}” 在该版本内容中不存在` };
  }

  const fromNodeId = session.current_node;
  const newMask = applySets(session.state_mask, option, stateBits);
  const newNodeId = option.next;
  const newStep = session.step + 1;
  const ended = nodeMap.get(newNodeId).isEnd;

  const path = JSON.parse(session.path || '[]');
  path.push({
    step: newStep,
    optionId: option.id,
    optionText: option.text,
    from: fromNodeId,
    to: newNodeId,
    maskAfter: newMask
  });

  return {
    ok: true,
    newNodeId,
    newMask,
    newStep,
    newStatus: ended ? 'ended' : 'active',
    newPath: JSON.stringify(path)
  };
}

module.exports = { loadContent, buildView, applyChoice };
