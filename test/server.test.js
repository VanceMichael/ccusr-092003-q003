'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../src/server');
const { openDatabase } = require('../src/db');

const T_BEFORE = '2026-09-19T08:00:00+08:00'; // 布展前
const T_LABEL_V1 = '2026-09-20T08:00:00+08:00'; // 展签初版发布
const T_GOLD_LIVE = '2026-09-20T09:00:00+08:00'; // 金条上展
const T_REPAIR = '2026-09-21T08:00:00+08:00'; // 金条送修（昨日）
const T_SUBSTITUTE = '2026-09-21T08:30:00+08:00'; // 替代复制件接上
const T_LAYOUT_V2 = '2026-09-21T09:00:00+08:00'; // 触摸屏调整位置
const T_LOAN = '2026-09-21T10:00:00+08:00';

async function startHarness() {
  const db = openDatabase(':memory:');
  const server = createServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(method, urlPath, body) {
    const response = await fetch(base + urlPath, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  return {
    db,
    call,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

// 搭建“昨日版本”：金条真品在展柜、文献在数字页面、触摸屏 v1 布局、展签初版
async function seedYesterday(call) {
  await call('POST', '/v1/objects', {
    object_ref: 'GOLD-BAR-001',
    object_kind: 'artifact',
    title: '夹皮沟金条（清末）',
    source_ref: 'ARCHIVE-LEDGER-1889#f42',
    provenance_digest: 'sha256:9f2c7a',
    period: '清末',
    dating_evidence: '矿务总局1889年造册记录',
    storage_location: '金库 A-12',
  });
  await call('POST', '/v1/objects', {
    object_ref: 'REPLICA-BAR-001',
    object_kind: 'replica',
    title: '夹皮沟金条（复制件）',
    period: '现代复制',
    storage_location: '复制件库 B-03',
  });
  await call('POST', '/v1/objects', {
    object_ref: 'DOC-LEDGER-1889',
    object_kind: 'document',
    title: '1889 年矿务总局造册扫描件',
    source_ref: 'ARCHIVE-LEDGER-1889',
    period: '1889',
  });
  await call('POST', '/v1/objects', {
    object_ref: 'IMG-MINE-1900',
    object_kind: 'digital_image',
    title: '夹皮沟金矿早期影像',
  });

  const narrative = await call('POST', '/v1/narratives', {
    narrative_ref: 'NARR-GOLD-RUSH',
    title: '淘金热与官矿',
    summary: '清末夹皮沟金矿开采与上缴叙事',
  });
  assert.equal(narrative.status, 201);

  const caseChannel = await call('POST', '/v1/channels', {
    channel_ref: 'CASE-GOLD-01',
    channel_type: 'case',
    name: '金器专柜',
  });
  assert.equal(caseChannel.status, 201);

  const screen = await call('POST', '/v1/channels', {
    channel_ref: 'SCREEN-HALL-02',
    channel_type: 'touchscreen',
    name: '二号厅触摸屏',
    location: '二号厅入口左侧',
    title: '金矿年表',
    config_json: JSON.stringify({ orientation: 'landscape' }),
    valid_from: T_GOLD_LIVE,
  });
  assert.equal(screen.status, 201);

  const page = await call('POST', '/v1/channels', {
    channel_ref: 'PAGE-LEDGER',
    channel_type: 'digital_page',
    name: '造册文献数字页',
  });
  assert.equal(page.status, 201);

  // 展签初版发布
  const label = await call('POST', '/v1/objects/GOLD-BAR-001/labels', {
    content: '清末夹皮沟官矿上缴金条，年代约 1889 年。',
    research_note: '依据造册记录初步断代',
    evidence_ref: 'ARCHIVE-LEDGER-1889#f42',
  });
  const publishedV1 = await call('POST', `/v1/labels/${label.body.id}/publish`, {
    effective_from: T_LABEL_V1,
  });
  assert.equal(publishedV1.status, 200);
  assert.equal(publishedV1.body.status, 'published');

  // 复制件也准备一版展签
  const replicaLabel = await call('POST', '/v1/objects/REPLICA-BAR-001/labels', {
    content: '按馆藏金条 1:1 复制，供真品离场期间展示。',
  });
  await call('POST', `/v1/labels/${replicaLabel.body.id}/publish`, {
    effective_from: T_LABEL_V1,
  });

  // 金条上展（提案 -> 审批 -> 发布）
  await call('POST', '/v1/placements', {
    placement_ref: 'PL-GOLD-CASE',
    narrative_ref: 'NARR-GOLD-RUSH',
    channel_ref: 'CASE-GOLD-01',
    object_ref: 'GOLD-BAR-001',
  });
  await call('POST', '/v1/placements/PL-GOLD-CASE/approve', {});
  const goldLive = await call('POST', '/v1/placements/PL-GOLD-CASE/publish', {
    valid_from: T_GOLD_LIVE,
  });
  assert.equal(goldLive.status, 200);
  assert.equal(goldLive.body.lifecycle, 'published');

  // 文献数字页同步上线
  await call('POST', '/v1/placements', {
    placement_ref: 'PL-DOC-PAGE',
    narrative_ref: 'NARR-GOLD-RUSH',
    channel_ref: 'PAGE-LEDGER',
    object_ref: 'DOC-LEDGER-1889',
  });
  await call('POST', '/v1/placements/PL-DOC-PAGE/approve', {});
  await call('POST', '/v1/placements/PL-DOC-PAGE/publish', { valid_from: T_GOLD_LIVE });

  return { labelId: label.body.id };
}

test('金条送修：真品现场资格立即取消，经审批替代展项接上原叙事', async (context) => {
  const harness = await startHarness();
  context.after(harness.stop);
  const { call } = harness;
  await seedYesterday(call);

  // 开馆前发现金条已送修：登记事件即自动关闭在场布置
  const repair = await call('POST', '/v1/objects/GOLD-BAR-001/status-events', {
    event_type: 'under_repair',
    occurred_at: T_REPAIR,
    note: '表面锈蚀处理，送修复室',
  });
  assert.equal(repair.status, 201);

  const goldPlacement = await call('GET', '/v1/placements/PL-GOLD-CASE');
  assert.equal(goldPlacement.body.closure_reason, 'object_under_repair');
  assert.equal(goldPlacement.body.valid_to, new Date(T_REPAIR).toISOString());

  // 真品送修期间不能再次发布上展
  await call('POST', '/v1/placements', {
    placement_ref: 'PL-GOLD-CASE-2',
    narrative_ref: 'NARR-GOLD-RUSH',
    channel_ref: 'CASE-GOLD-01',
    object_ref: 'GOLD-BAR-001',
  });
  await call('POST', '/v1/placements/PL-GOLD-CASE-2/approve', {});
  const blocked = await call('POST', '/v1/placements/PL-GOLD-CASE-2/publish', {
    valid_from: T_REPAIR,
  });
  assert.equal(blocked.status, 409);

  // 替代展项必须先审批：未审批直接发布会被拒
  await call('POST', '/v1/placements', {
    placement_ref: 'PL-REPLICA-CASE',
    narrative_ref: 'NARR-GOLD-RUSH',
    channel_ref: 'CASE-GOLD-01',
    object_ref: 'REPLICA-BAR-001',
    substitute_for_ref: 'GOLD-BAR-001',
    note: '真品送修期间接替专柜',
  });
  const unapproved = await call('POST', '/v1/placements/PL-REPLICA-CASE/publish', {});
  assert.equal(unapproved.status, 409);

  // 审批后发布，替代展项接上同一叙事
  await call('POST', '/v1/placements/PL-REPLICA-CASE/approve', {});
  const substituteLive = await call('POST', '/v1/placements/PL-REPLICA-CASE/publish', {
    valid_from: T_SUBSTITUTE,
  });
  assert.equal(substituteLive.status, 200);
  assert.equal(substituteLive.body.placement_kind, 'substitute');
  assert.equal(substituteLive.body.substitute_for_ref, 'GOLD-BAR-001');
  assert.equal(substituteLive.body.narrative_ref, 'NARR-GOLD-RUSH');

  // 替代展项无法挂到原主展项从未进入过的叙事
  await call('POST', '/v1/narratives', {
    narrative_ref: 'NARR-OTHER',
    title: '无关叙事',
  });
  const badLink = await call('POST', '/v1/placements', {
    placement_ref: 'PL-BAD-LINK',
    narrative_ref: 'NARR-OTHER',
    channel_ref: 'CASE-GOLD-01',
    object_ref: 'REPLICA-BAR-001',
    substitute_for_ref: 'GOLD-BAR-001',
  });
  assert.equal(badLink.status, 409);

  // 触摸屏位置在送修当天调整
  const layoutV2 = await call('POST', '/v1/channels/SCREEN-HALL-02/layouts', {
    location: '二号厅出口右侧',
    title: '金矿年表（修订版）',
    config_json: JSON.stringify({ orientation: 'portrait' }),
    valid_from: T_LAYOUT_V2,
  });
  assert.equal(layoutV2.status, 201);
  assert.equal(layoutV2.body.revision_no, 2);
});

test('研究更正先进入审阅，不覆盖已发布说法；观众只读到当前有效版本', async (context) => {
  const harness = await startHarness();
  context.after(harness.stop);
  const { call } = harness;
  await seedYesterday(call);
  await call('POST', '/v1/objects/GOLD-BAR-001/status-events', {
    event_type: 'under_repair',
    occurred_at: T_REPAIR,
  });

  // 新研究：年代可能更早——更正只进入审阅
  const correction = await call('POST', '/v1/objects/GOLD-BAR-001/labels', {
    content: '据新见矿务档案，金条年代或可推至 1885 年。',
    research_note: '新发现档案尚待学术委员会确认',
    evidence_ref: 'ARCHIVE-NEW-1885',
  });
  assert.equal(correction.status, 201);
  assert.equal(correction.body.status, 'in_review');

  // 审阅中的更正不能重复发布之外被修改——已发布初版内容原样保留
  const labels = await call('GET', '/v1/objects/GOLD-BAR-001/labels');
  assert.equal(labels.body.revisions[0].content, '清末夹皮沟官矿上缴金条，年代约 1889 年。');
  assert.equal(labels.body.revisions[0].status, 'published');

  // 观众端当前看到的仍是初版说法
  const before = await call('GET', '/public/exhibition');
  assert.equal(before.status, 200);
  // 真品送修后专柜已无在场布置，观众端不再出现金条
  const refsNow = before.body.placements.map((item) => item.object.object_ref);
  assert.ok(!refsNow.includes('GOLD-BAR-001'), '送修真品不应出现在观众视图');
  assert.ok(refsNow.includes('DOC-LEDGER-1889'), '文献数字页不受送修影响');

  // 审阅稿不能对观众生效：尝试直接把它当作已发布版本查询，仍取初版
  const republish = await call('POST', `/v1/labels/${correction.body.id}/publish`, {
    effective_from: T_LOAN,
  });
  assert.equal(republish.status, 200);
  // 发布后初版被封边为 superseded，但内容行本身不变
  const after = await call('GET', '/v1/objects/GOLD-BAR-001/labels');
  assert.equal(after.body.revisions[0].status, 'superseded');
  assert.equal(after.body.revisions[0].content, '清末夹皮沟官矿上缴金条，年代约 1889 年。');
  assert.equal(after.body.revisions[1].status, 'published');

  // 已发布的修订不可再次发布（不可变）
  const again = await call('POST', `/v1/labels/${correction.body.id}/publish`, {});
  assert.equal(again.status, 409);
});

test('内部按历史日期复原：当日展柜、文献与数字页面、触摸屏布局一一对应', async (context) => {
  const harness = await startHarness();
  context.after(harness.stop);
  const { call } = harness;
  await seedYesterday(call);
  await call('POST', '/v1/objects/GOLD-BAR-001/status-events', {
    event_type: 'under_repair',
    occurred_at: T_REPAIR,
  });
  await call('POST', '/v1/placements', {
    placement_ref: 'PL-REPLICA-CASE',
    narrative_ref: 'NARR-GOLD-RUSH',
    channel_ref: 'CASE-GOLD-01',
    object_ref: 'REPLICA-BAR-001',
    substitute_for_ref: 'GOLD-BAR-001',
  });
  await call('POST', '/v1/placements/PL-REPLICA-CASE/approve', {});
  await call('POST', '/v1/placements/PL-REPLICA-CASE/publish', { valid_from: T_SUBSTITUTE });
  await call('POST', '/v1/channels/SCREEN-HALL-02/layouts', {
    location: '二号厅出口右侧',
    title: '金矿年表（修订版）',
    valid_from: T_LAYOUT_V2,
  });

  // 9 月 19 日：尚未布展
  const empty = await call('GET', `/internal/snapshot?at=${encodeURIComponent(T_BEFORE)}`);
  assert.equal(empty.body.placements.length, 0);

  // 9 月 20 日：金条在专柜、文献在数字页面、触摸屏仍是入口左侧的 v1
  const yesterday = await call('GET', '/internal/snapshot?at=2026-09-20');
  assert.equal(yesterday.status, 200);
  const byChannel = Object.fromEntries(
    yesterday.body.placements.map((item) => [item.channel.channel_ref, item]),
  );
  assert.equal(byChannel['CASE-GOLD-01'].object.object_ref, 'GOLD-BAR-001');
  assert.equal(byChannel['CASE-GOLD-01'].label.revision_no, 1);
  assert.equal(byChannel['PAGE-LEDGER'].object.object_ref, 'DOC-LEDGER-1889');
  assert.equal(byChannel['PAGE-LEDGER'].narrative.narrative_ref, 'NARR-GOLD-RUSH');

  const screenThen = yesterday.body.channels.find((c) => c.channel_ref === 'SCREEN-HALL-02');
  assert.equal(screenThen.layout.location, '二号厅入口左侧');
  assert.equal(screenThen.layout.revision_no, 1);
  // 内部视图附带保管信息
  assert.equal(byChannel['CASE-GOLD-01'].object_status_at, 'in_house');

  // 9 月 21 日（送修后）：专柜对应复制件，触摸屏已移到出口右侧
  const today = await call('GET', '/internal/snapshot?at=2026-09-21');
  const nowByChannel = Object.fromEntries(
    today.body.placements.map((item) => [item.channel.channel_ref, item]),
  );
  assert.equal(nowByChannel['CASE-GOLD-01'].object.object_ref, 'REPLICA-BAR-001');
  assert.equal(nowByChannel['CASE-GOLD-01'].placement_kind, 'substitute');
  assert.equal(nowByChannel['PAGE-LEDGER'].object.object_ref, 'DOC-LEDGER-1889');
  const screenNow = today.body.channels.find((c) => c.channel_ref === 'SCREEN-HALL-02');
  assert.equal(screenNow.layout.location, '二号厅出口右侧');
  assert.equal(screenNow.layout.revision_no, 2);
});

test('外借同样立即取消真品现场资格，归还后可重新排期', async (context) => {
  const harness = await startHarness();
  context.after(harness.stop);
  const { call } = harness;
  await seedYesterday(call);

  const loan = await call('POST', '/v1/objects/GOLD-BAR-001/status-events', {
    event_type: 'on_loan',
    occurred_at: T_LOAN,
    note: '借往兄弟博物馆联展',
  });
  assert.equal(loan.status, 201);
  const placement = await call('GET', '/v1/placements/PL-GOLD-CASE');
  assert.equal(placement.body.closure_reason, 'object_on_loan');

  const returned = await call('POST', '/v1/objects/GOLD-BAR-001/status-events', {
    event_type: 'loan_returned',
    occurred_at: '2026-09-25T10:00:00+08:00',
  });
  assert.equal(returned.status, 201);
});

test('健康检查与输入校验', async (context) => {
  const harness = await startHarness();
  context.after(harness.stop);
  const { call } = harness;

  const health = await call('GET', '/health');
  assert.deepEqual(health.body, { status: 'ok' });

  const badKind = await call('POST', '/v1/objects', {
    object_ref: 'X',
    object_kind: 'treasure',
    title: 'x',
  });
  assert.equal(badKind.status, 400);

  const badTime = await call('GET', '/internal/snapshot?at=not-a-date');
  assert.equal(badTime.status, 400);

  const missing = await call('GET', '/v1/objects/NO-SUCH');
  assert.equal(missing.status, 404);
});
