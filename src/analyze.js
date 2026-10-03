'use strict';

// 发布前可达性分析（位掩码编码 ≤8 个布尔状态）。
//
// “配置” = (当前节点, 当前状态掩码)，最多 |节点| × 2^8 = 2048 个。
// 从 (起点, 初态) 做 BFS 得到全部可达配置，然后：
//   1. 死路：可达的非结局配置没有任何满足条件的选项；
//   2. 无限循环：存在可达配置，从它出发无论怎样选择都无法抵达任何结局
//      （在有限图上等价于被困在一个不含结局的强连通区域中）。
// 两类问题都给出可复现的路径（逐步选项序列），不通过则拒绝发布。

function buildStateIndex(states) {
  const index = new Map();
  let initialMask = 0;
  states.forEach((s, i) => {
    const bit = 1 << i;
    index.set(s.id, bit);
    if (s.initial) initialMask |= bit;
  });
  return { index, initialMask };
}

function optionMatches(option, mask, stateBits) {
  for (const c of option.requires) {
    const bit = stateBits.get(c.state);
    const on = (mask & bit) !== 0;
    if (on !== c.value) return false;
  }
  return true;
}

function applySets(mask, option, stateBits) {
  let m = mask;
  for (const c of option.sets) {
    const bit = stateBits.get(c.state);
    if (c.value) m |= bit;
    else m &= ~bit;
  }
  return m;
}

// 根据 (nodeId -> node) 与状态位表，计算某配置下所有合法转移
function outgoing(node, mask, nodeMap, stateBits) {
  const edges = [];
  if (node.isEnd) return edges;
  for (const o of node.options) {
    if (!o.next || !nodeMap.has(o.next)) continue;
    if (!optionMatches(o, mask, stateBits)) continue;
    edges.push({ optionId: o.id, optionText: o.text, next: o.next, mask: applySets(mask, o, stateBits) });
  }
  return edges;
}

function key(nodeId, mask) {
  return `${nodeId}#${mask}`;
}

function formatMask(mask, states) {
  const parts = states.map((s, i) => `${s.label || s.id}=${(mask & (1 << i)) !== 0}`);
  return `{${parts.join(', ')}}`;
}

// 依据 BFS 记录的 parent 链，重建从起点到某配置的逐步路径
function buildPath(parent, targetKey, visited) {
  const steps = [];
  let cur = targetKey;
  while (parent.has(cur) && parent.get(cur) !== null) {
    const p = parent.get(cur);
    steps.push({
      stepVia: p.optionText,
      optionId: p.optionId,
      from: p.from,
      to: p.to,
      stateAtTarget: p.toMask
    });
    cur = p.parentKey;
  }
  steps.reverse();
  return steps;
}

function renderPath(steps, states, startNode) {
  if (steps.length === 0) {
    return `起点（${startNode.title}）—— 无需任何选择即出问题`;
  }
  const lines = steps.map((s, i) => `第 ${i + 1} 步：选择「${s.stepVia}」 → 到达「${s.to}」（状态 ${formatMask(s.stateAtTarget, states)}）`);
  return lines.join('\n');
}

