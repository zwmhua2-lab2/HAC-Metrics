// 这些用例是 scripts/collect.mjs 解析正则的唯一护栏。
// 只改正则不加用例 = 悄悄改数据口径。改这里等于改口径，commit message 要写明。
// 解析规则已冻结，解冻条件见 scripts/collect.mjs 顶部。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseAllowed,
  parseRisk,
  parseQa,
  qaRounds,
  inScope,
  assertionDelta,
} from '../scripts/collect.mjs';

// 以下样例取自真实 Issue 正文的两种模板写法
const BLOCK_FORM = `## 目标
做点事。

## 允许修改
允许：
- \`fetch-history.mjs\`（新增）
- \`test/fetch-history.test.mjs\`（新增，Node 内置 \`node:test\`）

状态同步：允许 \`ARCHITECTURE.md\` **仅第 7 节追加一行**本卡记录。
禁止：红牌文件（见 \`ARCHITECTURE.md\` C5）及一切未列出的文件。
依赖：零新增。

## 契约
- 允许：\`should-not-be-read.mjs\`
`;

const INLINE_FORM = `## 允许修改
- 允许：\`test/fetch-history.test.mjs\`（**仅** GWT-09 相关）
- 禁止：红牌文件及一切未列出的文件；尤其禁止新建 \`mp_audit/**\`。
- 依赖：零新增。

## 契约
`;

test('parseAllowed：块格式只取允许列表，含 node:test 的内联代码不算路径', () => {
  assert.deepEqual(parseAllowed(BLOCK_FORM), [
    'fetch-history.mjs',
    'test/fetch-history.test.mjs',
  ]);
});

test('parseAllowed：内联格式取单行路径，禁止行里的反引号不被误读', () => {
  assert.deepEqual(parseAllowed(INLINE_FORM), ['test/fetch-history.test.mjs']);
});

test('parseAllowed：没有允许修改章节返回 null', () => {
  assert.equal(parseAllowed('## 目标\n随便写点 `a.mjs`。'), null);
  assert.equal(parseAllowed(''), null);
});

test('parseAllowed：章节存在但允许行解析不出路径返回 null', () => {
  assert.equal(parseAllowed('## 允许修改\n允许：见架构文档。\n'), null);
});

test('inScope：白名单文件与目录前缀', () => {
  const allowed = ['fetch-history.mjs', 'test/'];
  assert.equal(inScope('fetch-history.mjs', allowed), true);
  assert.equal(inScope('package.json', allowed), false);
  assert.equal(inScope('test/a.test.mjs', allowed), true);
  assert.equal(inScope('tests/a.test.mjs', allowed), false);
});

test('inScope：glob 目录白名单', () => {
  const allowed = ['mp_audit/**'];
  assert.equal(inScope('mp_audit/audit.mjs', allowed), true);
  assert.equal(inScope('mp_audit/sub/report.md', allowed), true);
  assert.equal(inScope('mp_audit2/fake.mjs', allowed), false);
});

test('inScope：白名单为空时一律 false', () => {
  assert.equal(inScope('a.mjs', null), false);
  assert.equal(inScope('a.mjs', []), false);
});

const patch = (...lines) => `${lines.join('\n')}`;

test('assertionDelta：只新增断言为正数', () => {
  const files = [
    {
      filename: 'test/a.test.mjs',
      patch: patch('@@ -1,2 +1,4 @@', ' const x = 1;', '+assert.equal(x, 1);', '+expect(x).toBe(1);'),
    },
  ];
  assert.equal(assertionDelta(files), 2);
});

test('assertionDelta：只删除断言为负数', () => {
  const files = [
    {
      filename: 'test/a.test.mjs',
      patch: patch('@@ -1,3 +1,2 @@', ' const x = 1;', '-assert.ok(x);', '-assert.equal(x, 1);'),
    },
  ];
  assert.equal(assertionDelta(files), -2);
});

test('assertionDelta：非断言行改动为 0', () => {
  const files = [
    { filename: 'test/a.test.mjs', patch: patch('+const y = 2;', '-const y = 1;') },
  ];
  assert.equal(assertionDelta(files), 0);
});

test('assertionDelta：跳过非测试文件，缺 patch 不计数', () => {
  const files = [
    { filename: 'scripts/collect.mjs', patch: patch('+assert.ok(true);') },
    { filename: 'test/big.test.mjs' },
  ];
  assert.equal(assertionDelta(files), 0);
});

test('parseRisk：中英文冒号与 markdown 加粗', () => {
  assert.equal(parseRisk('风险：**高**；命中的第 6 节'), '高');
  assert.equal(parseRisk('- 风险: 低；'), '低');
  assert.equal(parseRisk('风险：未知'), 'unknown');
  assert.equal(parseRisk(''), 'unknown');
});

