# 金矿博物馆展陈发布中心

真品、复制件、历史文献与数字展项在展览中相互引用，外借、修复和展签修订各有生效时间。本服务解决开馆前的典型困境：**一件金条已经送修，展柜排期、触摸屏位置和年代说明却停留在昨天的版本**——系统能立刻判断该撤哪一处、经审批的替展如何接上原叙事，并能复原任意历史日期当日的现场对应关系。

## 核心规则

1. **不同身份**：真品 `artifact`、复制件 `reproduction`、历史文献 `document`、数字影像 `digital` 各有独立引用编号、来源（受控引用或 `sha256` 摘要）、年代依据与保管位置。
2. **外借/送修立即撤场**：真品发生 `loan_out`/`repair_out` 的瞬间，现场资格变 `away`，其当前开放排期被封口；观众视图中对应展柜立即空置。数字影像不依赖真品本体，触摸屏照常在线。
3. **替代展项经审批接叙**：替展排期先以 `pending` 登记并指向原排期（`replaces_placement`），自动继承原叙事；只有获批后观众才看得到。
4. **研究更正先审阅**：年代更正在 `approved` 前绝不覆盖已发布说法；驳回不改变现状；建账初值永久保留。
5. **展签演进不可变**：展签修订经草稿→审阅→发布，版本号单调递增，已发布版本只被标记替代、永不改写。
6. **两种读取视角**：观众始终读当前有效版本；内部可按任一历史日期复原当日展柜、文献与数字页面对应。

## 技术栈

零第三方依赖：Node.js 22（内置 `node:sqlite`）+ 原生 HTTP。状态保存在 SQLite 文件，`DATABASE_PATH` 指定位置（默认 `data/app.sqlite3`），`PORT` 指定监听端口（默认 8080）。

## 本地开发

```bash
make migrate   # 初始化/升级数据文件
make test      # 执行自动化测试（7 个场景用例）
make demo      # 重演“金条送修”完整事件链（使用独立 data/demo.sqlite3）
make run       # 启动服务
```

也可使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整。

## HTTP 接口

所有请求/响应均为 JSON；时间字段必须是带偏移量的 ISO 8601 字符串。错误响应形如 `{"error":"<code>","message":"..."}`，状态码：400 校验失败、404 不存在、409 冲突或非法状态。

### 展品身份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/objects` | 登记展品（object_ref/object_kind/title/source_ref/custody_location 必填） |
| GET | `/v1/objects` | 列出全部展品 |
| GET | `/v1/objects/:ref` | 展品详情（含现场资格、当前年代口径） |
| POST | `/v1/objects/:ref/custody` | 登记保管事件 `loan_out`/`repair_out`/`return`，返回被封口的排期 |
| GET | `/v1/objects/:ref/custody` | 保管事件流水 |

### 年代更正（审阅链）

`POST /v1/corrections`（建草稿）→ `POST /v1/corrections/:id/submit` → `POST /v1/corrections/:id/review`（body: `{"decision":"approve|reject"}`）。另有 `GET /v1/corrections?status=draft` 与详情接口。

### 展签修订

`POST /v1/labels`（建草稿，版本号自动递增）→ `POST /v1/labels/:id/submit` → `POST /v1/labels/:id/review`。`GET /v1/labels?object_ref=...` 查看某展品的完整演进史。审阅动作支持可选 `at` 字段指定发布时刻（用于补录历史数据）。

### 叙事、展面、排期

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/v1/narratives` | 叙事线索维护 |
| POST/GET | `/v1/surfaces` | 展面：`case`/`document_slot`/`digital_page` |
| POST | `/v1/placements` | 建立排期；替展用 `approval_status:"pending"` + `replaces_placement` |
| GET | `/v1/placements?surface_ref=&object_ref=&status=` | 查询排期 |
| POST | `/v1/placements/:id/review` | 审批替代展项（`approve`/`reject`） |

### 发布与复原（只读）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/public/now` | **观众视图**：当前有效版本 |
| GET | `/internal/as-of?at=2026-09-21T15:00:00+08:00` | **内部历史复原**：当日展柜/文献/数字页面对应 |
| GET | `/v1/review-queue` | 待审批的更正、展签与替展 |
| GET | `/health` | 健康检查 |

## 事件链示例

```bash
# 今天 06:30 真品金条送修（立即取消现场资格）
curl -sX POST localhost:8080/v1/objects/OBJ-BAR-REAL/custody \
  -H 'content-type: application/json' \
  -d '{"event_type":"repair_out","occurred_at":"2026-09-22T06:30:00+08:00","location":"省文保修复中心"}'
# {"site_eligibility":"away","closed_placement_ids":[1], ...}

# 申请复制件替展并接上原排期 #1，获批后观众可见
curl -sX POST localhost:8080/v1/placements -H 'content-type: application/json' -d '{
  "surface_ref":"CASE-GOLD-1","object_ref":"OBJ-BAR-REPRO",
  "replaces_placement":1,"starts_at":"2026-09-22T08:30:00+08:00",
  "approval_status":"pending","requested_by":"策展人"}'
curl -sX POST localhost:8080/v1/placements/2/review \
  -H 'content-type: application/json' -d '{"decision":"approve","reviewed_by":"馆务委员会"}'

# 观众读到当前版本；内部复原昨天下午的现场
curl -s 'localhost:8080/public/now'
curl -s 'localhost:8080/internal/as-of?at=2026-09-21T15:00:00+08:00'
```

字段级稳定约定见 `contracts/entities.json`，领域规则见 `docs/domain.md`，不含真实身份的本地样例见 `fixtures/example.json`。