// 在“坏配置”子图中枚举简单环（迭代式 DFS，显式栈）
function findCycles(badKeys, succOf, maxCycles) {
  const cycles = [];
  const seenSignatures = new Set();

  for (const start of badKeys) {
    if (cycles.length >= maxCycles) break;

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    // 栈帧：{ key, childIndex, parentEdge }
    const stack = [{ k: start, idx: 0 }];
    color.set(start, GRAY);
    const pathKeys = [start];

    while (stack.length > 0 && cycles.length < maxCycles) {
      const frame = stack[stack.length - 1];
      const succs = succOf.get(frame.k) || [];
      if (frame.idx >= succs.length) {
        color.set(frame.k, BLACK);
        stack.pop();
        pathKeys.pop();
        continue;
      }
      const edge = succs[frame.idx++];
      const tk = key(edge.next, edge.mask);
      const c = color.get(tk);
      if (c === BLACK || c === undefined) {
        color.set(tk, GRAY);
        pathKeys.push(tk);
        stack.push({ k: tk, idx: 0 });
      } else if (c === GRAY) {
        const ci = pathKeys.indexOf(tk);
        if (ci === -1) continue;
        const ringNodes = pathKeys.slice(ci);
        // 收集环上的边选项文本，按节点顺序
        const ringEdges = [];
        for (let i = 0; i < ringNodes.length; i++) {
          const fromK = ringNodes[i];
          const toK = ringNodes[(i + 1) % ringNodes.length];
          const e = (succOf.get(fromK) || []).find((x) => key(x.next, x.mask) === toK);
          ringEdges.push(e ? e.optionText : '?');
        }
        // 以最小旋转作为环的规范签名去重
        const sigArr = ringNodes.map((rk, i) => `${rk}--[${ringEdges[i]}]-->`);
        let minRot = 0;
        for (let r = 1; r < sigArr.length; r++) {
          for (let i = 0; i < sigArr.length; i++) {
            const a = sigArr[(r + i) % sigArr.length];
            const b = sigArr[(minRot + i) % sigArr.length];
            if (a < b) { minRot = r; break; }
            if (a > b) break;
          }
        }
        const sig = sigArr.map((_, i) => sigArr[(minRot + i) % sigArr.length]).join(' | ');
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          cycles.push({ entryKey: tk, ringNodes, ringEdges, signature: sig });
        }
      }
    }
  }
  return cycles;
}

