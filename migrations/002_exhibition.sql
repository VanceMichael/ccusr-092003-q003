-- 展陈发布中心：藏品、状态事件、叙事、展陈渠道、展签修订、展项布置
-- 时间统一存为归一化 UTC（ISO 8601）；有效期采用半开区间 [valid_from, valid_to)

CREATE TABLE IF NOT EXISTS collection_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_ref TEXT NOT NULL UNIQUE,
    object_kind TEXT NOT NULL CHECK (
        object_kind IN ('artifact', 'replica', 'document', 'digital_image')
    ),
    title TEXT NOT NULL,
    source_ref TEXT,
    provenance_digest TEXT,
    period TEXT,
    dating_evidence TEXT,
    storage_location TEXT,
    restoration_status TEXT NOT NULL DEFAULT 'none' CHECK (
        restoration_status IN ('none', 'under_repair', 'restored')
    ),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_ref TEXT NOT NULL REFERENCES collection_objects(object_ref),
    event_type TEXT NOT NULL CHECK (
        event_type IN ('in_house', 'on_loan', 'under_repair', 'loan_returned', 'repair_returned')
    ),
    occurred_at TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_events_object
    ON status_events(object_ref, occurred_at);

CREATE TABLE IF NOT EXISTS narratives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    narrative_ref TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_ref TEXT NOT NULL UNIQUE,
    channel_type TEXT NOT NULL CHECK (
        channel_type IN ('case', 'touchscreen', 'digital_page')
    ),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 渠道布局（如触摸屏位置）按生效时间版本化，新发布版本封边旧版本
CREATE TABLE IF NOT EXISTS channel_layouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_ref TEXT NOT NULL REFERENCES channels(channel_ref),
    revision_no INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    config_json TEXT,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    UNIQUE (channel_ref, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_channel_layouts_channel
    ON channel_layouts(channel_ref, valid_from);

-- 展签修订：append-only；更正先进 in_review，发布后内容不可变，新版封边旧版
CREATE TABLE IF NOT EXISTS label_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_ref TEXT NOT NULL REFERENCES collection_objects(object_ref),
    revision_no INTEGER NOT NULL,
    content TEXT NOT NULL,
    research_note TEXT,
    evidence_ref TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('in_review', 'published', 'superseded')
    ),
    effective_from TEXT,
    superseded_at TEXT,
    created_at TEXT NOT NULL,
    published_at TEXT,
    UNIQUE (object_ref, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_label_revisions_object
    ON label_revisions(object_ref, effective_from);

-- 展项布置：提案 -> 审批 -> 发布 -> 撤下/自动关闭；替代展项挂接原叙事
CREATE TABLE IF NOT EXISTS placements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placement_ref TEXT NOT NULL UNIQUE,
    narrative_ref TEXT NOT NULL REFERENCES narratives(narrative_ref),
    channel_ref TEXT NOT NULL REFERENCES channels(channel_ref),
    object_ref TEXT NOT NULL REFERENCES collection_objects(object_ref),
    substitute_for_ref TEXT REFERENCES collection_objects(object_ref),
    placement_kind TEXT NOT NULL CHECK (
        placement_kind IN ('primary', 'substitute')
    ),
    lifecycle TEXT NOT NULL CHECK (
        lifecycle IN ('proposed', 'approved', 'rejected', 'published', 'withdrawn')
    ),
    note TEXT,
    valid_from TEXT,
    valid_to TEXT,
    closure_reason TEXT,
    proposed_at TEXT NOT NULL,
    approved_at TEXT,
    published_at TEXT,
    withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_placements_view
    ON placements(channel_ref, lifecycle, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_placements_object
    ON placements(object_ref, lifecycle);
CREATE INDEX IF NOT EXISTS idx_placements_narrative
    ON placements(narrative_ref, lifecycle);
