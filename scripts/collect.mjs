// 只采集 GitHub 上可观察的客观事实，不做判断，不调用模型。
// 解析不出来一律写 unknown / null，不推断。
//
// ⛔ 解析规则已冻结（2026-10-22）：在 data/MarketPulse-AI/ 达到 10 个 issue-N.json 之前，
//   不改任何解析正则、不加解析分支。理由：3 条样本已经触发两轮修订，改得比样本快，
//   数据就永远不能被用来判断。解冻后每次改动必须附一个真实失败样本——某个已采集
//   JSON 确实算错了，并能指出错在哪一行输出。"这种格式以后可能会出现"不算理由。
//   未验证项表里的条目是已知限制，不是待修 bug。
//   例外：运行故障（限流、分页异常、读写失败、字段为 null 抛错）可以修，
//   但不得改变任何字段的取值规则，并在 README「运行故障记录」里记一笔。
//
// ⚠ 改这里的任何解析正则，必须同步改 test/collect.test.mjs 对应用例。
//   每条正则上方的 // test: 注释标出守着它的用例名，下面的元测试会检查引用是否真实存在。
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TARGET = process.env.TARGET_REPO ?? '';
const TOKEN = process.env.TARGET_TOKEN ?? '';
const OUT = process.env.OUT_DIR ?? 'data';

// ---------- 纯函数（可单测，不触网） ----------

// test: parseRisk：中英文冒号与 markdown 加粗
const RISK = /风险[:：]\s*\**\s*(高|低)/;

export function parseRisk(body = '') {
  const m = String(body).match(RISK);
  return m ? m[1] : 'unknown';
}

// test: parseAllowed：块格式只取允许列表，含 node:test 的内联代码不算路径
const quoteRe = /`([^`\n]+)`/g;
const looksLikePath = (p) => !!p && !/\s/.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p);

function quotedPaths(line) {
  return [...line.matchAll(quoteRe)].map((m) => m[1].trim()).filter(looksLikePath);
}

// test: parseAllowed：块格式 / 内联格式 / 无章节 / 章节内无路径
// Issue 模板实测有两种写法，都要认：
//   "- 允许：`a.mjs`"                      （单行内联）
//   "允许：" + 后续 "- `a.mjs`" 列表        （#2 用的写法）
// 遇到 禁止/依赖/状态同步 或下一个标题即停止，避免把禁止行里的反引号读成白名单。
export function parseAllowed(body = '') {
  const lines = String(body).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*允许修改\s*$/.test(l.trim()));
  if (start === -1) return null;

  const paths = [];
  let open = false;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^##\s/.test(t)) break;
    if (!t) continue;
    if (/^[-*]?\s*(禁止|依赖|状态同步)[:：]/.test(t)) break;

    if (/^[-*]?\s*允许[:：]/.test(t)) {
      open = true;
      paths.push(...quotedPaths(t));
      continue;
    }
    if (open && /^[-*]\s+/.test(t)) {
      paths.push(...quotedPaths(t));
      continue;
    }
    if (open) break;
  }
  return paths.length ? [...new Set(paths)] : null;
}

function globToRe(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

// test: inScope：白名单文件与目录前缀 / glob 目录白名单 / 空白名单
export function inScope(file, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.some((a) => {
    const pat = a.trim().replace(/\/+$/, '');
    if (!pat) return false;
    if (pat === file) return true;
    if (pat.includes('*')) return globToRe(pat).test(file);
    return file.startsWith(`${pat}/`);
  });
}

const isAssertLine = (l) => /\b(assert|expect)\b/.test(l);

// test: assertionDelta：只新增断言为正数 / 只删除断言为负数 / 非断言行改动为 0
export function assertionDelta(files) {
  return files
    .filter((f) => /(^|\/)(test|tests|__tests__)\/|\.test\./.test(f.filename))
    .reduce((sum, f) => {
      const lines = (f.patch ?? '').split('\n');
      return (
        sum +
        lines.filter((l) => l.startsWith('+') && isAssertLine(l)).length -
        lines.filter((l) => l.startsWith('-') && isAssertLine(l)).length
      );
    }, 0);
}

// test: parseQa：QA 结论前缀，大小写与全角冒号均可
const COMMIT = /被测\s*commit\s*[:：]\s*`?\**([0-9a-f]{7,40})/i;
// test: 边界：一条评论贴两轮记录时，结论与 commit 取最后一组
const COMMIT_ALL = new RegExp(COMMIT.source, 'gi');
// test: qaRounds：统计同一 PR 多轮结论
const QA_TAGGED = /QA\s*结论\s*[:：]\s*\**\s*(PASS|FAIL|BLOCKED)/gi;

// 裸结论只认「首个非空行」，不接受正文中间独立成行的 PASS/FAIL。
// 放宽到全文会误吃 QA 评论里粘贴的测试日志（日志里常出现孤立 PASS/FAIL）。
const firstNonEmpty = (text) => text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
// test: parseQa：省略前缀、首行裸结论仍可识别（实测 #7 第二轮格式）
const QA_BARE = /^\s*\**\s*(PASS|FAIL|BLOCKED)\s*\**\s*$/i;

