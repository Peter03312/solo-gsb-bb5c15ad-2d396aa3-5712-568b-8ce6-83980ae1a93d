'use strict';

// 草稿结构校验：无效引用、矛盾条件、重复 ID、空字段等一律拒绝保存。
// 可达性（死路 / 无限循环）属于发布前检查，在 analyze.js 中完成。

const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

function asBool(v, dflt = false) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return dflt;
  // 不接受字符串 "true"，防止前端误传造成歧义
  return dflt;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// requires / sets 兼容两种写法：
//   数组：[{ state: 'fire', value: true }]
//   对象：{ fire: true }
function parseClauses(raw, stateIds, ctx, errors) {
  const out = [];
  let entries = [];

  if (Array.isArray(raw)) {
    entries = raw.map((c) => [c && c.state, c && c.value]);
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw);
  } else if (raw === undefined || raw === null) {
    entries = [];
  } else {
    errors.push(`${ctx}：条件必须是数组或对象`);
    return out;
  }

  for (const [sid, val] of entries) {
    const id = str(sid);
    if (!id) {
      errors.push(`${ctx}：存在缺少状态名的条件`);
      continue;
    }
    if (!stateIds.has(id)) {
      errors.push(`${ctx}：引用了不存在的状态 “${id}”`);
      continue;
    }
    if (typeof val !== 'boolean') {
      errors.push(`${ctx}：状态 “${id}” 的取值必须是布尔值 true/false`);
      continue;
    }
    out.push({ state: id, value: val });
  }
  return out;
}

// 检查同一状态上的矛盾条件，如 requires: [fire=true, fire=false]
function checkContradictions(clauses, ctx, errors) {
  const seen = new Map();
  for (const c of clauses) {
    if (seen.has(c.state) && seen.get(c.state) !== c.value) {
      errors.push(`${ctx}：对状态 “${c.state}” 同时要求 true 与 false，条件自相矛盾`);
    } else {
      seen.set(c.state, c.value);
    }
  }
  return seen;
}

function validateDraft(input) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['草稿必须是对象'], warnings: [], normalized: null };
  }

  const title = str(input.title);
  if (!title) errors.push('情境标题不能为空');

  // ---- 状态定义（至多 8 个布尔现场状态）----
  const states = [];
  const stateIds = new Set();
  if (input.states !== undefined && !Array.isArray(input.states)) {
    errors.push('states 必须是数组');
  } else {
    const list = Array.isArray(input.states) ? input.states : [];
    if (list.length > 8) errors.push(`布尔现场状态至多 8 个，当前定义了 ${list.length} 个`);
    for (let i = 0; i < list.length && i < 8; i++) {
      const s = list[i] || {};
      const id = str(s.id);
      const label = str(s.label) || id;
      const ctx = `状态 #${i + 1}`;
      if (!id) {
        errors.push(`${ctx}：缺少 id`);
        continue;
      }
      if (!ID_RE.test(id)) {
        errors.push(`${ctx}：id “${id}” 不合法（仅允许字母、数字、下划线、短横线，长度 1-64）`);
        continue;
      }
      if (stateIds.has(id)) {
        errors.push(`${ctx}：状态 id “${id}” 重复`);
        continue;
      }
      stateIds.add(id);
      states.push({ id, label: label || id, initial: asBool(s.initial) });
    }
  }

  // ---- 节点定义 ----
  const nodes = [];
  const nodeIds = new Set();
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    errors.push('nodes 必须是非空数组');
  } else {
    for (let i = 0; i < input.nodes.length; i++) {
      const n = input.nodes[i] || {};
      const id = str(n.id);
      const nctx = `节点 #${i + 1}`;
      if (!id) {
        errors.push(`${nctx}：缺少 id`);
        continue;
      }
      if (!ID_RE.test(id)) {
        errors.push(`${nctx}：id “${id}” 不合法`);
        continue;
      }
      if (nodeIds.has(id)) {
        errors.push(`${nctx}：节点 id “${id}” 重复`);
        continue;
      }
      nodeIds.add(id);

      const ntitle = str(n.title);
      if (!ntitle) errors.push(`节点 “${id}”：标题不能为空`);
      const ntext = str(n.text);
      if (!ntext) warnings.push(`节点 “${id}”：缺少情境描述文本`);
      const isEnd = asBool(n.isEnd);

      // ---- 选项 ----
      const options = [];
      const optionIds = new Set();
      if (n.options !== undefined && !Array.isArray(n.options)) {
        errors.push(`节点 “${id}”：options 必须是数组`);
      }
      const olist = Array.isArray(n.options) ? n.options : [];
      if (isEnd && olist.length > 0) {
        warnings.push(`结局节点 “${id}” 配置了 ${olist.length} 个选项，发布分析时不会被采纳`);
      }
      if (!isEnd && olist.length === 0) {
        warnings.push(`非结局节点 “${id}” 没有任何选项，学员走到这里将无路可走`);
      }
      for (let j = 0; j < olist.length; j++) {
        const o = olist[j] || {};
        const octx = `节点 “${id}” 的选项 #${j + 1}`;
        const oid = str(o.id);
        if (!oid) {
          errors.push(`${octx}：缺少 id`);
          continue;
        }
        if (!ID_RE.test(oid)) {
          errors.push(`${octx}：id “${oid}” 不合法`);
          continue;
        }
        if (optionIds.has(oid)) {
          errors.push(`${octx}：选项 id “${oid}” 重复`);
          continue;
        }
        optionIds.add(oid);

        const otext = str(o.text);
        if (!otext) errors.push(`${octx}：选项文案不能为空`);

        const requires = parseClauses(o.requires, stateIds, `${octx} 的生效条件`, errors);
        const sets = parseClauses(o.sets, stateIds, `${octx} 的状态变更`, errors);
        checkContradictions(requires, `${octx} 的生效条件`, errors);
        checkContradictions(sets, `${octx} 的状态变更`, errors);

        const next = str(o.next);
        if (!next) {
          errors.push(`${octx}：缺少目标节点 next`);
        }
        options.push({ id: oid, text: otext, requires, sets, next });
      }

      nodes.push({ id, title: ntitle || id, text: ntext, isEnd, options });
    }
  }

  // ---- 起点 ----
  const start = str(input.start);
  if (!start) {
    errors.push('必须指定起点节点 start');
  } else if (!nodeIds.has(start)) {
    errors.push(`起点 “${start}” 不是已定义的节点`);
  }

  // ---- 第二轮：跨结构引用检查（选项 -> 目标节点）----
  for (const n of nodes) {
    for (const o of n.options) {
      if (o.next && !nodeIds.has(o.next)) {
        errors.push(`节点 “${n.id}” 的选项 “${o.id}” 指向不存在的节点 “${o.next}”`);
      }
    }
  }

  // 至少存在一个结局节点
  if (!nodes.some((n) => n.isEnd)) {
    warnings.push('当前没有任何结局节点（isEnd=true），发布检查将无法通过');
  }
  if (start && nodeIds.has(start) && nodes.find((n) => n.id === start)?.isEnd) {
    warnings.push('起点被标记为结局节点，演练将在第 0 步直接结束');
  }

  const normalized = {
    title: title || '未命名情境',
    states,
    nodes,
    start: start || null
  };

  return { ok: errors.length === 0, errors, warnings, normalized };
}

module.exports = { validateDraft };
