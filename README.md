# HAC-Metrics

只采集 HAC 流程在 GitHub 上留下的客观事实，存成 JSON。不调用模型，不做判断，不改任何规则仓库。

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

## 自身变更规则

首次提交直接落 `main`（仓库创建时还没有 Issue/PR 可用）。之后改脚本应先开 Issue、带测试、走 PR，不直推 `main`。

## 已知上限

- 只覆盖 GitHub 上可见的行为；对话决策、本地操作不在数据里。
- 公开仓库 60 天无活动会被暂停定时任务；本仓库每次提交数据即算活动。
- `rework`、`assertion_delta` 都是近似值，只能当复核线索。
