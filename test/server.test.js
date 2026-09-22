
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../src/server");

// 为每个测试服务分配独立临时数据库，避免用例间相互污染。
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "museum-"));
  const databasePath = path.join(dir, "test.sqlite3");
  // 固定“当前”为 2026-09-22 09:00（开馆时刻），保证时间敏感断言稳定。
  const fixedNow = Date.parse("2026-09-22T09:00:00+08:00");
  const server = createServer({ databasePath, clock: () => fixedNow });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });

  async function call(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }
  return { call, stop };
}

async function seedExhibition(call) {
  // 展面：展柜、文献位、触摸屏数字页
  await call("POST", "/v1/surfaces", {
    surface_ref: "CASE-GOLD-1",
    surface_kind: "case",
    name: "夹皮沟金脉展柜",
  });
  await call("POST", "/v1/surfaces", {
    surface_ref: "DOC-GOLD-1",
    surface_kind: "document_slot",
    name: "开采文献位",
  });
  await call("POST", "/v1/surfaces", {
    surface_ref: "SCREEN-GOLD-1",
    surface_kind: "digital_page",
    name: "触摸屏·淘金牛脉",
  });

  // 叙事线索
  await call("POST", "/v1/narratives", {
    narrative_ref: "NARR-GOLD-RUSH",
    title: "夹皮沟淘金热",
    description: "从矿脉发现到实物开采的叙事链。",
  });

  // 四种身份：真品金条、复制金条、历史文献、数字影像
  const objects = {};
  for (const object of [
    {
      object_ref: "OBJ-BAR-REAL",
      object_kind: "artifact",
      title: "夹皮沟金条（真品）",
      source_ref: "sha256:9f2c1a",
      source_note: "入藏登记 A-1948",
      dating_statement: "清末民初",
      dating_basis: "馆藏旧账与矿口传承",
      custody_location: "金库 B-12",
    },
    {
      object_ref: "OBJ-BAR-REPRO",
      object_kind: "reproduction",
      title: "金条复制件",
      source_ref: "REF:REPRO-2026-03",
      custody_location: "复制件库房 R-2",
    },
    {
      object_ref: "OBJ-DOC-LEDGER",
      object_kind: "document",
      title: "开采账簿（民国）",
      source_ref: "REF:ARCHIVE-77",
      dating_statement: "民国二十六年",
      dating_basis: "账簿纪年与纸张鉴定",
      custody_location: "文献柜 D-5",
    },
    {
      object_ref: "OBJ-DIGI-STORY",
      object_kind: "digital",
      title: "淘金牛脉数字影像",
      source_ref: "sha256:41be77",
      custody_location: "数字资产库 DAM",
    },
  ]) {
    const { status, body } = await call("POST", "/v1/objects", object);
    assert.equal(status, 201, JSON.stringify(body));
    objects[object.object_ref] = body;
  }
  return objects;
}

