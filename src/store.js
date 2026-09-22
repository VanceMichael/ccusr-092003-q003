'use strict';

const { ValidationError, NotFoundError, ConflictError } = require('./errors');
const { normalizeInstant } = require('./time');

const OBJECT_KINDS = ['artifact', 'replica', 'document', 'digital_image'];
const EVENT_TYPES = ['in_house', 'on_loan', 'under_repair', 'loan_returned', 'repair_returned'];
const CHANNEL_TYPES = ['case', 'touchscreen', 'digital_page'];

function nowIso() {
  return new Date().toISOString();
}

function requireString(body, field, label = field) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label}为必填项`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- 藏品 ----------

  registerObject(body) {
    const objectRef = requireString(body, 'object_ref', '藏品编号');
    const objectKind = requireString(body, 'object_kind', '藏品身份类型');
    if (!OBJECT_KINDS.includes(objectKind)) {
      throw new ValidationError(`object_kind 必须是 ${OBJECT_KINDS.join(' / ')} 之一`);
    }
    const title = requireString(body, 'title', '名称');
    const restorationStatus = body.restoration_status || 'none';
    if (!['none', 'under_repair', 'restored'].includes(restorationStatus)) {
      throw new ValidationError('restoration_status 取值非法');
    }
    try {
      this.db
        .prepare(
          `INSERT INTO collection_objects (
             object_ref, object_kind, title, source_ref, provenance_digest,
             period, dating_evidence, storage_location, restoration_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          objectRef,
          objectKind,
          title,
          optionalString(body.source_ref),
          optionalString(body.provenance_digest),
          optionalString(body.period),
          optionalString(body.dating_evidence),
          optionalString(body.storage_location),
          restorationStatus,
          nowIso(),
        );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new ConflictError(`藏品编号已存在：${objectRef}`);
      }
      throw error;
    }
    return this.getObject(objectRef);
  }

  getObject(objectRef) {
    const row = this.db
      .prepare('SELECT * FROM collection_objects WHERE object_ref = ?')
      .get(objectRef);
    if (!row) throw new NotFoundError(`藏品不存在：${objectRef}`);
    return row;
  }

  listObjects() {
    return this.db.prepare('SELECT * FROM collection_objects ORDER BY object_ref').all();
  }

  // ---------- 保管状态事件（外借 / 送修立即取消真品现场资格） ----------

  recordStatusEvent(objectRef, body) {
    this.getObject(objectRef);
    const eventType = requireString(body, 'event_type', '事件类型');
    if (!EVENT_TYPES.includes(eventType)) {
      throw new ValidationError(`event_type 必须是 ${EVENT_TYPES.join(' / ')} 之一`);
    }
    const occurredAt = normalizeInstant(body.occurred_at || nowIso(), 'occurred_at');

    const result = this.db
      .prepare(
        `INSERT INTO status_events (object_ref, event_type, occurred_at, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(objectRef, eventType, occurredAt, optionalString(body.note), nowIso());

    if (eventType === 'under_repair') {
      this.db
        .prepare(
          `UPDATE collection_objects SET restoration_status = 'under_repair'
           WHERE object_ref = ?`,
        )
        .run(objectRef);
    } else if (eventType === 'repair_returned') {
      this.db
        .prepare(
          `UPDATE collection_objects SET restoration_status = 'restored'
           WHERE object_ref = ?`,
        )
        .run(objectRef);
    }

    // 外借或送修：立即关闭该真品当前所有在场布置
    if (eventType === 'on_loan' || eventType === 'under_repair') {
      this.closeObjectPlacements(objectRef, occurredAt, eventType);
    }

    return this.db.prepare('SELECT * FROM status_events WHERE id = ?').get(result.lastInsertRowid);
  }

  closeObjectPlacements(objectRef, occurredAt, reason) {
    const openPlacements = this.db
      .prepare(
        `SELECT * FROM placements
         WHERE object_ref = ? AND lifecycle = 'published' AND valid_to IS NULL`,
      )
      .all(objectRef);
    const reasonText = reason === 'on_loan' ? 'object_on_loan' : 'object_under_repair';
    for (const placement of openPlacements) {
      // 事件时间早于布展开始时间时，布置实际未产生过在场区间
      const closedAt = occurredAt >= placement.valid_from ? occurredAt : placement.valid_from;
      this.db
        .prepare(
          `UPDATE placements SET valid_to = ?, closure_reason = ? WHERE id = ?`,
        )
        .run(closedAt, reasonText, placement.id);
    }
    return openPlacements.length;
  }

  listStatusEvents(objectRef) {
    this.getObject(objectRef);
    return this.db
      .prepare('SELECT * FROM status_events WHERE object_ref = ? ORDER BY occurred_at, id')
      .all(objectRef);
  }

  // 截至某刻藏品的最新保管状态
  statusAt(objectRef, at) {
    const row = this.db
      .prepare(
        `SELECT * FROM status_events
         WHERE object_ref = ? AND occurred_at <= ?
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      )
      .get(objectRef, at);
    return row ? row.event_type : 'in_house';
  }

  // ---------- 叙事节点 ----------

  createNarrative(body) {
    const narrativeRef = requireString(body, 'narrative_ref', '叙事编号');
    const title = requireString(body, 'title', '叙事标题');
    try {
      this.db
        .prepare('INSERT INTO narratives (narrative_ref, title, summary, created_at) VALUES (?, ?, ?, ?)')
        .run(narrativeRef, title, optionalString(body.summary), nowIso());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new ConflictError(`叙事编号已存在：${narrativeRef}`);
      }
      throw error;
    }
    return this.db.prepare('SELECT * FROM narratives WHERE narrative_ref = ?').get(narrativeRef);
  }

  listNarratives() {
    return this.db.prepare('SELECT * FROM narratives ORDER BY narrative_ref').all();
  }

  getNarrative(narrativeRef) {
    const row = this.db.prepare('SELECT * FROM narratives WHERE narrative_ref = ?').get(narrativeRef);
    if (!row) throw new NotFoundError(`叙事不存在：${narrativeRef}`);
    return row;
  }

  // ---------- 展陈渠道（展柜 / 触摸屏 / 数字页面） ----------

  createChannel(body) {
    const channelRef = requireString(body, 'channel_ref', '渠道编号');
    const channelType = requireString(body, 'channel_type', '渠道类型');
    if (!CHANNEL_TYPES.includes(channelType)) {
      throw new ValidationError(`channel_type 必须是 ${CHANNEL_TYPES.join(' / ')} 之一`);
    }
    const name = requireString(body, 'name', '渠道名称');
    try {
      this.db
        .prepare('INSERT INTO channels (channel_ref, channel_type, name, created_at) VALUES (?, ?, ?, ?)')
        .run(channelRef, channelType, name, nowIso());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new ConflictError(`渠道编号已存在：${channelRef}`);
      }
      throw error;
    }
    const channel = this.db.prepare('SELECT * FROM channels WHERE channel_ref = ?').get(channelRef);
    // 建渠道时可附首版布局
    if (body.location || body.title || body.config_json) {
      this.#addLayout(channelRef, {
        valid_from: body.valid_from || nowIso(),
        title: body.title,
        location: body.location,
        config_json: body.config_json,
      });
    }
    return channel;
  }

  listChannels() {
    return this.db.prepare('SELECT * FROM channels ORDER BY channel_ref').all();
  }

  getChannel(channelRef) {
    const row = this.db.prepare('SELECT * FROM channels WHERE channel_ref = ?').get(channelRef);
    if (!row) throw new NotFoundError(`渠道不存在：${channelRef}`);
    return row;
  }

  // ---------- 渠道布局版本（触摸屏位置 / 页面配置的演进） ----------

  addLayout(channelRef, body) {
    this.getChannel(channelRef);
    return this.#addLayout(channelRef, body);
  }

  #addLayout(channelRef, body) {
    const validFrom = normalizeInstant(body.valid_from || nowIso(), 'valid_from');
    const revisionNo =
      (this.db
        .prepare('SELECT COALESCE(MAX(revision_no), 0) AS m FROM channel_layouts WHERE channel_ref = ?')
        .get(channelRef).m || 0) + 1;

    const future = this.db
      .prepare(
        `SELECT * FROM channel_layouts
         WHERE channel_ref = ? AND valid_to IS NULL AND valid_from > ?`,
      )
      .all(channelRef, validFrom);
    if (future.length > 0) {
      throw new ConflictError('已存在更晚生效的布局版本，不能在其之前插入新版本');
    }
    this.db
      .prepare('UPDATE channel_layouts SET valid_to = ? WHERE channel_ref = ? AND valid_to IS NULL AND valid_from <= ?')
      .run(validFrom, channelRef, validFrom);

    const result = this.db
      .prepare(
        `INSERT INTO channel_layouts (channel_ref, revision_no, title, location, config_json, valid_from)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channelRef,
        revisionNo,
        optionalString(body.title),
        optionalString(body.location),
        optionalString(body.config_json),
        validFrom,
      );
    return this.db.prepare('SELECT * FROM channel_layouts WHERE id = ?').get(result.lastInsertRowid);
  }

  listLayouts(channelRef) {
    this.getChannel(channelRef);
    return this.db
      .prepare('SELECT * FROM channel_layouts WHERE channel_ref = ? ORDER BY valid_from')
      .all(channelRef);
  }

  layoutAt(channelRef, at) {
    return this.db
      .prepare(
        `SELECT * FROM channel_layouts
         WHERE channel_ref = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(channelRef, at, at);
  }

  // ---------- 展签修订（研究更正先进审阅；发布后不可变；新版封边旧版） ----------

  proposeLabel(objectRef, body) {
    this.getObject(objectRef);
    const content = requireString(body, 'content', '展签内容');
    const revisionNo =
      (this.db
        .prepare('SELECT COALESCE(MAX(revision_no), 0) AS m FROM label_revisions WHERE object_ref = ?')
        .get(objectRef).m || 0) + 1;
    const result = this.db
      .prepare(
        `INSERT INTO label_revisions (
           object_ref, revision_no, content, research_note, evidence_ref,
           status, created_at
         ) VALUES (?, ?, ?, ?, ?, 'in_review', ?)`,
      )
      .run(
        objectRef,
        revisionNo,
        content,
        optionalString(body.research_note),
        optionalString(body.evidence_ref),
        nowIso(),
      );
    return this.db.prepare('SELECT * FROM label_revisions WHERE id = ?').get(result.lastInsertRowid);
  }

  listLabels(objectRef) {
    this.getObject(objectRef);
    return this.db
      .prepare('SELECT * FROM label_revisions WHERE object_ref = ? ORDER BY revision_no')
      .all(objectRef);
  }

  getLabel(id) {
    const row = this.db.prepare('SELECT * FROM label_revisions WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`展签修订不存在：${id}`);
    return row;
  }

  publishLabel(id, body) {
    const label = this.getLabel(id);
    if (label.status !== 'in_review') {
      throw new ConflictError(`只有审阅中的展签可以发布，当前状态：${label.status}`);
    }
    const effectiveFrom = normalizeInstant(
      body.effective_from || nowIso(),
      'effective_from',
    );

    const current = this.db
      .prepare(
        `SELECT effective_from FROM label_revisions
         WHERE object_ref = ? AND status = 'published' LIMIT 1`,
      )
      .get(label.object_ref);
    if (current && effectiveFrom < current.effective_from) {
      throw new ConflictError('新版展签生效时间不能早于当前已发布版本');
    }

    const tx = this.db.prepare(
      `UPDATE label_revisions
       SET status = 'published', effective_from = ?, published_at = ?
       WHERE id = ? AND status = 'in_review'`,
    );
    this.db.exec('BEGIN');
    try {
      const result = tx.run(effectiveFrom, nowIso(), id);
      if (result.changes === 0) {
        throw new ConflictError('展签状态已变化，发布失败');
      }
      // 新版封边旧版：旧版有效期在新版生效时结束。已发布内容本身永不修改。
      this.db
        .prepare(
          `UPDATE label_revisions
           SET status = 'superseded', superseded_at = ?
           WHERE object_ref = ? AND status = 'published' AND id <> ?`,
        )
        .run(effectiveFrom, label.object_ref, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getLabel(id);
  }

  // 观众视角：某刻生效的已发布展签（在审阅的更正不会出现）
  effectiveLabel(objectRef, at) {
    return this.db
      .prepare(
        `SELECT * FROM label_revisions
         WHERE object_ref = ? AND status = 'published'
           AND effective_from <= ?
           AND (superseded_at IS NULL OR superseded_at > ?)
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(objectRef, at, at);
  }

  // ---------- 展项布置（提案 -> 审批 -> 发布；撤下 / 自动关闭） ----------

  proposePlacement(body) {
    const placementRef = requireString(body, 'placement_ref', '布置编号');
    const narrativeRef = requireString(body, 'narrative_ref', '叙事编号');
    const channelRef = requireString(body, 'channel_ref', '渠道编号');
    const objectRef = requireString(body, 'object_ref', '藏品编号');
    this.getNarrative(narrativeRef);
    this.getChannel(channelRef);
    this.getObject(objectRef);

    const substituteFor = optionalString(body.substitute_for_ref);
    const placementKind = substituteFor ? 'substitute' : body.placement_kind || 'primary';
    if (!['primary', 'substitute'].includes(placementKind)) {
      throw new ValidationError('placement_kind 必须是 primary / substitute');
    }
    if (placementKind === 'substitute' && !substituteFor) {
      throw new ValidationError('替代展项必须提供 substitute_for_ref');
    }
    if (substituteFor) {
      this.getObject(substituteFor);
      // “接上原叙事”：原主展项必须曾在同一叙事下发布过
      const linked = this.db
        .prepare(
          `SELECT 1 FROM placements
           WHERE object_ref = ? AND narrative_ref = ? AND lifecycle = 'published'
           LIMIT 1`,
        )
        .get(substituteFor, narrativeRef);
      if (!linked) {
        throw new ConflictError(
          `替代展项无法接上叙事：${substituteFor} 未在叙事 ${narrativeRef} 下发布过`,
        );
      }
    }

    try {
      const result = this.db
        .prepare(
          `INSERT INTO placements (
             placement_ref, narrative_ref, channel_ref, object_ref, substitute_for_ref,
             placement_kind, lifecycle, note, proposed_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
        )
        .run(
          placementRef,
          narrativeRef,
          channelRef,
          objectRef,
          substituteFor,
          placementKind,
          optionalString(body.note),
          nowIso(),
        );
      return this.db.prepare('SELECT * FROM placements WHERE id = ?').get(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new ConflictError(`布置编号已存在：${placementRef}`);
      }
      throw error;
    }
  }

  getPlacement(placementRef) {
    const row = this.db.prepare('SELECT * FROM placements WHERE placement_ref = ?').get(placementRef);
    if (!row) throw new NotFoundError(`布置不存在：${placementRef}`);
    return row;
  }

  listPlacements(query = {}) {
    const where = [];
    const params = [];
    if (query.channel_ref) {
      where.push('channel_ref = ?');
      params.push(query.channel_ref);
    }
    if (query.narrative_ref) {
      where.push('narrative_ref = ?');
      params.push(query.narrative_ref);
    }
    if (query.object_ref) {
      where.push('object_ref = ?');
      params.push(query.object_ref);
    }
    if (query.lifecycle) {
      where.push('lifecycle = ?');
      params.push(query.lifecycle);
    }
    const sql = `SELECT * FROM placements ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY COALESCE(valid_from, proposed_at), id`;
    return this.db.prepare(sql).all(...params);
  }

  #transitionPlacement(placementRef, fromLifecycle, toLifecycle, whenColumn) {
    const placement = this.getPlacement(placementRef);
    if (placement.lifecycle !== fromLifecycle) {
      throw new ConflictError(
        `布置当前状态为 ${placement.lifecycle}，不能从 ${fromLifecycle} 转为 ${toLifecycle}`,
      );
    }
    const sets = ['lifecycle = ?'];
    const params = [toLifecycle];
    if (whenColumn) {
      sets.push(`${whenColumn} = ?`);
      params.push(nowIso());
    }
    params.push(placement.id);
    this.db.prepare(`UPDATE placements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getPlacement(placementRef);
  }

  approvePlacement(placementRef) {
    return this.#transitionPlacement(placementRef, 'proposed', 'approved', 'approved_at');
  }

  rejectPlacement(placementRef, body = {}) {
    const placement = this.#transitionPlacement(placementRef, 'proposed', 'rejected', null);
    if (body.reason) {
      this.db.prepare('UPDATE placements SET note = ? WHERE id = ?').run(
        `${placement.note ? `${placement.note} | ` : ''}驳回：${body.reason}`,
        placement.id,
      );
    }
    return this.getPlacement(placementRef);
  }

  publishPlacement(placementRef, body = {}) {
    const placement = this.getPlacement(placementRef);
    if (placement.lifecycle !== 'approved') {
      throw new ConflictError(`只有审批通过的布置可以发布，当前状态：${placement.lifecycle}`);
    }
    const validFrom = normalizeInstant(body.valid_from || nowIso(), 'valid_from');

    const object = this.getObject(placement.object_ref);
    if (object.object_kind === 'artifact') {
      const currentStatus = this.statusAt(object.object_ref, validFrom);
      if (currentStatus === 'on_loan' || currentStatus === 'under_repair') {
        throw new ConflictError(
          `真品当前处于${currentStatus === 'on_loan' ? '外借' : '送修'}状态，不具备现场资格`,
        );
      }
    }

    // 同一展陈渠道同一时刻只能呈现一个展项
    const futureBlocker = this.db
      .prepare(
        `SELECT * FROM placements
         WHERE channel_ref = ? AND lifecycle = 'published' AND valid_to IS NULL
           AND valid_from > ?`,
      )
      .get(placement.channel_ref, validFrom);
    if (futureBlocker) {
      throw new ConflictError(
        `渠道已排有更晚开始的在场布置 ${futureBlocker.placement_ref}，请先调整排期`,
      );
    }

    this.db.exec('BEGIN');
    try {
      // 新排期封边旧排期（展柜排期更新）
      this.db
        .prepare(
          `UPDATE placements
           SET valid_to = ?, closure_reason = 'rescheduled'
           WHERE channel_ref = ? AND lifecycle = 'published' AND valid_to IS NULL
             AND valid_from <= ?`,
        )
        .run(validFrom, placement.channel_ref, validFrom);
      this.db
        .prepare(
          `UPDATE placements
           SET lifecycle = 'published', published_at = ?, valid_from = ?
           WHERE id = ? AND lifecycle = 'approved'`,
        )
        .run(nowIso(), validFrom, placement.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getPlacement(placementRef);
  }

  withdrawPlacement(placementRef, body = {}) {
    const placement = this.getPlacement(placementRef);
    if (placement.lifecycle !== 'published' || placement.valid_to !== null) {
      throw new ConflictError('只有当前在场的布置可以撤下');
    }
    const validTo = normalizeInstant(body.valid_to || nowIso(), 'valid_to');
    if (validTo < placement.valid_from) {
      throw new ValidationError('撤下时间不能早于布展生效时间');
    }
    this.db
      .prepare(
        `UPDATE placements
         SET lifecycle = 'withdrawn', valid_to = ?, closure_reason = COALESCE(closure_reason, 'manual_withdrawal'),
             withdrawn_at = ?
         WHERE id = ?`,
      )
      .run(validTo, nowIso(), placement.id);
    return this.getPlacement(placementRef);
  }

  // ---------- 读取：观众当前版本 / 内部历史复原 ----------

  placementsActiveAt(at) {
    return this.db
      .prepare(
        `SELECT * FROM placements
         WHERE lifecycle = 'published' AND valid_from <= ?
           AND (valid_to IS NULL OR valid_to > ?)
         ORDER BY channel_ref, valid_from`,
      )
      .all(at, at);
  }

  #assemblePlacementView(placement, at, { internal }) {
    const object = this.getObject(placement.object_ref);
    const channel = this.getChannel(placement.channel_ref);
    const narrative = this.getNarrative(placement.narrative_ref);
    const label = this.effectiveLabel(placement.object_ref, at);
    const view = {
      placement_ref: placement.placement_ref,
      placement_kind: placement.placement_kind,
      substitute_for_ref: placement.substitute_for_ref,
      valid_from: placement.valid_from,
      valid_to: placement.valid_to,
      channel: {
        channel_ref: channel.channel_ref,
        channel_type: channel.channel_type,
        name: channel.name,
      },
      narrative: {
        narrative_ref: narrative.narrative_ref,
        title: narrative.title,
      },
      object: {
        object_ref: object.object_ref,
        object_kind: object.object_kind,
        title: object.title,
        period: object.period,
      },
      label: label
        ? {
            revision_no: label.revision_no,
            content: label.content,
            effective_from: label.effective_from,
          }
        : null,
    };
    if (internal) {
      view.closure_reason = placement.closure_reason;
      view.object_status_at = this.statusAt(object.object_ref, at);
      view.layout = this.layoutAt(channel.channel_ref, at);
      view.object.storage_location = object.storage_location;
      view.object.restoration_status = object.restoration_status;
    }
    return view;
  }

  // 观众：始终读取当前有效版本
  publicExhibition() {
    const at = nowIso();
    const placements = this.placementsActiveAt(at).map((placement) =>
      this.#assemblePlacementView(placement, at, { internal: false }),
    );
    return { generated_at: at, placements };
  }

  // 内部：选择任一历史日期，复原当日展柜、文献与数字页面如何对应
  historicalSnapshot(at) {
    const placements = this.placementsActiveAt(at).map((placement) =>
      this.#assemblePlacementView(placement, at, { internal: true }),
    );
    const channels = this.listChannels().map((channel) => ({
      channel_ref: channel.channel_ref,
      channel_type: channel.channel_type,
      name: channel.name,
      layout: this.layoutAt(channel.channel_ref, at),
    }));
    return { at, channels, placements };
  }
}

module.exports = { Store, OBJECT_KINDS, EVENT_TYPES, CHANNEL_TYPES };