// 实测 #7 第二轮 QA 省掉了 "QA 结论：" 前缀，直接首行写 PASS。
// 回退规则要求同一条评论里出现 "被测 commit"，否则不算结论。
export function qaRounds(body = '') {
  const text = String(body);
  const tagged = [...text.matchAll(QA_TAGGED)];
  if (tagged.length) return tagged.map((m) => m[1].toUpperCase());
  if (!COMMIT.test(text)) return [];
  const bare = firstNonEmpty(text).match(QA_BARE);
  return bare ? [bare[1].toUpperCase()] : [];
}

export function parseQa(body = '') {
  const text = String(body);
  // 一条评论里贴多轮记录时，结论与 commit 都取最后一组，避免 PASS 配上上一轮的 FAIL commit
  const commits = [...text.matchAll(COMMIT_ALL)];
  if (!commits.length) return null;
  const rounds = qaRounds(text);
  if (!rounds.length) return null;
  return { result: rounds.at(-1), commit: commits.at(-1)[1].toLowerCase() };
}

const hours = (a, b) => (b ? +((new Date(b) - new Date(a)) / 3.6e6).toFixed(2) : null);

// ---------- 网络 ----------

const base = () => {
  const [owner, repo] = TARGET.split('/');
  return `https://api.github.com/repos/${owner}/${repo}`;
};

async function get(url) {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await get(`${base()}${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

let pullsCache = null;
async function allPulls() {
  pullsCache ??= await all('/pulls?state=all&sort=created&direction=desc');
  return pullsCache;
}

const closesIssue = (n) => new RegExp(`(closes|fixes|resolves)\\s+#${n}\\b`, 'i');

async function collectIssue(n) {
  const issue = await get(`${base()}/issues/${n}`);
  const allowed = parseAllowed(issue.body ?? '');
  const risk = parseRisk(issue.body ?? '');
  const linkRe = closesIssue(n);
  const pulls = (await allPulls()).filter((p) => linkRe.test(p.body ?? ''));

  const prs = [];
  for (const p of pulls) {
    const [commits, files, comments] = await Promise.all([
      all(`/pulls/${p.number}/commits`),
      all(`/pulls/${p.number}/files`),
      all(`/issues/${p.number}/comments`),
    ]);

    const rounds = comments.flatMap((c) => qaRounds(c.body ?? ''));
    const lastQa = comments.map((c) => parseQa(c.body ?? '')).filter(Boolean).at(-1) ?? null;
    const violating = allowed
      ? files.map((f) => f.filename).filter((f) => !inScope(f, allowed))
      : null;

    prs.push({
      number: p.number,
      commits: commits.length,
      // 近似值：commit 数 − 1，不等于 push 次数
      rework: Math.max(commits.length - 1, 0),
      opened: p.created_at,
      merged: p.merged_at,
      hours_issue_to_pr: hours(issue.created_at, p.created_at),
      qa: lastQa
        ? {
            result: lastQa.result,
            sha_match: String(p.head?.sha ?? '').startsWith(lastQa.commit),
            fail_count: rounds.filter((r) => r === 'FAIL').length,
          }
        : null,
      scope: allowed ? (violating.length ? 'violation' : 'ok') : 'unknown',
      violating_files: violating,
      assertion_delta: assertionDelta(files),
    });
  }

  return {
    schema: 1,
    project: TARGET.split('/')[1],
    issue: n,
    risk,
    issue_opened: issue.created_at,
    issue_closed: issue.closed_at,
    prs,
    collected_at: new Date().toISOString(),
  };
}

// ---------- CLI ----------

async function main() {
  if (!TARGET.includes('/')) throw new Error('TARGET_REPO 必须是 owner/repo');
  if (!TOKEN) throw new Error('TARGET_TOKEN 未设置');

  const only = (process.env.ISSUE ?? '').trim();
  let ids;
  if (only) {
    const n = Number(only);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`ISSUE 不是合法 Issue 号: ${only}`);
    ids = [n];
  } else {
    const issues = (await all('/issues?state=closed')).filter((i) => !i.pull_request);
    ids = issues.map((i) => i.number);
  }

  const repo = TARGET.split('/')[1];
  const dir = `${OUT}/${repo}`;
  await mkdir(dir, { recursive: true });
  const have = new Set(
    (await readdir(dir)).map((f) => Number(f.match(/^issue-(\d+)\.json$/)?.[1])).filter(Boolean),
  );

  let wrote = 0;
  for (const n of ids) {
    if (have.has(n) && !only) continue; // 幂等：已采集则跳过
    const data = await collectIssue(n);
    await writeFile(`${dir}/issue-${n}.json`, `${JSON.stringify(data, null, 2)}\n`);
    wrote++;
    console.log(`collected #${n}`);
  }
  console.log(`done: ${wrote} written, ${ids.length} eligible`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`COLLECT_ERROR ${e.message}`);
    process.exit(1);
  });
}
