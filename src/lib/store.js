
const { parseInstant, epochMillis, formatWithOffset } = require("./time");

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

const OBJECT_KINDS = ["artifact", "reproduction", "document", "digital"];
const SURFACE_KINDS = ["case", "document_slot", "digital_page"];
const CUSTODY_TYPES = ["loan_out", "repair_out", "return"];

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null);
  if (missing.length > 0) {
    throw new DomainError("validation", `缺少必填字段：${missing.join("、")}`);
  }
}

class Store {
  constructor(db, options = {}) {
    this.db = db;
    // 时钟可注入，便于在测试中固定“当前时刻”；生产环境取系统时钟。
    this.clock = options.clock || (() => Date.now());
  }

  now() {
    return formatWithOffset(new Date(this.clock()));
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------- 展品身份 ----------

  createObject(body) {
    requireFields(body, ["object_ref", "object_kind", "title", "source_ref", "custody_location"]);
    if (!OBJECT_KINDS.includes(body.object_kind)) {
      throw new DomainError("validation", `object_kind 必须是 ${OBJECT_KINDS.join("/")}`);
    }
    const at = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO exhibition_objects
             (object_ref, object_kind, title, source_ref, source_note,
              initial_dating_statement, initial_dating_basis,
              dating_statement, dating_basis, dating_status,
              custody_location, registered_location, site_eligibility,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'established', ?,?, 'on_site', ?,?)`
        )
        .run(
          body.object_ref,
          body.object_kind,
          body.title,
          body.source_ref,
          body.source_note ?? null,
          body.dating_statement ?? null,
          body.dating_basis ?? null,
          body.dating_statement ?? null,
          body.dating_basis ?? null,
          body.custody_location,
          body.custody_location,
          at,
          at
        );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("conflict", `展品编号已存在：${body.object_ref}`);
      }
      throw error;
    }
    return this.getObject(body.object_ref);
  }

  getObject(objectRef) {
    const row = this.db
      .prepare("SELECT * FROM exhibition_objects WHERE object_ref = ?")
      .get(objectRef);
    if (!row) {
      throw new DomainError("not_found", `展品不存在：${objectRef}`);
    }
    return row;
  }

  listObjects() {
    return this.db.prepare("SELECT * FROM exhibition_objects ORDER BY object_ref").all();
  }

  // ---------- 保管事件：外借 / 送修 / 回馆 ----------

  recordCustody(body) {
    requireFields(body, ["object_ref", "event_type", "location"]);
    if (!CUSTODY_TYPES.includes(body.event_type)) {
      throw new DomainError("validation", `event_type 必须是 ${CUSTODY_TYPES.join("/")}`);
    }
    const object = this.getObject(body.object_ref);
    const occurredAt = body.occurred_at ? body.occurred_at : this.now();
    parseInstant(occurredAt); // 校验
    const recordedAt = this.now();

    return this.tx(() => {
      const result = this.db
        .prepare(
          `INSERT INTO custody_events (object_ref, event_type, occurred_at, location, reason, recorded_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(body.object_ref, body.event_type, occurredAt, body.location, body.reason ?? null, recordedAt);

      const away = body.event_type === "loan_out" || body.event_type === "repair_out";
      this.db
        .prepare(
          `UPDATE exhibition_objects
              SET site_eligibility = ?, custody_location = ?, updated_at = ?
            WHERE object_ref = ?`
        )
        .run(away ? "away" : "on_site", body.location, recordedAt, body.object_ref);

      // 外借/送修立即取消现场资格：把当前与未来的开放排期在事件发生时刻封口。
      let closed = [];
      if (away) {
        const open = this.db
          .prepare(
            `SELECT id, starts_at FROM placements
              WHERE object_ref = ? AND ends_at IS NULL
                AND approval_status = 'approved'
                AND starts_at <= ?`
          )
          .all(body.object_ref, occurredAt);
        const closeStmt = this.db.prepare(
          "UPDATE placements SET ends_at = ? WHERE id = ? AND ends_at IS NULL"
        );
        closed = open.map((row) => {
          closeStmt.run(occurredAt, row.id);
          return row.id;
        });
      }
      return {
        custody_event_id: Number(result.lastInsertRowid),
        object_ref: body.object_ref,
        event_type: body.event_type,
        occurred_at: occurredAt,
        location: body.location,
        site_eligibility: away ? "away" : "on_site",
        closed_placement_ids: closed,
      };
    });
  }