test('parseQa：QA 结论前缀，大小写与全角冒号均可', () => {
  const body = 'QA 结论：FAIL\n\n被测 commit：9741830abc1234\n';
  assert.deepEqual(parseQa(body), { result: 'FAIL', commit: '9741830abc1234' });
  assert.deepEqual(parseQa('qa结论:pass\n被测commit: a3110adb1c18\n'), {
    result: 'PASS',
    commit: 'a3110adb1c18',
  });
});

test('parseQa：短 SHA 与反引号包裹的 SHA', () => {
  assert.deepEqual(parseQa('QA 结论：PASS\n被测 commit：`a3110ad`\n').commit, 'a3110ad');
  assert.equal(parseQa('QA 结论：PASS\n被测 commit：`01ebb91`\n').commit, '01ebb91');
});

test('parseQa：省略前缀、首行裸结论仍可识别（实测 #7 第二轮格式）', () => {
  const body = 'PASS\n被测 commit：d4b0228414c1afa1be24f8a9baac482826df7b72　环境：Windows\n';
  assert.deepEqual(parseQa(body), {
    result: 'PASS',
    commit: 'd4b0228414c1afa1be24f8a9baac482826df7b72',
  });
});

test('parseQa：无被测 commit 或正文里散落的 PASS 不算结论', () => {
  assert.equal(parseQa('PASS'), null);
  assert.equal(parseQa('测试全部 PASS，但没写被测 commit。'), null);
  assert.equal(parseQa('QA 结论：PASS'), null);
});

test('qaRounds：统计同一 PR 多轮结论', () => {
  assert.deepEqual(qaRounds('QA 结论：FAIL\n被测 commit：9741830\n'), ['FAIL']);
  assert.deepEqual(qaRounds('PASS\n被测 commit：d4b0228\n'), ['PASS']);
  assert.deepEqual(qaRounds('随手一提 PASS 不算。'), []);
});

// ---- 异常输入边界（这些是真实 QA 评论可能出现、但现有数据没出现过的形态）----

test('边界：正文里孤立成行的 FAIL 不被当成结论（日志粘贴场景）', () => {
  const body = [
    'PASS',
    '被测 commit：d4b0228',
    '',
    '测试输出：',
    'FAIL',
    'ok 12 - 其他用例',
  ].join('\n');
  assert.deepEqual(parseQa(body), { result: 'PASS', commit: 'd4b0228' });
});

test('边界：裸结论不在首行时不算结论', () => {
  const body = '# QA 报告\n\nPASS\n被测 commit：d4b0228\n';
  assert.equal(parseQa(body), null);
});

test('边界：一条评论贴两轮记录时，结论与 commit 取最后一组', () => {
  const body = [
    'QA 结论：FAIL',
    '被测 commit：9741830',
    '',
    '修复后：',
    'QA 结论：PASS',
    '被测 commit：a3110ad',
  ].join('\n');
  assert.deepEqual(parseQa(body), { result: 'PASS', commit: 'a3110ad' });
});

test('边界：多轮记录的 fail_count 由 qaRounds 全量统计', () => {
  const body = 'QA 结论：FAIL\n被测 commit：9741830\nQA 结论：PASS\n被测 commit：a3110ad';
  assert.deepEqual(qaRounds(body), ['FAIL', 'PASS']);
});

// 元测试：只检查形式（注释存在、引用的用例存在），不检查改动是否合理。
// 「必须有真实失败样本才能改」无法自动化，那条只能靠人守。
test('元：每条顶层正则上方都有 // test: 注释，且引用的用例确实存在', async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const src = await read('../scripts/collect.mjs');
  const specs = await read('./collect.test.mjs');
  const lines = src.split(/\r?\n/);
  const isRegexDef = (l) => /^const\s+[A-Za-z_$][\w$]*\s*=\s*(\/|new RegExp\()/.test(l);

  const defs = lines.map((l, i) => ({ l, i })).filter(({ l }) => isRegexDef(l));
  assert.ok(defs.length >= 5, `预期至少 5 条顶层正则，实际找到 ${defs.length}`);

  for (const { l, i } of defs) {
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    const comment = lines[j] ?? '';
    const head = l.trim().slice(0, 48);
    assert.ok(comment.startsWith('// test: '), `${head} 上方缺少 // test: 注释`);

    const names = comment.slice(9).split(' / ').map((s) => s.trim()).filter(Boolean);
    assert.ok(names.length > 0, `${head} 的 // test: 注释没有引用任何用例`);
    for (const name of names) {
      assert.ok(specs.includes(name), `${head} 引用的用例不存在于测试文件：${name}`);
    }
  }
});