async function publishLabel(call, objectRef, labelRef, content, at) {
  const draft = await call("POST", "/v1/labels", {
    label_ref: labelRef,
    object_ref: objectRef,
    content,
    editor: "策展组",
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const submitted = await call("POST", `/v1/labels/${labelRef}/submit`, at ? { at } : {});
  assert.equal(submitted.status, 200);
  const reviewed = await call("POST", `/v1/labels/${labelRef}/review`, {
    decision: "approve",
    reviewed_by: "馆长",
    ...(at ? { at } : {}),
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  return reviewed.body;
}

test("健康接口返回服务状态", async () => {
  const { call, stop } = await startServer();
  try {
    const { status, body } = await call("GET", "/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok" });
  } finally {
    await stop();
  }
});

test("开馆场景：真品、文献、数字影像按各自身份就位，观众读到当前有效版本", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(call, "OBJ-BAR-REAL", "LBL-BAR-1", "清末民初金条，出土于夹皮沟矿脉。");

    // 昨天 10:00 三条排期同时上线
    const launch = "2026-09-21T10:00:00+08:00";
    for (const placement of [
      {
        surface_ref: "CASE-GOLD-1",
        object_ref: "OBJ-BAR-REAL",
        label_ref: "LBL-BAR-1",
        narrative_ref: "NARR-GOLD-RUSH",
        starts_at: launch,
      },
      {
        surface_ref: "DOC-GOLD-1",
        object_ref: "OBJ-DOC-LEDGER",
        narrative_ref: "NARR-GOLD-RUSH",
        starts_at: launch,
      },
      {
        surface_ref: "SCREEN-GOLD-1",
        object_ref: "OBJ-DIGI-STORY",
        narrative_ref: "NARR-GOLD-RUSH",
        starts_at: launch,
      },
    ]) {
      const { status, body } = await call("POST", "/v1/placements", placement);
      assert.equal(status, 201, JSON.stringify(body));
    }

    const nowView = await call("GET", "/public/now");
    assert.equal(nowView.status, 200);
    const byRef = Object.fromEntries(nowView.body.surfaces.map((s) => [s.surface_ref, s]));
    assert.equal(byRef["CASE-GOLD-1"].placement.object.object_ref, "OBJ-BAR-REAL");
    assert.equal(byRef["CASE-GOLD-1"].placement.object.object_kind, "artifact");
    assert.equal(byRef["DOC-GOLD-1"].placement.object.object_kind, "document");
    assert.equal(byRef["SCREEN-GOLD-1"].placement.object.object_kind, "digital");
    // 观众看到已发布年代与展签
    assert.equal(
      byRef["CASE-GOLD-1"].placement.object.dating.statement,
      "清末民初"
    );
    assert.equal(byRef["CASE-GOLD-1"].placement.label.revision, 1);
  } finally {
    await stop();
  }
});

test("送修立即取消真品现场资格并撤下展柜；外借同样生效", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(call, "OBJ-BAR-REAL", "LBL-BAR-1", "清末民初金条。");
    await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      label_ref: "LBL-BAR-1",
      narrative_ref: "NARR-GOLD-RUSH",
      starts_at: "2026-09-21T10:00:00+08:00",
    });

    // 开馆前发现金条已送修
    const repair = await call("POST", "/v1/objects/OBJ-BAR-REAL/custody", {
      event_type: "repair_out",
      occurred_at: "2026-09-22T06:30:00+08:00",
      location: "省文保修复中心",
      reason: "表面稳定处理",
    });
    assert.equal(repair.status, 201, JSON.stringify(repair.body));
    assert.equal(repair.body.site_eligibility, "away");
    assert.ok(repair.body.closed_placement_ids.length >= 1, "真品排期应被立即封口");

    // 观众当前视图：展柜空位
    const nowView = await call("GET", "/public/now");
    const goldCase = nowView.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement, null, "送修真品必须从现场撤下");

    // 真品状态与保管位置可查
    const object = await call("GET", "/v1/objects/OBJ-BAR-REAL");
    assert.equal(object.body.site_eligibility, "away");
    assert.equal(object.body.custody_location, "省文保修复中心");

    // 送修期间不得把真品排回当前展柜
    const blocked = await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      starts_at: "2026-09-22T09:00:00+08:00",
    });
    assert.equal(blocked.status, 409);

    // 触摸屏上的数字影像不依赖真品本体，仍然在线
    await call("POST", "/v1/placements", {
      surface_ref: "SCREEN-GOLD-1",
      object_ref: "OBJ-DIGI-STORY",
      narrative_ref: "NARR-GOLD-RUSH",
      starts_at: "2026-09-21T10:00:00+08:00",
    });
    const stillOnline = await call("GET", "/public/now");
    const screen = stillOnline.body.surfaces.find((s) => s.surface_ref === "SCREEN-GOLD-1");
    assert.equal(screen.placement.object.object_ref, "OBJ-DIGI-STORY");

    // 回馆后现场资格恢复
    const returned = await call("POST", "/v1/objects/OBJ-BAR-REAL/custody", {
      event_type: "return",
      occurred_at: "2026-10-01T09:00:00+08:00",
      location: "金库 B-12",
    });
    assert.equal(returned.body.site_eligibility, "on_site");
  } finally {
    await stop();
  }
});