  listCustody(objectRef) {
    this.getObject(objectRef);
    return this.db
      .prepare("SELECT * FROM custody_events WHERE object_ref = ? ORDER BY occurred_at, id")
      .all(objectRef);
  }

  // 任一时刻的保管状态复原（用于历史日期）。
  custodyAt(objectRef, atIso) {
    const object = this.getObject(objectRef);
    const event = this.db
      .prepare(
        `SELECT * FROM custody_events
          WHERE object_ref = ? AND occurred_at <= ?
          ORDER BY occurred_at DESC, id DESC LIMIT 1`
      )
      .get(objectRef, atIso);
    if (!event) {
      return { site_eligibility: "on_site", custody_location: object.registered_location, event: null };
    }
    const away = event.event_type === "loan_out" || event.event_type === "repair_out";
    return {
      site_eligibility: away ? "away" : "on_site",
      custody_location: event.location,
      event,
    };
  }

  // ---------- 年代更正：草稿 -> 审阅 -> 批准发布 / 驳回 ----------

  createCorrection(body) {
    requireFields(body, ["correction_ref", "object_ref", "proposed_statement"]);
    this.getObject(body.object_ref);
    const at = this.now();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO dating_corrections
             (correction_ref, object_ref, proposed_statement, proposed_basis,
              rationale, status, created_by, created_at)
           VALUES (?,?,?,?,?, 'draft', ?,?)`
        )
        .run(
          body.correction_ref,
          body.object_ref,
          body.proposed_statement,
          body.proposed_basis ?? null,
          body.rationale ?? null,
          body.created_by ?? null,
          at
        );
      return this.getCorrection(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("conflict", `更正编号已存在：${body.correction_ref}`);
      }
      throw error;
    }
  }

  getCorrection(idOrRef) {
    const row = /^\d+$/.test(String(idOrRef))
      ? this.db.prepare("SELECT * FROM dating_corrections WHERE id = ?").get(Number(idOrRef))
      : this.db.prepare("SELECT * FROM dating_corrections WHERE correction_ref = ?").get(idOrRef);
    if (!row) {
      throw new DomainError("not_found", `更正不存在：${idOrRef}`);
    }
    return row;
  }

  listCorrections(status) {
    if (status) {
      return this.db
        .prepare("SELECT * FROM dating_corrections WHERE status = ? ORDER BY id")
        .all(status);
    }
    return this.db.prepare("SELECT * FROM dating_corrections ORDER BY id").all();
  }

  submitCorrection(idOrRef, body = {}) {
    const correction = this.getCorrection(idOrRef);
    if (correction.status !== "draft") {
      throw new DomainError("invalid_state", `仅草稿可提交审阅，当前状态：${correction.status}`);
    }
    const at = body.at ? body.at : this.now();
    if (body.at) {
      parseInstant(body.at);
    }
    this.tx(() => {
      this.db
        .prepare("UPDATE dating_corrections SET status = 'submitted', submitted_at = ? WHERE id = ?")
        .run(at, correction.id);
      // 进入审阅期间，展品年代口径标记为“审阅中”，但已发布说法保持不变。
      this.db
        .prepare("UPDATE exhibition_objects SET dating_status = 'under_review', updated_at = ? WHERE object_ref = ?")
        .run(at, correction.object_ref);
    });
    return this.getCorrection(correction.id);
  }

  reviewCorrection(idOrRef, decision, body = {}) {
    if (!["approve", "reject"].includes(decision)) {
      throw new DomainError("validation", "decision 必须是 approve 或 reject");
    }
    const correction = this.getCorrection(idOrRef);
    if (correction.status !== "submitted") {
      throw new DomainError("invalid_state", `仅审阅中的更正可审批，当前状态：${correction.status}`);
    }
    const at = body.at ? body.at : this.now();
    if (body.at) {
      parseInstant(body.at);
    }
    return this.tx(() => {
      if (decision === "approve") {
        this.db
          .prepare(
            `UPDATE dating_corrections
                SET status = 'approved', reviewed_by = ?, reviewed_at = ?,
                    review_note = ?, published_at = ?
              WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, at, correction.id);
        // 批准后才覆盖已发布口径；此前观众始终读到旧说法。
        this.db
          .prepare(
            `UPDATE exhibition_objects
                SET dating_statement = ?, dating_basis = ?, dating_status = 'established',
                    updated_at = ?
              WHERE object_ref = ?`
          )
          .run(correction.proposed_statement, correction.proposed_basis, at, correction.object_ref);
      } else {
        this.db
          .prepare(
            `UPDATE dating_corrections
                SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
              WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, correction.id);
        this.db
          .prepare("UPDATE exhibition_objects SET dating_status = 'established', updated_at = ? WHERE object_ref = ?")
          .run(at, correction.object_ref);
      }
      return this.getCorrection(correction.id);
    });
  }

  // 任一时刻已发布的年代口径：取该时刻之前最新批准的更正；没有则用建账初值。
  datingAt(objectRef, atIso) {
    const object = this.getObject(objectRef);
    const correction = this.db
      .prepare(
        `SELECT * FROM dating_corrections
          WHERE object_ref = ? AND status = 'approved' AND published_at <= ?
          ORDER BY published_at DESC, id DESC LIMIT 1`
      )
      .get(objectRef, atIso);
    if (correction) {
      return {
        statement: correction.proposed_statement,
        basis: correction.proposed_basis,
        source: "correction",
        correction_ref: correction.correction_ref,
        published_at: correction.published_at,
      };
    }
    return {
      statement: object.initial_dating_statement,
      basis: object.initial_dating_basis,
      source: "initial",
    };
  }

  // ---------- 展签修订 ----------

  draftLabel(body) {
    requireFields(body, ["label_ref", "object_ref", "content"]);
    this.getObject(body.object_ref);
    const at = this.now();
    return this.tx(() => {
      const revisionRow = this.db
        .prepare("SELECT COALESCE(MAX(revision), 0) AS max_revision FROM labels WHERE object_ref = ?")
        .get(body.object_ref);
      const revision = revisionRow.max_revision + 1;
      try {
        const result = this.db
          .prepare(
            `INSERT INTO labels (label_ref, object_ref, revision, content, editor, status, created_at)
             VALUES (?,?,?,?,?, 'draft', ?)`
          )
          .run(body.label_ref, body.object_ref, revision, body.content, body.editor ?? null, at);
        return this.getLabel(Number(result.lastInsertRowid));
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
          throw new DomainError("conflict", `展签编号已存在：${body.label_ref}`);
        }
        throw error;
      }
    });
  }

  getLabel(idOrRef) {
    const row = /^\d+$/.test(String(idOrRef))
      ? this.db.prepare("SELECT * FROM labels WHERE id = ?").get(Number(idOrRef))
      : this.db.prepare("SELECT * FROM labels WHERE label_ref = ?").get(idOrRef);
    if (!row) {
      throw new DomainError("not_found", `展签不存在：${idOrRef}`);
    }
    return row;
  }

  listLabels(objectRef) {
    if (objectRef) {
      this.getObject(objectRef);
      return this.db.prepare("SELECT * FROM labels WHERE object_ref = ? ORDER BY revision").all(objectRef);
    }
    return this.db.prepare("SELECT * FROM labels ORDER BY object_ref, revision").all();
  }

  submitLabel(idOrRef, body = {}) {
    const label = this.getLabel(idOrRef);
    if (label.status !== "draft") {
      throw new DomainError("invalid_state", `仅草稿可提交审阅，当前状态：${label.status}`);
    }
    const at = body.at ? body.at : this.now();
    if (body.at) {
      parseInstant(body.at);
    }
    this.db
      .prepare("UPDATE labels SET status = 'submitted', submitted_at = ? WHERE id = ?")
      .run(at, label.id);
    return this.getLabel(label.id);
  }

  reviewLabel(idOrRef, decision, body = {}) {
    if (!["approve", "reject"].includes(decision)) {
      throw new DomainError("validation", "decision 必须是 approve 或 reject");
    }
    const label = this.getLabel(idOrRef);
    if (label.status !== "submitted") {
      throw new DomainError("invalid_state", `仅审阅中的展签可审批，当前状态：${label.status}`);
    }
    const at = body.at ? body.at : this.now();
    if (body.at) {
      parseInstant(body.at);
    }
    return this.tx(() => {
      if (decision === "approve") {
        // 上一版在新版发布时刻被替代；已发布记录本身不可变，不修改文案。
        this.db
          .prepare(
            `UPDATE labels SET superseded_at = ?
              WHERE object_ref = ? AND status = 'approved' AND superseded_at IS NULL`
          )
          .run(at, label.object_ref);
        this.db
          .prepare(
            `UPDATE labels SET status = 'approved', reviewed_by = ?, reviewed_at = ?,
                review_note = ?, published_at = ?
              WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, at, label.id);
      } else {
        this.db
          .prepare(
            `UPDATE labels SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
              WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, label.id);
      }
      return this.getLabel(label.id);
    });
  }

  // 任一时刻对某展品生效的展签（已发布且未被替代）。
  labelAt(objectRef, atIso) {
    return (
      this.db
        .prepare(
          `SELECT * FROM labels
            WHERE object_ref = ? AND status = 'approved'
              AND published_at <= ?
              AND (superseded_at IS NULL OR superseded_at > ?)
            ORDER BY revision DESC LIMIT 1`
        )
        .get(objectRef, atIso, atIso) || null
    );
  }

  // ---------- 叙事与展面 ----------

  createNarrative(body) {
    requireFields(body, ["narrative_ref", "title"]);
    const at = this.now();
    try {
      this.db
        .prepare("INSERT INTO narratives (narrative_ref, title, description, created_at) VALUES (?,?,?,?)")
        .run(body.narrative_ref, body.title, body.description ?? null, at);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("conflict", `叙事编号已存在：${body.narrative_ref}`);
      }
      throw error;
    }
    return this.db.prepare("SELECT * FROM narratives WHERE narrative_ref = ?").get(body.narrative_ref);
  }

  listNarratives() {
    return this.db.prepare("SELECT * FROM narratives ORDER BY narrative_ref").all();
  }

  createSurface(body) {
    requireFields(body, ["surface_ref", "surface_kind", "name"]);
    if (!SURFACE_KINDS.includes(body.surface_kind)) {
      throw new DomainError("validation", `surface_kind 必须是 ${SURFACE_KINDS.join("/")}`);
    }
    const at = this.now();
    try {
      this.db
        .prepare("INSERT INTO display_surfaces (surface_ref, surface_kind, name, created_at) VALUES (?,?,?,?)")
        .run(body.surface_ref, body.surface_kind, body.name, at);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("conflict", `展面编号已存在：${body.surface_ref}`);
      }
      throw error;
    }
    return this.db.prepare("SELECT * FROM display_surfaces WHERE surface_ref = ?").get(body.surface_ref);
  }

  listSurfaces() {
    return this.db.prepare("SELECT * FROM display_surfaces ORDER BY surface_ref").all();
  }

  // ---------- 排期与替代展项 ----------

  createPlacement(body) {
    requireFields(body, ["surface_ref", "object_ref"]);
    const surface = this.db
      .prepare("SELECT * FROM display_surfaces WHERE surface_ref = ?")
      .get(body.surface_ref);
    if (!surface) {
      throw new DomainError("not_found", `展面不存在：${body.surface_ref}`);
    }
    const object = this.getObject(body.object_ref);

    const startsAt = body.starts_at ? body.starts_at : this.now();
    const endsAt = body.ends_at ?? null;
    parseInstant(startsAt);
    if (endsAt) {
      parseInstant(endsAt);
      if (epochMillis(endsAt) <= epochMillis(startsAt)) {
        throw new DomainError("validation", "ends_at 必须晚于 starts_at");
      }
    }

    let labelRef = body.label_ref ?? null;
    if (labelRef) {
      const label = this.getLabel(labelRef);
      if (label.object_ref !== body.object_ref) {
        throw new DomainError("validation", "展签必须属于同一展品");
      }
    }
    let narrativeRef = body.narrative_ref ?? null;
    let replacesId = null;
    if (body.replaces_placement !== undefined && body.replaces_placement !== null) {
      replacesId = Number(body.replaces_placement);
      const predecessor = this.db.prepare("SELECT * FROM placements WHERE id = ?").get(replacesId);
      if (!predecessor) {
        throw new DomainError("not_found", `被替代排期不存在：${replacesId}`);
      }
      // 替代展项默认接上原排期的叙事线索。
      if (!narrativeRef) {
        narrativeRef = predecessor.narrative_ref;
      }
    }
    if (narrativeRef) {
      const narrative = this.db
        .prepare("SELECT * FROM narratives WHERE narrative_ref = ?")
        .get(narrativeRef);
      if (!narrative) {
        throw new DomainError("not_found", `叙事不存在：${narrativeRef}`);
      }
    }

    const approval = body.approval_status ?? "approved";
    if (!["pending", "approved", "rejected"].includes(approval)) {
      throw new DomainError("validation", "approval_status 必须是 pending/approved/rejected");
    }

    // 真品外借/送修期间不得取得现场资格（未来回馆后的预排仍允许）。
    if (approval === "approved" && object.site_eligibility === "away" && epochMillis(startsAt) <= this.clock()) {
      throw new DomainError(
        "invalid_state",
        `${object.object_ref} 正外借或送修，现场资格已取消，不能排入当前展面；可使用经审批的替代展项`
      );
    }

    return this.tx(() => {
      // 同一展面上，已批准排期不得时间重叠（待批与被拒不占场）。
      if (approval === "approved") {
        const overlap = this.db
          .prepare(
            `SELECT id FROM placements
              WHERE surface_ref = ? AND approval_status = 'approved'
                AND starts_at < ? AND (ends_at IS NULL OR ends_at > ?)`
          )
          .get(body.surface_ref, endsAt ?? "9999-12-31T23:59:59+00:00", startsAt);
        if (overlap) {
          throw new DomainError("conflict", `展面 ${body.surface_ref} 在该时段已有获批排期 #${overlap.id}`);
        }
      }
      const at = this.now();
      const result = this.db
        .prepare(
          `INSERT INTO placements
             (surface_ref, object_ref, label_ref, narrative_ref, starts_at, ends_at,
              approval_status, replaces_placement, requested_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          body.surface_ref,
          body.object_ref,
          labelRef,
          narrativeRef,
          startsAt,
          endsAt,
          approval,
          replacesId,
          body.requested_by ?? null,
          at
        );
      return this.db.prepare("SELECT * FROM placements WHERE id = ?").get(Number(result.lastInsertRowid));
    });
  }

  getPlacement(id) {
    const row = this.db.prepare("SELECT * FROM placements WHERE id = ?").get(Number(id));
    if (!row) {
      throw new DomainError("not_found", `排期不存在：${id}`);
    }
    return row;
  }

  listPlacements(query = {}) {
    const clauses = [];
    const params = [];
    if (query.surface_ref) {
      clauses.push("surface_ref = ?");
      params.push(query.surface_ref);
    }
    if (query.object_ref) {
      clauses.push("object_ref = ?");
      params.push(query.object_ref);
    }
    if (query.status) {
      clauses.push("approval_status = ?");
      params.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM placements ${where} ORDER BY starts_at, id`)
      .all(...params);
  }

  // 替代展项审批：获批后接上原叙事；同时把原排期在新排期开始时封口。
  reviewPlacement(id, decision, body = {}) {
    if (!["approve", "reject"].includes(decision)) {
      throw new DomainError("validation", "decision 必须是 approve 或 reject");
    }
    const placement = this.getPlacement(id);
    if (placement.approval_status !== "pending") {
      throw new DomainError("invalid_state", `仅待批排期可审批，当前状态：${placement.approval_status}`);
    }
    const at = this.now();
    return this.tx(() => {
      if (decision === "approve") {
        const object = this.getObject(placement.object_ref);
        if (
          object.site_eligibility === "away" &&
          epochMillis(placement.starts_at) <= this.clock()
        ) {
          throw new DomainError("invalid_state", "该展品正外借/送修，现场资格已取消，不能批准上场");
        }
        // 展面时段冲突检查。
        const overlap = this.db
          .prepare(
            `SELECT id FROM placements
              WHERE surface_ref = ? AND approval_status = 'approved' AND id != ?
                AND starts_at < ? AND (ends_at IS NULL OR ends_at > ?)`
          )
          .get(
            placement.surface_ref,
            placement.id,
            placement.ends_at ?? "9999-12-31T23:59:59+00:00",
            placement.starts_at
          );
        if (overlap) {
          throw new DomainError("conflict", `展面在该时段已有获批排期 #${overlap.id}`);
        }
        this.db
          .prepare(
            `UPDATE placements SET approval_status = 'approved', reviewed_by = ?,
                reviewed_at = ?, review_note = ? WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, placement.id);
        // 接上原叙事：同一展面上与新排期冲突的开放旧排期在 starts_at 封口。
        this.db
          .prepare(
            `UPDATE placements SET ends_at = ?
              WHERE surface_ref = ? AND id != ? AND ends_at IS NULL
                AND approval_status = 'approved' AND starts_at <= ?`
          )
          .run(placement.starts_at, placement.surface_ref, placement.id, placement.starts_at);
      } else {
        this.db
          .prepare(
            `UPDATE placements SET approval_status = 'rejected', reviewed_by = ?,
                reviewed_at = ?, review_note = ? WHERE id = ?`
          )
          .run(body.reviewed_by ?? null, at, body.review_note ?? null, placement.id);
      }
      return this.getPlacement(placement.id);
    });
  }

  // ---------- 发布视图：当前有效 / 任意历史日期复原 ----------

  // 组装某一时刻的全馆发布态：观众只读当前；内部可指定任意历史时刻。
  viewAt(atIso) {
    parseInstant(atIso);
    const surfaces = this.listSurfaces();
    const placementStmt = this.db.prepare(
      `SELECT * FROM placements
        WHERE surface_ref = ? AND approval_status = 'approved'
          AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY starts_at DESC LIMIT 1`
    );

    const surfaceViews = surfaces.map((surface) => {
      const placement = placementStmt.get(surface.surface_ref, atIso, atIso);
      // 排期虽覆盖该时刻，但展品若正外借/送修（away），物理上不可能在现场。
      if (!placement || this.custodyAt(placement.object_ref, atIso).site_eligibility === "away") {
        return {
          surface_ref: surface.surface_ref,
          surface_kind: surface.surface_kind,
          name: surface.name,
          placement: null,
        };
      }
      const object = this.getObject(placement.object_ref);
      const custody = this.custodyAt(object.object_ref, atIso);
      const dating = this.datingAt(object.object_ref, atIso);
      const label = this.labelAt(object.object_ref, atIso);
      return {
        surface_ref: surface.surface_ref,
        surface_kind: surface.surface_kind,
        name: surface.name,
        placement: {
          placement_id: placement.id,
          starts_at: placement.starts_at,
          ends_at: placement.ends_at,
          narrative_ref: placement.narrative_ref,
          replaces_placement: placement.replaces_placement,
          object: {
            object_ref: object.object_ref,
            object_kind: object.object_kind,
            title: object.title,
            source_ref: object.source_ref,
            custody_location: custody.custody_location,
            site_eligibility: custody.site_eligibility,
            dating: {
              statement: dating.statement,
              basis: dating.basis,
              source: dating.source,
              correction_ref: dating.correction_ref ?? null,
            },
          },
          label: label
            ? { label_ref: label.label_ref, revision: label.revision, content: label.content,
                published_at: label.published_at }
            : null,
        },
      };
    });

    return {
      effective_at: atIso,
      surfaces: surfaceViews,
    };
  }

  // 内部历史复原：除展面外，附上当日全部展品的身份、保管、年代与展签状态。
  asOf(atIso) {
    parseInstant(atIso);
    const view = this.viewAt(atIso);
    view.objects = this.listObjects().map((object) => {
      const custody = this.custodyAt(object.object_ref, atIso);
      const dating = this.datingAt(object.object_ref, atIso);
      const label = this.labelAt(object.object_ref, atIso);
      return {
        object_ref: object.object_ref,
        object_kind: object.object_kind,
        title: object.title,
        source_ref: object.source_ref,
        site_eligibility: custody.site_eligibility,
        custody_location: custody.custody_location,
        dating: {
          statement: dating.statement,
          basis: dating.basis,
          source: dating.source,
          correction_ref: dating.correction_ref ?? null,
        },
        current_label: label
          ? { label_ref: label.label_ref, revision: label.revision, content: label.content }
          : null,
      };
    });
    return view;
  }

  reviewQueue() {
    return {
      dating_corrections: this.db
        .prepare("SELECT * FROM dating_corrections WHERE status = 'submitted' ORDER BY id")
        .all(),
      labels: this.db
        .prepare("SELECT * FROM labels WHERE status = 'submitted' ORDER BY id")
        .all(),
      placements: this.db
        .prepare("SELECT * FROM placements WHERE approval_status = 'pending' ORDER BY id")
        .all(),
    };
  }
}

module.exports = { Store, DomainError };
