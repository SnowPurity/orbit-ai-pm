import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(rootDir, 'reports');
const junitPath = path.join(reportsDir, 'junit.xml');
const lcovPath = path.join(reportsDir, 'lcov.info');
const htmlPath = path.join(reportsDir, 'api-test-report.html');

type TestStatus = 'pass' | 'fail' | 'skip';

interface TestCase {
  suite: string;
  name: string;
  timeMs: number;
  status: TestStatus;
  message?: string;
}

interface FileCoverage {
  file: string;
  lines: Map<number, number>;
  lf: number;
  lh: number;
  brf: number;
  brh: number;
  fnf: number;
  fnh: number;
}

interface RouteInfo {
  method: string;
  path: string;
}

interface TestCall {
  method: string;
  url: string;
  test: string;
}

interface Endpoint extends RouteInfo {
  covered: boolean;
  calls: number;
  tests: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseJunit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const suiteMatch of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const suiteName = decodeXml(attrs(suiteMatch[1]).name ?? '默认套件');
    for (const caseMatch of suiteMatch[2].matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attributes = attrs(caseMatch[1]);
      const body = caseMatch[2] ?? '';
      const failure = body.match(/<failure\b([^>]*)>([\s\S]*?)<\/failure>/);
      const error = body.match(/<error\b([^>]*)>([\s\S]*?)<\/error>/);
      const skipped = /<skipped\b/.test(body);
      let status: TestStatus = 'pass';
      let message: string | undefined;
      if (skipped) status = 'skip';
      if (failure || error) {
        status = 'fail';
        const source = failure ?? error!;
        const detail = decodeXml(source[2] ?? '').trim();
        message = detail || decodeXml(attrs(source[1]).message ?? '测试失败');
      }
      cases.push({
        suite: suiteName,
        name: decodeXml(attributes.name ?? '未命名用例'),
        timeMs: Math.round(Number(attributes.time ?? 0) * 1000),
        status,
        message,
      });
    }
  }
  return cases;
}

function attrs(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    result[match[1]] = match[2];
  }
  return result;
}

function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      current = {
        file: line.slice(3),
        lines: new Map<number, number>(),
        lf: 0,
        lh: 0,
        brf: 0,
        brh: 0,
        fnf: 0,
        fnh: 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',');
      current.lines.set(Number(lineNumber), Number(hits));
    } else if (line.startsWith('LF:')) {
      current.lf = Number(line.slice(3));
    } else if (line.startsWith('LH:')) {
      current.lh = Number(line.slice(3));
    } else if (line.startsWith('BRF:')) {
      current.brf = Number(line.slice(4));
    } else if (line.startsWith('BRH:')) {
      current.brh = Number(line.slice(4));
    } else if (line.startsWith('FNF:')) {
      current.fnf = Number(line.slice(4));
    } else if (line.startsWith('FNH:')) {
      current.fnh = Number(line.slice(4));
    } else if (line === 'end_of_record') {
      if (current.file.startsWith('src/')) {
        if (current.lines.size > 0) {
          current.lf = current.lines.size;
          current.lh = [...current.lines.values()].filter((hits) => hits > 0).length;
        }
        files.push(current);
      }
      current = null;
    }
  }
  return files;
}