test("经审批的替代展项接上原叙事；未审批不露面，被拒不占场", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(call, "OBJ-BAR-REAL", "LBL-BAR-1", "清末民初金条。");
    const original = await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      label_ref: "LBL-BAR-1",
      narrative_ref: "NARR-GOLD-RUSH",
      starts_at: "2026-09-21T10:00:00+08:00",
    });
    const originalId = original.body.id;

    await call("POST", "/v1/objects/OBJ-BAR-REAL/custody", {
      event_type: "repair_out",
      occurred_at: "2026-09-22T06:30:00+08:00",
      location: "省文保修复中心",
    });

    // 提交复制件替代展项（待批），并接上原排期
    const substitute = await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REPRO",
      replaces_placement: originalId,
      starts_at: "2026-09-22T08:30:00+08:00",
      approval_status: "pending",
      requested_by: "策展人",
    });
    assert.equal(substitute.status, 201);
    assert.equal(substitute.body.narrative_ref, "NARR-GOLD-RUSH", "应自动继承原叙事");

    // 批准前观众看不到
    let view = await call("GET", "/public/now");
    let goldCase = view.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement, null);

    const review = await call("POST", `/v1/placements/${substitute.body.id}/review`, {
      decision: "approve",
      reviewed_by: "馆务委员会",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));

    // 批准后观众看到复制件，叙事线索仍是同一条，身份明确标为 reproduction
    view = await call("GET", "/public/now");
    goldCase = view.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement.object.object_ref, "OBJ-BAR-REPRO");
    assert.equal(goldCase.placement.object.object_kind, "reproduction");
    assert.equal(goldCase.placement.narrative_ref, "NARR-GOLD-RUSH");
    assert.equal(goldCase.placement.replaces_placement, originalId);

    // 原排期在送修发生的 06:30 即被封口（06:30 至替代项 08:30 之间为现场空窗）
    const old = await call("GET", `/v1/placements/${originalId}`);
    assert.equal(old.body.ends_at, "2026-09-22T06:30:00+08:00");
  } finally {
    await stop();
  }
});

test("年代更正先进审阅：发布前观众读旧说法，批准后才覆盖，驳回不改已发布口径", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(call, "OBJ-BAR-REAL", "LBL-BAR-1", "清末民初金条。");
    await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      label_ref: "LBL-BAR-1",
      starts_at: "2026-09-21T10:00:00+08:00",
    });

    // 研究员提出更正：年代改为“清代中期（乾隆年间）”
    const correction = await call("POST", "/v1/corrections", {
      correction_ref: "CORR-BAR-DATE-1",
      object_ref: "OBJ-BAR-REAL",
      proposed_statement: "清代中期（乾隆年间）",
      proposed_basis: "新见矿税档案与成分检测",
      rationale: "旧账纪年被重新释读",
      created_by: "研究员李某",
    });
    assert.equal(correction.status, 201);
    const submitted = await call("POST", "/v1/corrections/CORR-BAR-DATE-1/submit", {});
    assert.equal(submitted.status, 200);

    // 审阅期间：展品当前口径仍是旧说法，且出现在审阅队列
    let view = await call("GET", "/public/now");
    let goldCase = view.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement.object.dating.statement, "清末民初");
    const queue = await call("GET", "/v1/review-queue");
    assert.ok(
      queue.body.dating_corrections.some((c) => c.correction_ref === "CORR-BAR-DATE-1")
    );

    // 驳回：已发布说法不变
    const rejected = await call("POST", "/v1/corrections/CORR-BAR-DATE-1/review", {
      decision: "reject",
      reviewed_by: "学术委员会",
      review_note: "证据链不完整",
    });
    assert.equal(rejected.status, 200);
    view = await call("GET", "/public/now");
    goldCase = view.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement.object.dating.statement, "清末民初");

    // 重新提交一份并批准：观众读到新口径
    const correction2 = await call("POST", "/v1/corrections", {
      correction_ref: "CORR-BAR-DATE-2",
      object_ref: "OBJ-BAR-REAL",
      proposed_statement: "清代中期（乾隆年间）",
      proposed_basis: "补充矿税档案、成分检测与旁证文献",
    });
    assert.equal(correction2.status, 201);
    await call("POST", "/v1/corrections/CORR-BAR-DATE-2/submit", {});
    const approved = await call("POST", "/v1/corrections/CORR-BAR-DATE-2/review", {
      decision: "approve",
      reviewed_by: "学术委员会",
    });
    assert.equal(approved.status, 200);
    view = await call("GET", "/public/now");
    goldCase = view.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement.object.dating.statement, "清代中期（乾隆年间）");
    assert.equal(goldCase.placement.object.dating.source, "correction");
  } finally {
    await stop();
  }
});