function analyze(draft) {
  const errors = [];      // 阻断发布的问题（死路 / 无限循环）
  const warnings = [];

  const states = draft.states || [];
  const nodes = draft.nodes || [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const startNode = nodeMap.get(draft.start);
  const { index: stateBits, initialMask } = buildStateIndex(states);

  if (!startNode) {
    return { ok: false, errors: ['起点不存在，无法分析'], warnings: [], stats: null };
  }

  // ---- BFS：枚举从 (起点, 初态) 可达的全部配置 ----
  const visited = new Map(); // key -> { nodeId, mask }
  const parent = new Map();  // key -> { parentKey, optionId, optionText, from, toMask } | null
  const succOf = new Map();  // key -> [edge]
  const queue = [];

  const sk = key(startNode.id, initialMask);
  visited.set(sk, { nodeId: startNode.id, mask: initialMask });
  parent.set(sk, null);
  queue.push(sk);

  let qh = 0;
  while (qh < queue.length) {
    const ck = queue[qh++];
    const { nodeId, mask } = visited.get(ck);
    const node = nodeMap.get(nodeId);
    const edges = outgoing(node, mask, nodeMap, stateBits);
    succOf.set(ck, edges);
    for (const e of edges) {
      const tk = key(e.next, e.mask);
      if (!visited.has(tk)) {
        visited.set(tk, { nodeId: e.next, mask: e.mask });
        parent.set(tk, {
          parentKey: ck,
          optionId: e.optionId,
          optionText: e.optionText,
          from: node.title || nodeId,
          to: (nodeMap.get(e.next)?.title) || e.next,
          toMask: e.mask
        });
        queue.push(tk);
      }
    }
  }

  // ---- 标记结局可达性：good = 本配置是结局，或存在一条通向 good 的转移 ----
  const good = new Set();
  for (const [ck, { nodeId }] of visited) {
    if (nodeMap.get(nodeId).isEnd) good.add(ck);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const ck of visited.keys()) {
      if (good.has(ck)) continue;
      const edges = succOf.get(ck) || [];
      if (edges.some((e) => good.has(key(e.next, e.mask)))) {
        good.add(ck);
        changed = true;
      }
    }
  }

  const endCount = nodes.filter((n) => n.isEnd).length;
  const reachableNodeIds = new Set();
  for (const { nodeId } of visited.values()) reachableNodeIds.add(nodeId);

  for (const n of nodes) {
    if (!reachableNodeIds.has(n.id)) {
      warnings.push(`节点 “${n.title || n.id}” 从初态不可达，学员无法走到（不阻断发布）`);
    }
  }
  // 永远无法满足条件的选项
  for (const n of nodes) {
    if (!reachableNodeIds.has(n.id) || n.isEnd) continue;
    for (const o of n.options) {
      let ever = false;
      for (const [ck, { nodeId, mask }] of visited) {
        if (nodeId !== n.id) continue;
        if (optionMatches(o, mask, stateBits)) { ever = true; break; }
      }
      if (!ever) warnings.push(`节点 “${n.title || n.id}” 的选项「${o.text}」在任何可达状态下条件都不成立，学员永远看不到它`);
    }
  }

  // ---- 问题 1：死路（非结局、出度 0）----
  const deadEnds = [];
  const bad = new Set();
  for (const ck of visited.keys()) {
    if (!good.has(ck)) bad.add(ck);
    const { nodeId } = visited.get(ck);
    const node = nodeMap.get(nodeId);
    if (!node.isEnd && (succOf.get(ck) || []).length === 0) {
      deadEnds.push(ck);
    }
  }

  let di = 1;
  for (const ck of deadEnds) {
    const { nodeId, mask } = visited.get(ck);
    const node = nodeMap.get(nodeId);
    const steps = buildPath(parent, ck, visited);
    errors.push(
      `【死路 #${di++}】非结局节点「${node.title || nodeId}」在状态 ${formatMask(mask, states)} 下没有任何可选操作，学员将被困住。\n` +
      `复现路径（从起点出发，共 ${steps.length} 步）：\n${renderPath(steps, states, startNode)}`
    );
  }

  // ---- 问题 2：可无限循环而不抵达结局 ----
  // 坏子图（bad）中的环即“不经过任何结局的循环”；从任意可达配置进入后可永远循环。
  if (bad.size > 0) {
    const badSucc = new Map();
    for (const ck of bad) {
      const edges = (succOf.get(ck) || []).filter((e) => bad.has(key(e.next, e.mask)));
      badSucc.set(ck, edges);
    }
    const cycles = findCycles([...bad], badSucc, 8);
    let ci = 1;
    for (const cyc of cycles) {
      const stepsToEntry = buildPath(parent, cyc.entryKey, visited);
      const ringNames = cyc.ringNodes.map((rk) => {
        const { nodeId } = visited.get(rk);
        return nodeMap.get(nodeId).title || nodeId;
      });
      const cycleDesc = ringNodesDescribe(ringNames, cyc.ringEdges);
      const entryLeadIn = stepsToEntry.length === 0
        ? '循环入口就是起点，从第 1 步开始不断重复循环体即可无限进行。'
        : `先按下面路径走到循环入口（共 ${stepsToEntry.length} 步），随后不断重复循环体即可无限进行：\n${renderPath(stepsToEntry, states, startNode)}`;
      errors.push(
        `【无限循环 #${ci++}】存在可无限重复、且永远到不了结局的路径：\n` +
        `循环体：${cycleDesc}\n` +
        entryLeadIn
      );
    }
    // 兜底：坏配置存在但简单环枚举未覆盖（理论上不会发生，防御性提示）
    if (cycles.length === 0) {
      const anyBad = [...bad][0];
      const steps = buildPath(parent, anyBad, visited);
      const { nodeId } = visited.get(anyBad);
      errors.push(
        `【无限循环】节点「${nodeMap.get(nodeId).title || nodeId}」存在无论如何选择都无法抵达结局的路径。\n` +
        `复现路径（共 ${steps.length} 步）：\n${renderPath(steps, states, startNode)}`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      reachableConfigs: visited.size,
      totalConfigs: nodes.length * (1 << states.length),
      reachableNodes: reachableNodeIds.size,
      totalNodes: nodes.length,
      endNodes: endCount,
      reachableEnds: [...good].filter((ck) => nodeMap.get(visited.get(ck).nodeId).isEnd).length
    }
  };
}

function ringNodesDescribe(ringNames, ringEdges) {
  const parts = ringNames.map((name, i) => `「${name}」—选「${ringEdges[i]}」→`);
  parts.push(`回到「${ringNames[0]}」`);
  return parts.join(' ');
}

module.exports = { analyze, buildStateIndex, optionMatches, applySets, formatMask };
