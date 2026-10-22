# HAC-Metrics

只采集 HAC 流程在 GitHub 上留下的客观事实，存成 JSON。不调用模型，不做判断，不改任何规则仓库。

## 当前状态

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/zwmhua2-lab2/HAC-Metrics （public） |
| 定时 | 每小时 :17，已启用 |
| 首次 CI 采集 | 2026-10-22 14:45 UTC+8，run 39735889781 通过 |
| 幂等验证 | 2026-10-22 14:50，`done: 0 written, 3 eligible`，无新提交 |
| 数据 | 3 个已关闭 Issue（#2 / #4 / #5） |

## 结构

```text
.github/workflows/collect.yml   定时采集（每小时 :17）
scripts/collect.mjs             零依赖，Node 20+
test/collect.test.mjs           解析函数单测
data/<repo>/issue-<n>.json      采集结果
```

## 配置

1. 建 fine-grained PAT：仅授权目标仓库的 `Contents: read`、`Issues: read`、`Pull requests: read`。
2. 存为本仓库 secret `TARGET_READ_TOKEN`。
3. 目标仓库写在工作流 `env.TARGET_REPO`。

## 运行

```sh
TARGET_REPO=owner/repo TARGET_TOKEN=... OUT_DIR=data node scripts/collect.mjs
TARGET_REPO=owner/repo TARGET_TOKEN=... ISSUE=5 OUT_DIR=data node scripts/collect.mjs  # 单卡重采，覆盖已有文件
node --test
```

无 `ISSUE` 时全量扫描已关闭 Issue，已存在 `issue-N.json` 的跳过（幂等）。

**解析规则改动后，旧数据不会自动刷新**。已有文件被跳过，新旧口径会混在一起。必须逐个 `ISSUE=N` 重采，或在本地删除对应 JSON 后让定时任务重建。

## 字段口径

| 字段 | 含义 | 解析失败 |
|---|---|---|
| `risk` | Issue 正文 `风险：高/低`，容忍 `**高**` | `unknown` |
| `rework` | commit 数 − 1，近似返工，**不等于 push 次数** | — |
| `qa.result` | 最后一条含 QA 结论的评论 | `qa: null` |
| `qa.sha_match` | 被测 commit 是否为 PR 当前 head 的前缀 | — |
| `qa.fail_count` | 所有轮次中 `FAIL` 的条数 | — |
| `scope` | Issue `允许修改` 白名单 vs PR 改动文件 | 白名单解析不出则 `unknown` |
| `assertion_delta` | 测试文件新增减删除的断言行，启发式 | 负数需人工复核 |

`unknown` 比例本身就是数据质量指标，不要用推断把它填满。

## 与初版方案的两处必要偏差

实跑真实数据后才暴露，两处都会让数据错而不报错：

1. **白名单有两种模板写法**：`- 允许：\`a.mjs\`` 单行，以及 `允许：` 后接 `- \`a.mjs\`` 列表（Issue #2 用的是后者）。只认前者会让 #2 的 `scope` 变成 `unknown`。解析在遇到 `禁止/依赖/状态同步` 或下一个标题时停止，避免把禁止行的反引号读进白名单。
2. **QA 结论有两种写法**：`QA 结论：PASS`，以及首行裸写 `PASS`（PR #7 第二轮）。只认前者会把 #7 的最终结论错记成上一轮 `FAIL`。裸结论回退要求同一条评论里出现 `被测 commit`，否则不认。

## 验收记录（2026-10-22 实跑，对真实仓库）

| Issue | PR | commits | rework | QA | sha_match | fail_count | scope | 人工核对 |
|---|---|---|---|---|---|---|---|---|
| 2 | 3 | 2 | 1 | null（PR 无 QA 评论） | — | — | ok | 一致 |
| 4 | 7 | 2 | 1 | PASS | true | 1 | ok（5 个文件全在 `mp_audit/**`） | 一致 |
| 5 | 6 | 2 | 1 | PASS | true | 1 | ok（仅 `test/fetch-history.test.mjs`） | 一致 |

`hours_issue_to_pr` 复核：#2 = 0.33h、#4 = 1.20h、#5 = 0.10h，与页面时间戳一致。
`assertion_delta` 复核：#5 = +10/−1 = 9，#4 = +14/−0 = 14。

14:52 二次独立复核：直接用 `gh api` 拉 PR 的 commits / files / comments 原始响应，不复用 `collect.mjs` 的解析函数，逐项比对上一行表格，结果一致。PR #7 的最后一轮 QA 确实写成首行裸 `PASS`（无 `QA 结论：` 前缀），是方案初版会判错的那一条。

## 自身变更规则

**`main` 没有分支保护，可直接推送。** 这是有意取舍，不是遗漏：

- 每小时采集必须直推 `main` 才能落地数据。开了「要求 PR」的保护，自动提交会被拒，采集链断掉。
- 因此「改脚本先开 Issue、带测试、走 PR」是约定，**不是强制**。谁有写权限都能直推。
- 真要强制执行，得把数据提交改成「开 PR + 人工合并」，代价是每小时一次人工操作。当前样本量（3 条）下不划算。

最低可执行约束：改 `scripts/collect.mjs` 的任何解析正则，必须同时补 `test/collect.test.mjs` 用例，`node --test` 全绿后再提交，并在 commit message 写明改的是哪条规则。这不是流程，是防止你自己三天后看不出改动意图。

首次提交 `bd14a49` 直接落 `main`（建仓库时还没有 Issue/PR 可用）。

## 已知上限

- 只覆盖 GitHub 上可见的行为；对话决策、本地操作不在数据里。
- 公开仓库 60 天无活动会被暂停定时任务；本仓库每次提交数据即算活动。
- `rework`、`assertion_delta` 都是近似值，只能当复核线索。
