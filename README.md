# 金矿博物馆展陈发布中心

真品、复制件、历史文献与数字展项在展览中相互引用，外借、修复和展签修订各有生效时间。

本服务为可运行的展陈发布中心，通过 HTTP 接口交换业务记录，使用 SQLite 文件保存状态。核心规则：

- **身份分立**：藏品具有 `artifact`（真品）/ `replica`（复制件）/ `document`（文献）/ `digital_image`（数字影像）四种身份，分别保存来源引用、年代判断依据、保管位置与修复状态。
- **离场即撤**：真品登记 `on_loan`（外借）或 `under_repair`（送修）事件时，其所有当前在场布置立即以事件发生时间关闭；离场期间真品无法重新发布上展。
- **替代接续**：替代展项必须经提案与审批后才能发布，且只能挂接原主展项曾经发布过的同一叙事。
- **更正审阅**：研究更正先进入 `in_review`，不覆盖任何已发布说法；发布后内容不可变，新版封边旧版（旧版标记 `superseded` 但内容原样保留）。
- **两种视角**：`/public/exhibition` 始终只呈现当前有效版本；`/internal/snapshot?at=` 可按任一历史日期复原当日展柜、文献与数字页面的对应关系及触摸屏布局。

## 本地开发

```bash
make migrate   # 初始化/升级数据文件（DATABASE_PATH，默认 data/app.sqlite3）
make seed      # 写入 fixtures/example.json 的金条送修演示场景（库非空时跳过）
make test      # 执行自动化检查
make run       # 启动服务（PORT，默认 8080）
```

也可使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整；服务启动时会自动执行迁移。

## 时间约定

接口交换时间一律使用带偏移量的 ISO 8601（如 `2026-09-21T08:00:00+08:00`）；库内归一化为 UTC。有效期采用半开区间 `[valid_from, valid_to)`。历史复原的 `at` 参数允许只给日期 `YYYY-MM-DD`，按当日结束时刻复原。

## HTTP 接口

### 藏品与保管状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/objects` | 登记藏品（区分四种身份；记录来源、年代依据、保管位置、修复状态） |
| GET | `/v1/objects` / `/v1/objects/:ref` | 查询藏品 |
| POST | `/v1/objects/:ref/status-events` | 登记保管事件（外借/送修立即关闭真品在场布置） |
| GET | `/v1/objects/:ref/status-events` | 保管事件流水 |

### 展签修订

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/objects/:ref/labels` | 提出修订（进入审阅，不对外） |
| GET | `/v1/objects/:ref/labels` | 修订流水（含审阅中与各历史版） |
| POST | `/v1/labels/:id/publish` | 审批发布（body 可指定 `effective_from`）；旧版封边、内容不变 |

### 叙事、渠道与布局

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/v1/narratives` | 叙事节点 |
| POST/GET | `/v1/channels` | 展陈渠道：`case` / `touchscreen` / `digital_page` |
| POST/GET | `/v1/channels/:ref/layouts` | 布局版本（触摸屏位置、数字页配置等），新版封边旧版 |

### 展项布置（排期）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/v1/placements` | 提案 / 列表（支持 `channel_ref`、`narrative_ref`、`object_ref`、`lifecycle` 过滤） |
| GET | `/v1/placements/:ref` | 布置详情 |
| POST | `/v1/placements/:ref/approve` / `reject` | 审批；未经审批不得发布 |
| POST | `/v1/placements/:ref/publish` | 发布上展（可指定 `valid_from`，自动封边同渠道旧排期） |
| POST | `/v1/placements/:ref/withdraw` | 手动撤下 |

替代展项在提案时提供 `substitute_for_ref`，系统校验它与原主展项处于同一叙事。

### 发布视图

- `GET /public/exhibition` —— 观众端：当前时刻在场的展柜/触摸屏/数字页面展项及其生效展签。
- `GET /internal/snapshot?at=2026-09-20` —— 内部历史复原：当日各渠道的展项、展签版本、布局版本、保管位置与修复状态，并附关闭原因。

字段稳定约定见 `contracts/entities.json`，领域说明见 `docs/domain.md`。
