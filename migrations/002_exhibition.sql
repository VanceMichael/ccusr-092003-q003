-- 展陈发布中心：领域表结构
-- 所有业务时间均为带偏移量的 ISO 8601 字符串，统一以 UTC 存储、原样返回。

-- 展品身份：真品 / 复制件 / 历史文献 / 数字影像
CREATE TABLE IF NOT EXISTS exhibition_objects (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    object_ref          TEXT NOT NULL UNIQUE,            -- 对外稳定引用编号，不含真实身份
    object_kind         TEXT NOT NULL CHECK (object_kind IN ('artifact','reproduction','document','digital')),
    title               TEXT NOT NULL,
    source_ref          TEXT NOT NULL,                   -- 来源：受控引用或 sha256 摘要
    source_note         TEXT,
    -- 年代判断依据（当前已发布口径）；更正未经审批发布前不得覆盖
    initial_dating_statement TEXT,                   -- 建账时的最初口径，永不改写（历史复原用）
    initial_dating_basis     TEXT,
    dating_statement    TEXT,                        -- 当前已发布口径（批准后随之更新）
    dating_basis        TEXT,
    dating_status       TEXT NOT NULL DEFAULT 'established'
                            CHECK (dating_status IN ('established','under_review','superseded')),
    custody_location    TEXT NOT NULL,                   -- 当前保管位置
    registered_location TEXT NOT NULL,                   -- 入藏登记位置（无保管事件时的复原基准）
    -- 真品现场资格：on_site 可现场展出；away 表示外借/送修，立即取消现场资格
    site_eligibility    TEXT NOT NULL DEFAULT 'on_site'
                            CHECK (site_eligibility IN ('on_site','away')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- 保管事件（外借 / 送修 / 回馆），不可变流水
CREATE TABLE IF NOT EXISTS custody_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    object_ref          TEXT NOT NULL REFERENCES exhibition_objects(object_ref),
    event_type          TEXT NOT NULL CHECK (event_type IN ('loan_out','repair_out','return')),
    occurred_at         TEXT NOT NULL,                   -- 事件实际发生时刻（ISO 8601）
    location            TEXT NOT NULL,                   -- 去向 / 接收方 / 修复方
    reason              TEXT,
    recorded_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custody_object ON custody_events(object_ref, occurred_at);

-- 研究年代更正：draft -> submitted -> approved（发布）/ rejected
-- 更正先进入审阅，approved 前绝不覆盖已发布的 dating_statement
CREATE TABLE IF NOT EXISTS dating_corrections (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_ref      TEXT NOT NULL UNIQUE,
    object_ref          TEXT NOT NULL REFERENCES exhibition_objects(object_ref),
    proposed_statement  TEXT NOT NULL,
    proposed_basis      TEXT,
    rationale           TEXT,
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected')),
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    submitted_at        TEXT,
    reviewed_by         TEXT,
    reviewed_at         TEXT,
    review_note         TEXT,
    published_at        TEXT                             -- 批准时刻，覆盖展品年代口径
);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON dating_corrections(status);

-- 展签修订：draft -> submitted -> approved（发布）/ rejected，发布后不可变
CREATE TABLE IF NOT EXISTS labels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    label_ref           TEXT NOT NULL UNIQUE,
    object_ref          TEXT NOT NULL REFERENCES exhibition_objects(object_ref),
    revision            INTEGER NOT NULL,                -- 单调递增的展签版本号
    content             TEXT NOT NULL,                   -- 展签文案
    editor              TEXT,
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected')),
    created_at          TEXT NOT NULL,
    submitted_at        TEXT,
    reviewed_by         TEXT,
    reviewed_at         TEXT,
    review_note         TEXT,
    published_at        TEXT,
    superseded_at       TEXT,                            -- 被下一已发布版本替代的时刻
    UNIQUE (object_ref, revision)
);
CREATE INDEX IF NOT EXISTS idx_labels_object ON labels(object_ref, revision);

-- 叙事：替代展项经审批后接上的原叙事线索
CREATE TABLE IF NOT EXISTS narratives (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    narrative_ref       TEXT NOT NULL UNIQUE,
    title               TEXT NOT NULL,
    description         TEXT,
    created_at          TEXT NOT NULL
);

-- 展面：展柜 case / 文献位 document_slot / 数字页面 digital_page（触摸屏位置）
CREATE TABLE IF NOT EXISTS display_surfaces (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    surface_ref         TEXT NOT NULL UNIQUE,
    surface_kind        TEXT NOT NULL
                            CHECK (surface_kind IN ('case','document_slot','digital_page')),
    name                TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

-- 排期：展项在某展面上的半开时间区间 [starts_at, ends_at)
-- ends_at 为空表示当前有效。取消现场资格会把该展项在未来/当前的真品排期立即封口。
CREATE TABLE IF NOT EXISTS placements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    surface_ref         TEXT NOT NULL REFERENCES display_surfaces(surface_ref),
    object_ref          TEXT NOT NULL REFERENCES exhibition_objects(object_ref),
    label_ref           TEXT REFERENCES labels(label_ref),
    narrative_ref       TEXT REFERENCES narratives(narrative_ref),
    starts_at           TEXT NOT NULL,
    ends_at             TEXT,                           -- 排期结束（撤展/被替换）
    -- 替代展项审批：approved 后才可在现场视图出现
    approval_status     TEXT NOT NULL DEFAULT 'approved'
                            CHECK (approval_status IN ('pending','approved','rejected')),
    replaces_placement  INTEGER REFERENCES placements(id), -- 接上的原排期（原叙事不断线）
    requested_by        TEXT,
    reviewed_by         TEXT,
    reviewed_at         TEXT,
    review_note         TEXT,
    created_at          TEXT NOT NULL,
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_placements_interval ON placements(surface_ref, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_placements_object ON placements(object_ref);
