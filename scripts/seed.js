'use strict';

// 将 fixtures/example.json 中的演示场景写入数据库（幂等：已存在的编号会跳过）
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { Store } = require('../src/store');

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.sqlite3');
const fixture = require('../fixtures/example.json');

const db = openDatabase(databasePath);
const store = new Store(db);

const existing = store.listObjects().length;
if (existing > 0) {
  db.close();
  console.log(`数据库已有 ${existing} 件藏品，跳过示例写入（如需重建请使用空数据库）`);
  process.exit(0);
}

let applied = 0;

function run(step) {
  switch (step.op) {
    case 'register_object':
      return store.registerObject(step.body);
    case 'create_narrative':
      return store.createNarrative(step.body);
    case 'create_channel':
      return store.createChannel(step.body);
    case 'propose_label':
      return store.proposeLabel(step.object_ref, step.body);
    case 'propose_and_publish_label': {
      const label = store.proposeLabel(step.object_ref, step.body);
      return store.publishLabel(label.id, { effective_from: step.effective_from });
    }
    case 'full_placement': {
      const placement = store.proposePlacement(step.body);
      store.approvePlacement(placement.placement_ref);
      return store.publishPlacement(placement.placement_ref, { valid_from: step.valid_from });
    }
    case 'status_event':
      return store.recordStatusEvent(step.object_ref, step.body);
    case 'add_layout':
      return store.addLayout(step.channel_ref, step.body);
    default:
      throw new Error(`未知操作：${step.op}`);
  }
}

for (const step of fixture.steps) {
  run(step);
  applied += 1;
}

db.close();
console.log(`示例数据写入完成：${applied} 步（数据库 ${databasePath}）`);
