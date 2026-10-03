'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      draft       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id              TEXT PRIMARY KEY,
      scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      version_no      INTEGER NOT NULL,
      frozen_content  TEXT NOT NULL,
      published_at    TEXT NOT NULL,
      UNIQUE(scenario_id, version_no)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      scenario_id    TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      version_id     TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      current_node   TEXT NOT NULL,
      state_mask     INTEGER NOT NULL,
      step           INTEGER NOT NULL DEFAULT 0,
      path           TEXT NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_versions_scenario ON versions(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_version  ON sessions(version_id);
  `);

  seed();
  return db;
}

function get() {
  if (!db) throw new Error('database not initialized');
  return db;
}

// 首次启动写入一个可直接使用的完整示例情境（化工反应釜事故），并发布 v1。
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c;
  if (count > 0) return;

  const { randomUUID } = require('crypto');
  const now = new Date().toISOString();
  const id = randomUUID();

  const draft = {
    title: '化工反应釜超压事故处置',
    states: [
      { id: 'evacuated', label: '人员已疏散', initial: false },
      { id: 'valve_closed', label: '进料阀已关闭', initial: false },
      { id: 'vented', label: '已泄压排空', initial: false },
      { id: 'fire', label: '发生燃烧', initial: false },
      { id: 'injured', label: '有人员受伤', initial: false }
    ],
    nodes: [
      {
        id: 'n1', title: '中控室报警', isEnd: false,
        text: '反应釜压力、温度持续攀升，DCS 发出超压报警。现场有两名巡检工。值班调度长请下达第一道指令。',
        options: [
          { id: 'o1', text: '立即组织现场人员紧急疏散', requires: [], sets: [{ state: 'evacuated', value: true }], next: 'n2' },
          { id: 'o2', text: '先不关进料阀，派人继续观察', requires: [], sets: [{ state: 'injured', value: true }], next: 'n2' }
        ]
      },
      {
        id: 'n2', title: '压力继续上升', isEnd: false,
        text: '压力仍在上升，必须切断进料。',
        options: [
          { id: 'o3', text: '远程关闭进料切断阀', requires: [], sets: [{ state: 'valve_closed', value: true }], next: 'n3' },
          {
            id: 'o4', text: '派巡检工就地关闭手动阀',
            requires: [{ state: 'evacuated', value: false }],
            sets: [{ state: 'valve_closed', value: true }, { state: 'injured', value: true }], next: 'n3'
          }
        ]
      },
      {
        id: 'n3', title: '泄压决策', isEnd: false,
        text: '进料已切断，但釜内压力仍未回落。应急排空系统可将物料泄放至火炬。',
        options: [
          { id: 'o5', text: '启动应急排空，泄放至火炬', requires: [{ state: 'valve_closed', value: true }], sets: [{ state: 'vented', value: true }], next: 'n5' },
          { id: 'o6', text: '暂不泄压，等待自然降温', requires: [], sets: [{ state: 'fire', value: true }], next: 'n4' }
        ]
      },
      {
        id: 'n4', title: '密封件过热起火', isEnd: false,
        text: '高温导致密封垫片起火，现场出现明火。',
        options: [
          { id: 'o7', text: '立即泄压排空并用消防炮压制', requires: [{ state: 'fire', value: true }], sets: [{ state: 'vented', value: true }], next: 'n5' },
          { id: 'o8', text: '盲目组织进入火场施救', requires: [{ state: 'fire', value: true }, { state: 'evacuated', value: false }], sets: [{ state: 'injured', value: true }], next: 'n4' }
        ]
      },
      {
        id: 'n5', title: '应急结束评估', isEnd: false,
        text: '压力恢复正常，明火得到控制。清点人员并评估处置过程。',
        options: [
          {
            id: 'o9', text: '无人受伤，完成封场',
            requires: [{ state: 'injured', value: false }], sets: [], next: 'good_end'
          },
          {
            id: 'o10', text: '有伤员，送医并启动事故调查',
            requires: [{ state: 'injured', value: true }], sets: [], next: 'injury_end'
          }
        ]
      },
      { id: 'good_end', title: '处置成功：无人伤亡，事故受控', isEnd: true, text: '处置流程规范，反应釜安全受控，现场无人员伤亡。', options: [] },
      { id: 'injury_end', title: '结局：险情控制但有人员受伤', isEnd: true, text: '事故最终受控，但处置过程中出现人员受伤，需复盘改进。', options: [] }
    ],
    start: 'n1'
  };

  db.prepare(`INSERT INTO scenarios (id, title, draft, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`).run(id, draft.title, JSON.stringify(draft), now, now);

  const vid = randomUUID();
  db.prepare(`INSERT INTO versions (id, scenario_id, version_no, frozen_content, published_at)
              VALUES (?, ?, 1, ?, ?)`).run(vid, id, JSON.stringify(draft), now);

  return { scenarioId: id, versionId: vid };
}

module.exports = { init, get };
