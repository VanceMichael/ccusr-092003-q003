# 领域资料

真品、复制件、历史文献与数字展项在展览中相互引用，外借、修复和展签修订各有生效时间。

## 身份与记录

- 藏品身份 `object_kind` 取 `artifact` / `replica` / `document` / `digital_image`，外部主体使用不含真实身份信息的引用编号。
- 每件藏品保存受控来源引用 `source_ref`、来源摘要 `provenance_digest`（`sha256`）、年代 `period` 与年代判断依据 `dating_evidence`、保管位置 `storage_location`、修复状态 `restoration_status`。
- 保管状态以事件流水（`status_events`）记录：在馆、外借、送修、外借归还、修复归还。

## 关键不变量

1. 真品登记外借或送修事件时，其所有 `published` 且尚未关闭的布置立即以事件时间写入 `valid_to`（关闭原因 `object_on_loan` / `object_under_repair`）；离场期间禁止真品重新发布。
2. 展签修订 append-only：`in_review` → `published` →（被新版封边为）`superseded`。研究更正停留审阅期间不影响任何已发布说法；已发布行的内容永不更新。
3. 布置生命周期 `proposed` → `approved` → `published`（或 `rejected` / `withdrawn`）；只有审批通过的布置可以发布。
4. 替代展项（`placement_kind=substitute`，带 `substitute_for_ref`）必须指向同一叙事下原主展项曾发布的位置，保证“接上原叙事”。
5. 同一渠道同一时刻至多一个在场布置；新排期发布时以其 `valid_from` 封边旧排期。渠道布局（触摸屏位置等）同理版本化。

## 时间模型

- 交换时间采用带偏移量的 ISO 8601 字符串，库内归一化为 UTC 存储。
- 所有有效期使用半开区间 `[valid_from, valid_to)`，历史复原即对某一时刻做区间连接：布置 ⨝ 展签 ⨝ 渠道布局。
- 观众视图固定取当前时刻；内部视图的 `at` 接受日期或时刻，可复现任一历史日期“展柜—文献—数字页面”的真实对应。

`contracts/entities.json` 中的字段名称属于稳定接口约定，运行时数据文件位置由 `DATABASE_PATH` 决定。
