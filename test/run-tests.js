'use strict';

// 端到端验证：启动一个临时数据库的服务实例，通过 HTTP 跑全部关键场景。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = 'http://127.0.0.1:3917';
let failures = 0;
let passed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failures++; console.log('  ❌', msg); }
}
async function call(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch (_) {}
    if (proc.exitCode !== null) throw new Error('server exited early: ' + proc.exitCode);
    await wait(150);
  }
  throw new Error('server not ready');
}

// ---------- 测试用草稿工厂 ----------
function linearDraft(overrides = {}) {
  return {
    title: '线性情境',
    states: [{ id: 'f', label: '标志', initial: false }],
    start: 'a',
    nodes: [
      { id: 'a', title: 'A', text: 'ta', isEnd: false, options: [
        { id: 'oa', text: '去B', requires: [], sets: [], next: 'b' }
      ] },
      { id: 'b', title: 'B', text: 'tb', isEnd: false, options: [
        { id: 'ob', text: '去E', requires: [], sets: [], next: 'e' }
      ] },
      { id: 'e', title: '结局E', text: 'te', isEnd: true, options: [] }
    ],
    ...overrides
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '3917', DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);

    // ===== 0. 种子情境：结构合法且可达性检查通过，且已发布 v1 =====
    console.log('\n[0] 内置示例情境');
    {
      const { data } = await call('GET', '/api/scenarios');
      ok(Array.isArray(data.scenarios) && data.scenarios.length >= 1, '存在种子情境');
      const seed = data.scenarios.find((s) => s.title.includes('反应釜'));
      ok(!!seed, '种子标题为化工反应釜示例');
      ok(seed.latest_version === 1, '种子已发布 v1');
      const v = await call('POST', `/api/scenarios/${seed.id}/validate`, {});
      ok(v.status === 200 && v.data.passed === true, '种子情境发布检查通过');
    }

    // ===== 1. 草稿结构校验 =====
    console.log('\n[1] 草稿保存：无效引用与矛盾条件必须拒绝');
    let sid;
    {
      const bad = linearDraft();
      bad.nodes[0].options[0].next = 'ghost'; // 无效节点引用
      bad.nodes[0].options[0].requires = [{ state: 'f', value: true }, { state: 'f', value: false }]; // 矛盾条件
      bad.states.push({ id: 'f', label: '重复ID', initial: false }); // 重复状态
      const r = await call('POST', '/api/scenarios', { draft: bad });
      ok(r.status === 400, '非法草稿创建被拒绝 400');
      ok(r.data.details.some((e) => e.includes('ghost')), '列出无效节点引用');
      ok(r.data.details.some((e) => e.includes('矛盾') || e.includes('自相矛盾')), '列出矛盾条件');
      ok(r.data.details.some((e) => e.includes('重复')), '列出重复 ID');

      const good = await call('POST', '/api/scenarios', { draft: linearDraft() });
      ok(good.status === 201, '合法草稿创建成功');
      sid = good.data.id;

      const mutate = linearDraft();
      mutate.states[0].id = 'renamed_state';
      mutate.nodes[1].options[0].requires = [{ state: 'missing', value: true }];
      const r2 = await call('PUT', `/api/scenarios/${sid}/draft`, { draft: mutate });
      ok(r2.status === 400 && r2.data.details.some((e) => e.includes('missing')), 'PUT 草稿时无效状态引用被拒绝');
    }

    // ===== 2. 死路检查 =====
    console.log('\n[2] 发布检查：非结局死路必须拒绝并给出复现路径');
    {
      const d = linearDraft();
      d.nodes[1].options = []; // B 变成死路
      const r = await call('POST', `/api/scenarios/${sid}/validate`, { draft: d });
      ok(r.status === 200 && r.data.passed === false, '检查结果为不通过');
      ok(r.data.errors.some((e) => e.includes('死路')), '识别为死路问题');
      ok(r.data.errors.some((e) => e.includes('去B')), '复现路径包含第 1 步选项「去B」');
      // 死路不阻断草稿保存（结构合法），但发布必须拒绝
      const savedDeadEnd = await call('PUT', `/api/scenarios/${sid}/draft`, { draft: d });
      ok(savedDeadEnd.status === 200, '死路草稿结构合法，允许保存');
      const pub = await call('POST', `/api/scenarios/${sid}/publish`);
      ok(pub.status === 422, '带死路的草稿拒绝发布（422）');
      // 恢复为合法草稿以便后续
      await call('PUT', `/api/scenarios/${sid}/draft`, { draft: linearDraft() });
    }

    // ===== 3. 无限循环检查 =====
    console.log('\n[3] 发布检查：可无限循环而不抵结局必须拒绝');
    {
      const loop = {
        title: '循环情境',
        states: [{ id: 'f', label: '标志', initial: false }],
        start: 'a',
        nodes: [
          { id: 'a', title: 'A', text: '', isEnd: false, options: [
            { id: 'ab', text: '去B', requires: [], sets: [], next: 'b' }
          ]},
          { id: 'b', title: 'B', text: '', isEnd: false, options: [
            { id: 'ba', text: '回A', requires: [], sets: [], next: 'a' }
          ]},
          { id: 'e', title: '结局', text: '', isEnd: true, options: [] }
        ]
      };
      const r = await call('POST', `/api/scenarios/${sid}/validate`, { draft: loop });
      ok(r.data.passed === false, '纯循环不通过');
      ok(r.data.errors.some((e) => e.includes('无限循环')), '识别为无限循环');
      ok(r.data.errors.some((e) => e.includes('去B') && e.includes('回A')), '报告包含循环体两个选项');

      // 条件门控的循环：f=true 时只能在 B 自环，f 初始 false，A 里可置 f=true 再去 B
      const gated = {
        title: '条件循环',
        states: [{ id: 'f', label: '标志', initial: false }],
        start: 'a',
        nodes: [
          { id: 'a', title: 'A', text: '', isEnd: false, options: [
            { id: 'setf', text: '置位并去B', requires: [], sets: [{ state: 'f', value: true }], next: 'b' },
            { id: 'toend', text: '直接结局', requires: [], sets: [], next: 'e' }
          ]},
          { id: 'b', title: 'B', text: '', isEnd: false, options: [
            { id: 'back', text: '回A', requires: [{ state: 'f', value: false }], sets: [], next: 'a' },
            { id: 'self', text: 'B自环', requires: [{ state: 'f', value: true }], sets: [], next: 'b' }
          ]},
          { id: 'e', title: '结局', text: '', isEnd: true, options: [] }
        ]
      };
      const r2 = await call('POST', `/api/scenarios/${sid}/validate`, { draft: gated });
      ok(r2.data.passed === false, '置位后被困自环不通过');
      ok(r2.data.errors.some((e) => e.includes('B自环')), '报告包含自环选项与进入路径');
    }

    // ===== 4. 发布成功 + 版本冻结 =====
    console.log('\n[4] 发布冻结：老会话沿原版，新会话用最新版');
    let sessionV1;
    {
      const d = linearDraft();
      await call('PUT', `/api/scenarios/${sid}/draft`, { draft: d });
      const p1 = await call('POST', `/api/scenarios/${sid}/publish`);
      ok(p1.status === 201 && p1.data.versionNo === 1, '合法草稿发布为 v1');

      const s1 = await call('POST', '/api/sessions', { scenarioId: sid });
      ok(s1.status === 201, '新会话创建成功');
      sessionV1 = s1.data.sessionId;
      ok(s1.data.step === 0 && s1.data.node.id === 'a' && s1.data.availableOptions.length === 1, '会话起点正确');

      // 修改草稿并发布 v2：A 的选项改为直接到新结局 e2
      const d2 = JSON.parse(JSON.stringify(d));
      d2.nodes[0].options[0].text = 'v2中的新文案';
      d2.nodes[0].options[0].next = 'e';
      d2.nodes = d2.nodes.filter((n) => n.id !== 'b'); // 删掉 B
      const sv = await call('PUT', `/api/scenarios/${sid}/draft`, { draft: d2 });
      ok(sv.status === 200, 'v2 草稿（删除节点B）保存成功（不影响已冻结 v1）');
      const p2 = await call('POST', `/api/scenarios/${sid}/publish`);
      ok(p2.status === 201 && p2.data.versionNo === 2, '发布 v2');

      // 老会话（v1）继续：仍能看到旧文案，且仍可走到已从草稿删除的 B
      const old = await call('GET', `/api/sessions/${sessionV1}`);
      ok(old.data.availableOptions[0].text === '去B', '老会话仍展示 v1 选项文案');
      const c1 = await call('POST', `/api/sessions/${sessionV1}/choose`, { optionId: 'oa', step: 0 });
      ok(c1.status === 200 && c1.data.node.id === 'b' && c1.data.step === 1, '老会话沿 v1 走到（草稿中已删除的）B 节点');

      // 新会话默认取 v2
      const s2 = await call('POST', '/api/sessions', { scenarioId: sid });
      ok(s2.data.availableOptions[0].text === 'v2中的新文案', '新会话使用 v2 内容');
    }

    // ===== 5. 步号过期 / 条件不满足 / 并发 =====
    console.log('\n[5] 选择防护：过期步号与不满足条件返回原因且不推进');
    {
      // 继续老会话（当前 step=1, 节点 B）
      const stale = await call('POST', `/api/sessions/${sessionV1}/choose`, { optionId: 'ob', step: 0 });
      ok(stale.status === 409 && stale.data.reason === 'stale_step', '过期步号返回 409 stale_step');
      ok(stale.data.current.step === 1 && stale.data.current.node.id === 'b', '响应附带服务器现状');

      const good = await call('POST', `/api/sessions/${sessionV1}/choose`, { optionId: 'ob', step: 1 });
      ok(good.status === 200 && good.data.node.id === 'e' && good.data.status === 'ended', '正确步号推进到结局');

      const afterEnd = await call('POST', `/api/sessions/${sessionV1}/choose`, { optionId: 'ob', step: 2 });
      ok(afterEnd.status === 409, '结局后继续选择返回 409 不推进');

      // 条件不满足：用种子情境构造——n2 的 o4 要求 evacuated=false
      const { data } = await call('GET', '/api/scenarios');
      const seed = data.scenarios.find((s) => s.title.includes('反应釜'));
      const ss = await call('POST', '/api/sessions', { scenarioId: seed.id });
      const cur = ss.data;
      // 先疏散：evacuated=true
      const c = await call('POST', `/api/sessions/${cur.sessionId}/choose`, { optionId: 'o1', step: 0 });
      ok(c.status === 200 && c.data.node.id === 'n2', '第1步疏散后到 n2');
      ok(c.data.unavailableOptions.some((o) => o.id === 'o4'), '选项 o4 因疏散状态被锁定展示');
      const reject = await call('POST', `/api/sessions/${cur.sessionId}/choose`, { optionId: 'o4', step: 1 });
      ok(reject.status === 409 && reject.data.reason === 'condition_not_met', '条件不满足返回 409');
      ok(!!reject.data.message.includes('人员已疏散'), '返回具体不满足的条件原因');
      ok(reject.data.current.step === 1 && reject.data.current.node.id === 'n2', '被拒绝后会话不推进');

      // 并发双提交同一选项同一步号：只能一个成功
      const ss2 = (await call('POST', '/api/sessions', { scenarioId: seed.id })).data;
      const [rA, rB] = await Promise.all([
        call('POST', `/api/sessions/${ss2.sessionId}/choose`, { optionId: 'o1', step: 0 }),
        call('POST', `/api/sessions/${ss2.sessionId}/choose`, { optionId: 'o1', step: 0 })
      ]);
      const codes = [rA.status, rB.status].sort().join(',');
      ok(codes === '200,409', `并发同 step 双提交恰好一个成功（实际 ${codes}）`);
      const finalState = await call('GET', `/api/sessions/${ss2.sessionId}`);
      ok(finalState.data.step === 1, '并发后会话只推进了一次');

      // 路径记录完整
      ok(finalState.data.path.length === 1 && finalState.data.path[0].optionId === 'o1'
        && finalState.data.path[0].toNode.includes('压力'), '走过的路径被完整记录');

      // 不存在的选项
      const ss3 = (await call('POST', '/api/sessions', { scenarioId: seed.id })).data;
      const badOpt = await call('POST', `/api/sessions/${ss3.sessionId}/choose`, { optionId: 'nope', step: 0 });
      ok(badOpt.status === 409 && badOpt.data.reason === 'option_not_found', '非本节点选项返回 409 option_not_found');
    }

    // ===== 6. 未发布情境不能开始 =====
    console.log('\n[6] 其他边界');
    {
      const r = await call('POST', '/api/scenarios', { draft: linearDraft() });
      const noVer = await call('POST', '/api/sessions', { scenarioId: r.data.id });
      ok(noVer.status === 400 && noVer.data.error === 'not_published', '未发布情境不能开始会话');
    }
  } finally {
    proc.kill('SIGTERM');
    await wait(400);
  }

  console.log(`\n结果：${passed} 通过，${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
