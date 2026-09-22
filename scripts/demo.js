
// 可运行的开馆前场景重演：
//   node scripts/demo.js
// 使用独立数据文件 data/demo.sqlite3，重复执行会重建。

const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/lib/db");
const { Store } = require("../src/lib/store");

const demoDbPath = path.join(process.cwd(), "data", "demo.sqlite3");
fs.rmSync(demoDbPath, { force: true });
const db = openDatabase(demoDbPath);

// 固定“此刻”为开馆当日 2026-09-22 09:30；历史事件显式带时间。
const NOW = "2026-09-22T09:30:00+08:00";
const store = new Store(db, { clock: () => Date.parse(NOW) });

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

// 1) 建立展面与叙事
heading("建立展面：展柜 / 文献位 / 触摸屏数字页");
store.createSurface({ surface_ref: "CASE-GOLD-1", surface_kind: "case", name: "夹皮沟金脉展柜" });
store.createSurface({ surface_ref: "DOC-GOLD-1", surface_kind: "document_slot", name: "开采文献位" });
store.createSurface({ surface_ref: "SCREEN-GOLD-1", surface_kind: "digital_page", name: "触摸屏·淘金牛脉" });

store.createNarrative({
  narrative_ref: "NARR-GOLD-RUSH",
  title: "夹皮沟淘金热",
  description: "从矿脉发现到实物开采的叙事链。",
});

// 2) 登记四种身份的展品
heading("登记展品：真品 / 复制件 / 历史文献 / 数字影像");
store.createObject({
  object_ref: "OBJ-BAR-REAL",
  object_kind: "artifact",
  title: "夹皮沟金条（真品）",
  source_ref: "sha256:9f2c1a",
  source_note: "入藏登记 A-1948",
  dating_statement: "清末民初",
  dating_basis: "馆藏旧账与矿口传承",
  custody_location: "金库 B-12",
});
store.createObject({
  object_ref: "OBJ-BAR-REPRO",
  object_kind: "reproduction",
  title: "金条复制件",
  source_ref: "REF:REPRO-2026-03",
  custody_location: "复制件库房 R-2",
});
store.createObject({
  object_ref: "OBJ-DOC-LEDGER",
  object_kind: "document",
  title: "开采账簿（民国）",
  source_ref: "REF:ARCHIVE-77",
  dating_statement: "民国二十六年",
  dating_basis: "账簿纪年与纸张鉴定",
  custody_location: "文献柜 D-5",
});
store.createObject({
  object_ref: "OBJ-DIGI-STORY",
  object_kind: "digital",
  title: "淘金牛脉数字影像",
  source_ref: "sha256:41be77",
  custody_location: "数字资产库 DAM",
});

// 3) 昨天完成布展：真品进展柜、文献入位、数字影像上触摸屏
heading("2026-09-21 布展上线");
const label = store.draftLabel({
  label_ref: "LBL-BAR-1",
  object_ref: "OBJ-BAR-REAL",
  content: "清末民初金条，出土于夹皮沟矿脉。",
  editor: "策展组",
});
store.submitLabel(label.id, { at: "2026-09-20T10:00:00+08:00" });
store.reviewLabel(label.id, "approve", { reviewed_by: "馆长", at: "2026-09-20T15:00:00+08:00" });

const launch = "2026-09-21T10:00:00+08:00";
store.createPlacement({
  surface_ref: "CASE-GOLD-1",
  object_ref: "OBJ-BAR-REAL",
  label_ref: "LBL-BAR-1",
  narrative_ref: "NARR-GOLD-RUSH",
  starts_at: launch,
});
store.createPlacement({
  surface_ref: "DOC-GOLD-1",
  object_ref: "OBJ-DOC-LEDGER",
  narrative_ref: "NARR-GOLD-RUSH",
  starts_at: launch,
});
store.createPlacement({
  surface_ref: "SCREEN-GOLD-1",
  object_ref: "OBJ-DIGI-STORY",
  narrative_ref: "NARR-GOLD-RUSH",
  starts_at: launch,
});