function parseRoutes(): RouteInfo[] {
  const source = fs.readFileSync(path.join(rootDir, 'src/http/routes.ts'), 'utf8');
  const routes: RouteInfo[] = [];
  for (const match of source.matchAll(/app\.(get|post|patch|put|delete)(?:<[^()]*>)?\(\s*'([^']+)'/g)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

function parseTestCalls(): TestCall[] {
  const testPath = path.join(rootDir, 'tests/api.test.ts');
  const source = fs.readFileSync(testPath, 'utf8');
  const testTitles: Array<{ index: number; name: string }> = [];
  for (const match of source.matchAll(/t\.test\(\s*'([^']+)'/g)) {
    testTitles.push({ index: match.index ?? 0, name: match[1] });
  }
  const fallback = source.match(/test\(\s*'([^']+)'/)?.[1] ?? 'API 集成测试';
  const calls: TestCall[] = [];
  for (const match of source.matchAll(
    /api(?:<[^()]*>)?\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*'([^']+)'/g,
  )) {
    const index = match.index ?? 0;
    const owner = [...testTitles].reverse().find((title) => title.index < index);
    calls.push({
      method: match[1],
      url: match[2].split('?')[0],
      test: owner?.name ?? fallback,
    });
  }
  return calls;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routeMatcher(routePath: string): RegExp {
  const pattern = routePath
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${pattern}$`);
}

function percent(hit: number, found: number): number | null {
  if (found === 0) return null;
  return Math.round((hit / found) * 1000) / 10;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function toneFor(value: number | null): string {
  if (value === null) return 'neutral';
  if (value >= 80) return 'good';
  if (value >= 60) return 'warn';
  return 'bad';
}

function coverageBar(label: string, hit: number, found: number): string {
  const value = percent(hit, found);
  const width = value ?? 0;
  return `<div class="metric">
  <div class="metric-head"><span>${label}</span><strong class="tone-${toneFor(value)}">${formatPercent(value)}</strong></div>
  <div class="bar"><span class="tone-${toneFor(value)}" style="width:${width}%"></span></div>
  <div class="metric-sub">${found > 0 ? `${hit} / ${found}` : '无可执行项'}</div>
</div>`;
}

function renderSource(file: string, coverage: FileCoverage): string {
  const absolute = path.join(rootDir, file);
  if (!fs.existsSync(absolute)) return '<p class="note">源文件不存在</p>';
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  const html = lines.map((text, index) => {
    const lineNumber = index + 1;
    const hits = coverage.lines.get(lineNumber);
    const state = hits === undefined ? '' : hits > 0 ? 'hit' : 'miss';
    const hint = hits === undefined ? '' : hits > 0 ? `已执行 ${hits} 次` : '未覆盖';
    return `<div class="line ${state}"${hint ? ` title="${hint}"` : ''}><span class="ln">${lineNumber}</span><span class="code">${escapeHtml(text) || ' '}</span></div>`;
  });
  return `<pre class="code-view">${html.join('')}</pre>`;
}

const startedAt = Date.now();
fs.mkdirSync(reportsDir, { recursive: true });
for (const file of [junitPath, lcovPath]) fs.rmSync(file, { force: true });

const testFiles = fs
  .readdirSync(path.join(rootDir, 'tests'))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => path.join('tests', file));

if (testFiles.length === 0) {
  console.error('未找到 tests/*.test.ts，无法生成报告。');
  process.exit(1);
}

const args = [
  '--import',
  'tsx',
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=junit',
  `--test-reporter-destination=${junitPath}`,
  '--test-reporter=lcov',
  `--test-reporter-destination=${lcovPath}`,
  ...testFiles,
];

console.log('运行接口测试并采集覆盖率...\n');
const run = spawnSync(process.execPath, args, {
  cwd: rootDir,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
const wallMs = Date.now() - startedAt;

process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');

if (run.error) {
  console.error(run.error);
  process.exit(1);
}

const specOutput = stripAnsi(run.stdout ?? '');
const specNumber = (label: string): number | undefined => {
  const match = specOutput.match(new RegExp(`^ℹ\\s*${label}\\s+([\\d.]+)\\s*$`, 'm'));
  return match ? Number(match[1]) : undefined;
};

if (!fs.existsSync(junitPath) || !fs.existsSync(lcovPath)) {
  console.error('测试运行未产出 JUnit/LCOV 文件，报告生成失败。');
  process.exit(run.status ?? 1);
}

const cases = parseJunit(fs.readFileSync(junitPath, 'utf8'));
const coverageFiles = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
const calls = parseTestCalls();
const routes = parseRoutes();
const endpoints: Endpoint[] = routes.map((route) => {
  const matcher = routeMatcher(route.path);
  const matched = calls.filter((call) => call.method === route.method && matcher.test(call.url));
  return {
    ...route,
    covered: matched.length > 0,
    calls: matched.length,
    tests: [...new Set(matched.map((call) => call.test))],
  };
});

const totalTests = specNumber('tests') ?? cases.length;
const passedTests = specNumber('pass') ?? cases.filter((item) => item.status === 'pass').length;
const failedTests = specNumber('fail') ?? cases.filter((item) => item.status === 'fail').length;
const skippedTests = specNumber('skipped') ?? cases.filter((item) => item.status === 'skip').length;
const testDurationMs = specNumber('duration_ms') ?? wallMs;
const suites = [...new Set(cases.map((item) => item.suite))];
const coveredEndpoints = endpoints.filter((item) => item.covered).length;

const overallLines = {
  hit: coverageFiles.reduce((sum, file) => sum + file.lh, 0),
  found: coverageFiles.reduce((sum, file) => sum + file.lf, 0),
};
const overallBranches = {
  hit: coverageFiles.reduce((sum, file) => sum + file.brh, 0),
  found: coverageFiles.reduce((sum, file) => sum + file.brf, 0),
};
const overallFunctions = {
  hit: coverageFiles.reduce((sum, file) => sum + file.fnh, 0),
  found: coverageFiles.reduce((sum, file) => sum + file.fnf, 0),
};

const allPassed = failedTests === 0;
const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 1000) / 10 : 0;
const endpointRate = percent(coveredEndpoints, endpoints.length);
const lineRate = percent(overallLines.hit, overallLines.found);
const branchRate = percent(overallBranches.hit, overallBranches.found);
const functionRate = percent(overallFunctions.hit, overallFunctions.found);

const generatedAt = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Shanghai',
}).format(new Date());

const suiteRows = suites
  .map((suite) => {
    const suiteCases = cases.filter((item) => item.suite === suite);
    const suiteFailed = suiteCases.filter((item) => item.status === 'fail').length;
    const suiteDuration = suiteCases.reduce((sum, item) => sum + item.timeMs, 0);
    const rows = suiteCases
      .map((item) => {
        const statusLabel = item.status === 'pass' ? '通过' : item.status === 'fail' ? '失败' : '跳过';
        const failureRow =
          item.status === 'fail' && item.message
            ? `<tr class="failure-row"><td colspan="3"><pre class="failure">${escapeHtml(item.message)}</pre></td></tr>`
            : '';
        return `<tr>
  <td>${escapeHtml(item.name)}</td>
  <td><span class="badge ${item.status}">${statusLabel}</span></td>
  <td class="num">${formatDuration(item.timeMs)}</td>
</tr>${failureRow}`;
      })
      .join('');
    return `<details class="suite" open>
  <summary>
    <span class="suite-name">${escapeHtml(suite)}</span>
    <span class="suite-meta">${suiteCases.length} 个子用例 · ${formatDuration(suiteDuration)}${suiteFailed > 0 ? ` · ${suiteFailed} 失败` : ''}</span>
  </summary>
  <table class="cases">
    <thead><tr><th>用例</th><th>状态</th><th class="num">耗时</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</details>`;
  })
  .join('');

const endpointRows = endpoints
  .map((endpoint) => {
    const method = endpoint.method.toLowerCase();
    const related = endpoint.tests.length > 0 ? endpoint.tests.slice(0, 2).join(' / ') : '—';
    const more = endpoint.tests.length > 2 ? ` 等 ${endpoint.tests.length} 个` : '';
    return `<tr data-covered="${endpoint.covered ? '1' : '0'}">
  <td><span class="method ${method}">${endpoint.method}</span></td>
  <td class="mono">${escapeHtml(endpoint.path)}</td>
  <td><span class="badge ${endpoint.covered ? 'pass' : 'warn'}">${endpoint.covered ? '已覆盖' : '未覆盖'}</span></td>
  <td class="num">${endpoint.calls}</td>
  <td class="muted">${escapeHtml(related)}${more}</td>
</tr>`;
  })
  .join('');

const sourceDetails = coverageFiles
  .slice()
  .sort((a, b) => a.file.localeCompare(b.file))
  .map((file) => {
    const lfRate = percent(file.lh, file.lf);
    const brRate = percent(file.brh, file.brf);
    const fnRate = percent(file.fnh, file.fnf);
    return `<details class="source">
  <summary>
    <span class="file">${escapeHtml(file.file)}</span>
    <span class="file-metric"><span>行</span><strong class="tone-${toneFor(lfRate)}">${formatPercent(lfRate)}</strong><i class="mini-bar"><b class="tone-${toneFor(lfRate)}" style="width:${lfRate ?? 0}%"></b></i></span>
    <span class="file-metric"><span>分支</span><strong class="tone-${toneFor(brRate)}">${formatPercent(brRate)}</strong><i class="mini-bar"><b class="tone-${toneFor(brRate)}" style="width:${brRate ?? 0}%"></b></i></span>
    <span class="file-metric"><span>函数</span><strong class="tone-${toneFor(fnRate)}">${formatPercent(fnRate)}</strong><i class="mini-bar"><b class="tone-${toneFor(fnRate)}" style="width:${fnRate ?? 0}%"></b></i></span>
  </summary>
  ${renderSource(file.file, file)}
</details>`;
  })
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit 接口测试报告</title>
<style>
  :root {
    --bg: #f4f6fa;
    --card: #ffffff;
    --ink: #172033;
    --muted: #64708a;
    --line: #e4e9f2;
    --accent: #2563eb;
    --good: #0f8a4a;
    --good-bg: #e7f7ee;
    --warn: #b7791f;
    --warn-bg: #fdf5e2;
    --bad: #c0392b;
    --bad-bg: #fdecea;
    --shadow: 0 1px 2px rgba(23, 32, 51, 0.05), 0 8px 28px rgba(23, 32, 51, 0.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .page { max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px; }
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 28px 32px;
    border-radius: 16px;
    background: linear-gradient(135deg, #172033 0%, #233a63 60%, #1d4ed8 100%);
    color: #fff;
    box-shadow: var(--shadow);
  }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.7; }
  h1 { margin: 6px 0 8px; font-size: 30px; letter-spacing: -0.02em; }
  .meta { margin: 0; font-size: 13px; opacity: 0.72; }
  .verdict {
    flex: none;
    padding: 12px 22px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.02em;
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.28);
  }
  .verdict.pass { color: #b7f7d0; }
  .verdict.fail { color: #ffd2cc; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 14px;
    margin: 20px 0;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: var(--shadow);
  }
  .card-label { font-size: 11px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .card-value { margin-top: 6px; font-size: 28px; font-weight: 700; line-height: 1.2; }
  .card-value span { font-size: 15px; font-weight: 500; color: var(--muted); }
  .card-sub { margin-top: 4px; font-size: 12px; color: var(--muted); }
  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 24px 26px;
    margin-top: 20px;
    box-shadow: var(--shadow);
  }
  .panel-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: -0.01em; }
  .chip {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    background: #eef2ff;
    color: #3451b2;
    font-size: 12px;
    font-weight: 600;
  }
  .bar { height: 8px; margin: 10px 0 6px; border-radius: 999px; background: #eaeef5; overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width 0.3s ease; }
  .bar > .tone-good { background: linear-gradient(90deg, #16a34a, #22c55e); }
  .bar > .tone-warn { background: linear-gradient(90deg, #d97706, #f59e0b); }
  .bar > .tone-bad { background: linear-gradient(90deg, #dc2626, #ef4444); }
  .bar > .tone-neutral { background: #cbd5e1; }
  .tone-good { color: var(--good); }
  .tone-warn { color: var(--warn); }
  .tone-bad { color: var(--bad); }
  .tone-neutral { color: var(--muted); }
  .filters { display: flex; gap: 8px; margin: 16px 0 10px; flex-wrap: wrap; }
  .filters button {
    border: 1px solid var(--line);
    background: #fff;
    color: var(--muted);
    padding: 5px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .filters button:hover { border-color: #c5d2e8; color: var(--ink); }
  .filters button.active { background: #172033; border-color: #172033; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 11px 12px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  tbody tr:hover { background: #fafbfe; }
  tbody tr:last-child td { border-bottom: none; }
  .mono { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; }
  .muted { color: var(--muted); font-size: 12.5px; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .method {
    display: inline-block;
    min-width: 54px;
    text-align: center;
    padding: 2px 8px;
    border-radius: 6px;
    font: 600 11px/1.5 "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.04em;
  }
  .method.get { background: #e8f0fe; color: #1a56c4; }
  .method.post { background: #e7f7ee; color: #0f8a4a; }
  .method.patch { background: #fdf5e2; color: #9a6408; }
  .method.put { background: #f3e8ff; color: #7e22ce; }
  .method.delete { background: #fdecea; color: #b3261e; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge.pass { background: var(--good-bg); color: var(--good); }
  .badge.fail { background: var(--bad-bg); color: var(--bad); }
  .badge.skip { background: #eef1f6; color: var(--muted); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .note { margin: 12px 0 0; font-size: 12.5px; color: var(--muted); }
  details.suite, details.source {
    border: 1px solid var(--line);
    border-radius: 12px;
    margin-top: 12px;
    overflow: hidden;
  }
  details.suite > summary, details.source > summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 16px;
    cursor: pointer;
    background: #fafbfe;
    list-style: none;
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 5px solid #94a3b8;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 0.15s ease;
    flex: none;
  }
  details[open] > summary::before { transform: rotate(90deg); }
  .suite-name, .file { font-weight: 600; font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  .suite-meta { color: var(--muted); font-size: 12px; }
  .cases { border-top: 1px solid var(--line); }
  .failure-row td { background: #fff8f7; padding-top: 0; }
  .failure {
    margin: 0;
    padding: 12px 14px;
    border-radius: 8px;
    background: #fdecea;
    color: #8f1d14;
    font-size: 12px;
    white-space: pre-wrap;
    overflow-x: auto;
  }
  .coverage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 22px; margin: 18px 0 8px; }
  .metric-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; }
  .metric-head strong { font-size: 18px; }
  .metric-sub { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  details.source > summary { display: grid; grid-template-columns: minmax(170px, 1.5fr) repeat(3, minmax(120px, 1fr)); }
  .file-metric { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .file-metric strong { font-size: 12.5px; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
  .mini-bar { flex: 1; height: 5px; border-radius: 999px; background: #eaeef5; overflow: hidden; }
  .mini-bar > b { display: block; height: 100%; border-radius: 999px; background: #cbd5e1; }
  .mini-bar > b.tone-good { background: #22c55e; }
  .mini-bar > b.tone-warn { background: #f59e0b; }
  .mini-bar > b.tone-bad { background: #ef4444; }
  .code-view {
    margin: 0;
    max-height: 440px;
    overflow: auto;
    background: #0f172a;
    color: #dbe4f0;
    font: 12px/1.55 "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    padding: 10px 0;
  }
  .line { display: flex; min-height: 18px; }
  .line.hit { background: rgba(34, 197, 94, 0.07); }
  .line.miss { background: rgba(239, 68, 68, 0.22); }
  .ln {
    flex: none;
    width: 56px;
    padding-right: 14px;
    text-align: right;
    color: #64748b;
    user-select: none;
  }
  .code { white-space: pre; color: inherit; }
  .legend { display: flex; gap: 18px; margin: 14px 0 4px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .legend .hit { background: rgba(34, 197, 94, 0.5); }
  .legend .miss { background: rgba(239, 68, 68, 0.75); }
  .how pre {
    margin: 12px 0 0;
    padding: 16px 18px;
    border-radius: 10px;
    background: #0f172a;
    color: #dbe4f0;
    font: 12.5px/1.8 "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    overflow-x: auto;
  }
  .how code { color: #93c5fd; }
  footer { margin-top: 26px; font-size: 12px; color: var(--muted); text-align: center; }
  .controls { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
  .ghost-btn {
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
    padding: 6px 14px;
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .ghost-btn:hover { border-color: #c5d2e8; }
  @media (max-width: 760px) {
    .hero { flex-direction: column; align-items: flex-start; }
    details.source > summary { grid-template-columns: 1fr; gap: 8px; }
    .panel { padding: 18px; }
  }
  @media print {
    body { background: #fff; }
    .page { padding: 0; }
    .filters, .controls, nav, footer { display: none; }
    details.source { display: none; }
    .panel, .card, .hero { box-shadow: none; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="hero">
    <div>
      <div class="eyebrow">Orbit · AI-native Project Management</div>
      <h1>接口测试报告</h1>
      <p class="meta">生成于 ${escapeHtml(generatedAt)}（Asia/Shanghai） · Node ${escapeHtml(process.version)} · ${escapeHtml(process.platform)} ${escapeHtml(process.arch)}</p>
    </div>
    <div class="verdict ${allPassed ? 'pass' : 'fail'}">${allPassed ? '全部通过' : `${failedTests} 项失败`}</div>
  </header>

  <section class="cards">
    <div class="card">
      <div class="card-label">测试通过</div>
      <div class="card-value">${passedTests}<span> / ${totalTests}</span></div>
      <div class="card-sub">通过率 ${passRate.toFixed(1)}% · ${skippedTests} 跳过</div>
    </div>
    <div class="card">
      <div class="card-label">失败</div>
      <div class="card-value" style="color:${failedTests > 0 ? 'var(--bad)' : 'var(--good)'}">${failedTests}</div>
      <div class="card-sub">${suites.length} 个套件 · ${cases.length} 个子用例</div>
    </div>
    <div class="card">
      <div class="card-label">测试耗时</div>
      <div class="card-value">${formatDuration(Math.round(testDurationMs))}</div>
      <div class="card-sub">总墙钟时间 ${formatDuration(wallMs)}</div>
    </div>
    <div class="card">
      <div class="card-label">接口覆盖</div>
      <div class="card-value">${coveredEndpoints}<span> / ${endpoints.length}</span></div>
      <div class="card-sub">${formatPercent(endpointRate)} 的路由被测试调用</div>
    </div>
    <div class="card">
      <div class="card-label">行覆盖率</div>
      <div class="card-value">${formatPercent(lineRate)}</div>
      <div class="card-sub">分支 ${formatPercent(branchRate)} · 函数 ${formatPercent(functionRate)}</div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>接口覆盖矩阵</h2>
      <span class="chip">${coveredEndpoints} / ${endpoints.length} 已覆盖</span>
    </div>
    <div class="bar"><span class="tone-${toneFor(endpointRate)}" style="width:${endpointRate ?? 0}%"></span></div>
    <div class="filters">
      <button type="button" data-ep-filter="all" class="active">全部 ${endpoints.length}</button>
      <button type="button" data-ep-filter="1">已覆盖 ${coveredEndpoints}</button>
      <button type="button" data-ep-filter="0">未覆盖 ${endpoints.length - coveredEndpoints}</button>
    </div>
    <table class="endpoints">
      <thead><tr><th>方法</th><th>路径</th><th>状态</th><th class="num">调用</th><th>关联用例</th></tr></thead>
      <tbody>${endpointRows}</tbody>
    </table>
    <p class="note">矩阵通过静态匹配 <code>tests/api.test.ts</code> 中的请求与 <code>src/http/routes.ts</code> 的路由得出，表示该端点被测试调用过，不代表断言已覆盖所有分支。</p>
  </section>

  <section class="panel">
    <h2>测试用例</h2>
    <p class="note" style="margin-top:6px">集成测试使用 Fastify 进程内 <code>app.inject</code>，覆盖鉴权、子任务约束、hook/cron 自动化、Agent Job 生命周期、乐观锁与事件流。</p>
    ${suiteRows || '<p class="note">没有解析到测试用例。</p>'}
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>代码覆盖率</h2>
      <span class="chip">仅统计 src/</span>
    </div>
    <div class="coverage-grid">
      ${coverageBar('行覆盖', overallLines.hit, overallLines.found)}
      ${coverageBar('分支覆盖', overallBranches.hit, overallBranches.found)}
      ${coverageBar('函数覆盖', overallFunctions.hit, overallFunctions.found)}
    </div>
    <div class="controls">
      <div class="legend"><span><i class="hit"></i>已执行</span><span><i class="miss"></i>未覆盖</span></div>
      <button type="button" class="ghost-btn" id="toggle-sources" data-open="0">展开全部源码</button>
    </div>
    ${sourceDetails || '<p class="note">没有采集到源码覆盖率。</p>'}
  </section>

  <section class="panel how">
    <h2>如何复现</h2>
    <pre><code>npm run test:report   # 运行接口测试并生成本报告
npm test              # 仅运行集成测试
npm run smoke:mcp     # MCP 协议冒烟测试
open reports/api-test-report.html</code></pre>
    <p class="note">覆盖率由 Node 内置 V8 coverage 结合 tsx source map 生成；报告与 junit.xml、lcov.info 均输出在 <code>reports/</code> 目录。</p>
  </section>

  <footer>Orbit API test report · ${escapeHtml(generatedAt)}</footer>
</div>
<script>
  document.querySelectorAll('[data-ep-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-ep-filter]').forEach((item) => item.classList.toggle('active', item === button));
      const filter = button.dataset.epFilter;
      document.querySelectorAll('tr[data-covered]').forEach((row) => {
        row.hidden = filter !== 'all' && row.dataset.covered !== filter;
      });
    });
  });
  const toggle = document.getElementById('toggle-sources');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const expand = toggle.dataset.open !== '1';
      document.querySelectorAll('details.source').forEach((item) => { item.open = expand; });
      toggle.dataset.open = expand ? '1' : '0';
      toggle.textContent = expand ? '收起全部源码' : '展开全部源码';
    });
  }
</script>
</body>
</html>
`;

fs.writeFileSync(htmlPath, html, 'utf8');

console.log(`\nHTML 报告已生成: ${path.relative(rootDir, htmlPath)}`);
console.log(`JUnit: ${path.relative(rootDir, junitPath)} · LCOV: ${path.relative(rootDir, lcovPath)}`);

if ((run.status ?? 1) !== 0) {
  console.error(`\n有 ${failedTests} 个测试失败，详见报告。`);
}
process.exit(run.status ?? 1);
