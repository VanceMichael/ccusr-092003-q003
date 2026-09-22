# 领域资料

真品、复制件、历史文献与数字展项在展览中相互引用，外借、修复和展签修订各有生效时间。

## 身份与引用

每件展品拥有四种身份之一（`object_kind`）：

- `artifact` 真品：唯一具有“现场资格”（`site_eligibility`）约束的实体；
- `reproduction` 复制件、`document` 历史文献、`digital` 数字影像：不随真品外借/送修离场。

外部主体只使用不含真实身份信息的引用编号（`object_ref`、`surface_ref`、`label_ref` 等）。原始材料只保存受控引用（`REF:...`）或 `sha256:` 摘要，不内联原件内容。`contracts/entities.json` 中的字段名称属于稳定接口约定。

## 时间约定

交换时间一律采用**带偏移量**的 ISO 8601 字符串（如 `2026-09-22T09:00:00+08:00`），朴素本地时间会被拒绝，以避免跨日歧义。排期区间为半开 `[starts_at, ends_at)`。内部按绝对时刻（epoch 毫秒）比较，因此不同偏移量的输入可正确排序。

## 保管与现场资格

保管事件（`custody_events`）为不可变流水：`loan_out`（外借）、`repair_out`（送修）、`return`（回馆）。

- 外借或送修在事件发生时刻**立即**把真品置为 `away`，并把其当前已开始、尚未结束的获批排期在该时刻封口；
- `away` 期间不得新增/批准开始时刻不晚于当前的现场排期（回馆之后的预排允许）；
- 回馆恢复 `on_site`；
- 复制件、文献与数字影像不受真品保管状态影响，触摸屏数字页面照常在线。

## 替代展项与叙事

展面（`display_surfaces`）分三类：`case` 展柜、`document_slot` 文献位、`digital_page` 数字页面（触摸屏位置）。排期（`placements`）把展项在某时段绑定到展面。

真品离场后，可登记 `approval_status: pending` 的替代排期，用 `replaces_placement` 指向原排期；系统自动继承原排期的 `narrative_ref`。经审批 `approved` 后：

1. 替代展项对观众可见，同展面冲突的开放旧排期在其 `starts_at` 封口；
2. 叙事线索保持连续；
3. 待批与被拒排期不占场、不对观众可见。

## 研究更正与展签演进

- **年代更正**（`dating_corrections`）：`draft → submitted → approved|rejected`。审阅期间已发布说法保持不变；只有批准才覆盖展品的当前年代口径。建账初值保存在 `initial_dating_statement/initial_dating_basis`，永不改写，驳回与未来更正都不能追溯篡改它。
- **展签修订**（`labels`）：同样经草稿、审阅、批准；`revision` 按展品单调递增，已批准行不可变。新版发布时旧版记录 `superseded_at`，文案本身不动，完整保留展签演进史。

## 两种读取视角

- `GET /public/now`：观众视角，始终只读取**当前有效版本**——当前获批排期、已发布年代口径、当前生效展签；`away` 真品即使存在覆盖性排期也不显示。
- `GET /internal/as-of?at=<带偏移量时刻>`：内部视角，复原任一历史日期当日的展柜、文献位与数字页面究竟对应哪件展品、其保管位置、现场资格、年代口径与展签版本。

运行时数据文件位置由 `DATABASE_PATH` 决定；表结构见 `migrations/002_exhibition.sql`。