// 4) 今天清晨：真品金条送修
heading("2026-09-22 06:30 发现真品金条已送修");
const custody = store.recordCustody({
  object_ref: "OBJ-BAR-REAL",
  event_type: "repair_out",
  occurred_at: "2026-09-22T06:30:00+08:00",
  location: "省文保修复中心",
  reason: "表面稳定处理",
});
console.log("真品现场资格：", custody.site_eligibility, "；被封口的排期：", custody.closed_placement_ids);

// 5) 策展人申请复制件替展，委员会 08:30 批准
heading("2026-09-22 08:30 复制件替展获批，接上原叙事");
const substitute = store.createPlacement({
  surface_ref: "CASE-GOLD-1",
  object_ref: "OBJ-BAR-REPRO",
  replaces_placement: 1,
  starts_at: "2026-09-22T08:30:00+08:00",
  approval_status: "pending",
  requested_by: "策展人",
});
store.reviewPlacement(substitute.id, "approve", {
  reviewed_by: "馆务委员会",
  review_note: "真品送修期间以复制件维持叙事完整",
});

// 6) 研究员提出年代更正，但还在审阅中
heading("研究更正进入审阅（尚未发布，观众仍读旧说法）");
const correction = store.createCorrection({
  correction_ref: "CORR-BAR-DATE-1",
  object_ref: "OBJ-BAR-REAL",
  proposed_statement: "清代中期（乾隆年间）",
  proposed_basis: "新见矿税档案与成分检测",
  rationale: "旧账纪年被重新释读",
  created_by: "研究员李某",
});
store.submitCorrection(correction.id, {});

// 7) 观众当前视图
heading("观众视图 GET /public/now（当前有效版本）");
for (const surface of store.viewAt(NOW).surfaces) {
  if (!surface.placement) {
    console.log(`· [${surface.surface_kind}] ${surface.name}：（空置）`);
    continue;
  }
  const kindName = { artifact: "真品", reproduction: "复制件", document: "文献", digital: "数字影像" };
  console.log(
    `· [${surface.surface_kind}] ${surface.name}：${surface.placement.object.title}` +
      `（${kindName[surface.placement.object.object_kind]}）` +
      `｜保管：${surface.placement.object.custody_location}` +
      `｜年代：${surface.placement.object.dating.statement ?? "—"}` +
      `｜叙事：${surface.placement.narrative_ref ?? "—"}`
  );
}

// 8) 内部历史复原：昨天 vs 今天
heading("内部复原 2026-09-21 15:00（昨天）");
const yesterday = store.asOf("2026-09-21T15:00:00+08:00");
const yCase = yesterday.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
console.log(
  `展柜：${yCase.placement.object.title}｜资格：${yCase.placement.object.site_eligibility}` +
    `｜展签：第 ${yCase.placement.label.revision} 版「${yCase.placement.label.content}」`
);

heading("内部复原 2026-09-22 09:30（今天开馆）");
const today = store.asOf("2026-09-22T09:30:00+08:00");
for (const surface of today.surfaces) {
  if (!surface.placement) {
    console.log(`· ${surface.name}：空置`);
    continue;
  }
  const p = surface.placement;
  console.log(
    `· ${surface.name}：${p.object.title}（${p.object.object_kind}）` +
      `｜保管：${p.object.custody_location}｜叙事：${p.narrative_ref ?? "—"}` +
      (p.replaces_placement ? `｜接替原排期 #${p.replaces_placement}` : "")
  );
}
// 再复原空窗时刻 07:00：真品已撤、复制件未批
const gap = store.asOf("2026-09-22T07:00:00+08:00");
const gapCase = gap.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
console.log(`复刻 07:00 空窗：展柜${gapCase.placement ? "仍有展项（异常）" : "确认为空置"}，真品在「${
  gap.objects.find((o) => o.object_ref === "OBJ-BAR-REAL").custody_location
}」`);
const queue = store.reviewQueue();
console.log(
  `审阅队列待处理：年代更正 ${queue.dating_corrections.length} 条、展签 ${queue.labels.length} 条、替展 ${queue.placements.length} 条`
);

db.close();
console.log(`\n演示完成，数据保存在 ${demoDbPath}`);