test("展签演进：修订经发布后才对观众生效，历史日期复原当日所见文案", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(
      call,
      "OBJ-BAR-REAL",
      "LBL-BAR-1",
      "清末民初金条。",
      "2026-09-10T09:00:00+08:00"
    );
    await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      label_ref: "LBL-BAR-1",
      starts_at: "2026-09-11T09:00:00+08:00",
    });

    // 新展签草稿与审阅阶段，观众仍读到第 1 版
    const draft = await call("POST", "/v1/labels", {
      label_ref: "LBL-BAR-2",
      object_ref: "OBJ-BAR-REAL",
      content: "清代中期金条，反映夹皮沟官矿开采。",
    });
    assert.equal(draft.body.revision, 2);
    await call("POST", "/v1/labels/LBL-BAR-2/submit", { at: "2026-09-15T09:00:00+08:00" });

    const before = await call(
      "GET",
      "/internal/as-of?at=2026-09-16T12:00:00%2B08:00"
    );
    const caseBefore = before.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(caseBefore.placement.label.content, "清末民初金条。");

    await call("POST", "/v1/labels/LBL-BAR-2/review", {
      decision: "approve",
      reviewed_by: "馆长",
      at: "2026-09-18T09:00:00+08:00",
    });

    // 今天读到第 2 版
    const nowView = await call("GET", "/public/now");
    const goldCase = nowView.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(goldCase.placement.label.revision, 2);

    // 复原 9 月 12 日：仍应是第 1 版展签
    const old = await call(
      "GET",
      "/internal/as-of?at=2026-09-12T12:00:00%2B08:00"
    );
    const oldCase = old.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(oldCase.placement.label.revision, 1);
    assert.equal(oldCase.placement.label.content, "清末民初金条。");
  } finally {
    await stop();
  }
});

test("内部按历史日期复原：昨日展柜有真品，今日送修后展柜空、触摸屏仍有数字影像", async () => {
  const { call, stop } = await startServer();
  try {
    await seedExhibition(call);
    await publishLabel(call, "OBJ-BAR-REAL", "LBL-BAR-1", "清末民初金条。");
    await call("POST", "/v1/placements", {
      surface_ref: "CASE-GOLD-1",
      object_ref: "OBJ-BAR-REAL",
      label_ref: "LBL-BAR-1",
      narrative_ref: "NARR-GOLD-RUSH",
      starts_at: "2026-09-21T10:00:00+08:00",
    });
    await call("POST", "/v1/placements", {
      surface_ref: "SCREEN-GOLD-1",
      object_ref: "OBJ-DIGI-STORY",
      narrative_ref: "NARR-GOLD-RUSH",
      starts_at: "2026-09-21T10:00:00+08:00",
    });
    await call("POST", "/v1/objects/OBJ-BAR-REAL/custody", {
      event_type: "repair_out",
      occurred_at: "2026-09-22T06:30:00+08:00",
      location: "省文保修复中心",
    });

    // 复原 9 月 21 日 15:00：展柜是真品、保管位置为金库
    const yesterday = await call(
      "GET",
      "/internal/as-of?at=2026-09-21T15:00:00%2B08:00"
    );
    assert.equal(yesterday.status, 200);
    const yCase = yesterday.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(yCase.placement.object.object_ref, "OBJ-BAR-REAL");
    assert.equal(yCase.placement.object.site_eligibility, "on_site");
    assert.equal(yCase.placement.object.custody_location, "金库 B-12");
    const yReal = yesterday.body.objects.find((o) => o.object_ref === "OBJ-BAR-REAL");
    assert.equal(yReal.site_eligibility, "on_site");

    // 复原 9 月 22 日开馆时：展柜空，真品在修复中心；数字页仍在
    const today = await call("GET", "/internal/as-of?at=2026-09-22T09:00:00%2B08:00");
    const tCase = today.body.surfaces.find((s) => s.surface_ref === "CASE-GOLD-1");
    assert.equal(tCase.placement, null);
    const tReal = today.body.objects.find((o) => o.object_ref === "OBJ-BAR-REAL");
    assert.equal(tReal.site_eligibility, "away");
    assert.equal(tReal.custody_location, "省文保修复中心");
    const tScreen = today.body.surfaces.find((s) => s.surface_ref === "SCREEN-GOLD-1");
    assert.equal(tScreen.placement.object.object_ref, "OBJ-DIGI-STORY");

    // 必须带时区，朴素时间被拒绝
    const bad = await call("GET", "/internal/as-of?at=2026-09-22T09:00:00");
    assert.equal(bad.status, 400);
  } finally {
    await stop();
  }
});
