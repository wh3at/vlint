import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_RULES_63_CONTAINER;
const environments = [
  { name: "chromium", platform: "windows", browser: "chromium", devices: ["desktop"] },
  { name: "firefox", platform: "windows", browser: "firefox", devices: ["desktop"] },
  { name: "webkit", platform: "macos", browser: "webkit", devices: ["desktop"] },
];

const pages = new Map<string, string>();
const server = container ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const html = pages.get(new URL(request.url).pathname);
  return new Response(html ?? "not found", { status: html ? 200 : 404, headers: { "content-type": "text/html" } });
} }) : null;
afterAll(() => server?.stop(true));

async function check(html: string, rules: unknown[]) {
  const directory = await mkdtemp(resolve("tests/fixtures/rules-63-"));
  const pathname = `/${Bun.hash(html)}`;
  pages.set(pathname, html);
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }], environments, rules,
      provider: { type: "static", targets: [{ name: "fixture", url: `http://127.0.0.1:${server!.port}${pathname}` }] },
    }));
    const process = Bun.spawn(["docker", "exec", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", `/lane/tests/fixtures/${directory.split("/").at(-1)}`, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (!stdout.trim()) throw new Error(`${code}: ${stderr}`);
    const output = JSON.parse(stdout);
    expect(output.reportPath).toBeString();
    expect(output.cases).toBeUndefined();
    const report = Bun.spawn(["docker", "exec", container!, "cat", output.reportPath], { stdout: "pipe" });
    const result = JSON.parse(await new Response(report.stdout).text());
    expect(await report.exited).toBe(0);
    expect(output.status).toBe(result.status);
    for (const item of result.cases) {
      for (const rule of item.rules) {
        const summary = output.environmentRules.find((row: any) => row.environment === item.environment && row.rule === rule.name);
        expect(summary.elementsInspected).toBe(rule.elementsInspected);
      }
    }
    expect(result.execution.environments.map(({ userAgent, ...environment }: any) => environment)).toEqual(environments);
    expect(result.execution.engines.map((engine: any) => engine.engine)).toEqual(["chromium", "firefox", "webkit"]);
    for (const engine of result.execution.engines) {
      expect(engine.obtainedVersion).toMatch(/^\d+\.\d+/);
      expect(engine.obtainedVersion).toBe(engine.expectedVersion);
      expect(engine.diagnostic).toBeNull();
    }
    expect(result.cases.map((item: any) => [item.environment, item.device.name])).toEqual(environments.map((item) => [item.name, "desktop"]));
    return { code, result };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

(container ? test : test.skip)("compiled header generated content is unmeasurable, not clean zero, in each engine", async () => {
  let previous: unknown;
  for (let repetition = 0; repetition < 3; repetition++) {
    const { code, result } = await check('<!doctype html><style>th::before { content: "generated" }</style><table><thead><tr><th id="header">label</th></tr></thead></table>', [{ name: "headers", type: "table-header-single-line" }]);
    expect(code).toBe(2);
    const measured = result.cases.map((item: any) => ({ environment: item.environment, rule: item.rules.find((entry: any) => entry.name === "headers") }));
    expect(measured.map((item: any) => [item.environment, item.rule.status, item.rule.elementsInspected, item.rule.failure?.code])).toEqual(environments.map((item) => [item.name, "failed", 0, "generated-content-unsupported"]));
    for (const item of measured) expect(item.rule.candidateDiagnostics).toEqual([{ kind: "generated-content-unmeasured", locator: "#header" }]);
    if (previous) expect(measured).toEqual(previous);
    previous = measured;
  }
}, 120_000);

const ruleNames = ["tab-label-single-line", "table-header-single-line", "page-horizontal-overflow"];
const measuredRules = [
  { name: ruleNames[0], type: ruleNames[0], excludeSelectors: [".excluded"] },
  { name: ruleNames[1], type: ruleNames[1], excludeSelectors: [".excluded"] },
  { name: ruleNames[2], type: ruleNames[2] },
  { name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: false },
  { name: "svg-text-clipping", type: "svg-text-clipping", enabled: false },
];

function facts(result: any) {
  return result.cases.map((item: any) => ({
    environment: item.environment, device: item.device.name, status: item.status,
    rules: item.rules.filter((rule: any) => ruleNames.includes(rule.name)).map((rule: any) => ({
      name: rule.name, status: rule.status, elementsInspected: rule.elementsInspected,
      violations: rule.violations, failure: rule.failure, candidateDiagnostics: rule.candidateDiagnostics,
    })),
  }));
}

(container ? test : test.skip)("compiled single-line and overflow fixtures retain exact violations, exclusions, counts and repeated geometry per engine", async () => {
  const html = '<!doctype html><style>body{margin:0;font:16px/20px monospace}.label{display:block;width:120px}#overflow{width:1000px;height:10px}.hidden{display:none}th{text-align:left;padding:0;font-weight:normal}table{border-collapse:collapse;table-layout:fixed;width:120px}</style><div role="tab" id="tab-clean" class="label">short</div><div role="tab" id="tab-wrap" class="label">first<br>second</div><div role="tab" class="excluded label">excluded<br>text</div><div role="tab" class="hidden">hidden</div><table><thead><tr><th id="header-clean">short</th></tr><tr><th id="header-wrap">first<br>second</th></tr><tr><th class="excluded">excluded<br>text</th></tr></thead><tbody><tr><th scope="row">row<br>header</th></tr></tbody></table><div id="overflow"></div>';
  let previous: unknown;
  for (let repetition = 0; repetition < 3; repetition++) {
    const { code, result } = await check(html, measuredRules);
    expect(code).toBe(1);
    const measured = facts(result);
    console.log(JSON.stringify(measured));
    expect(measured.map((item: any) => [item.environment, item.device, item.status])).toEqual(environments.map((item) => [item.name, "desktop", "complete"]));
    for (const item of measured) {
      const tabs = item.rules.find((rule: any) => rule.name === ruleNames[0]);
      const headers = item.rules.find((rule: any) => rule.name === ruleNames[1]);
      const overflow = item.rules.find((rule: any) => rule.name === ruleNames[2]);
      expect([tabs.status, tabs.elementsInspected, tabs.violations.map((v: any) => [v.locator, v.lineCount])]).toEqual(["violations", 2, [["#tab-wrap", 2]]]);
      expect([headers.status, headers.elementsInspected, headers.violations.map((v: any) => [v.locator, v.lineCount])]).toEqual(["violations", 2, [["#header-wrap", 2]]]);
      expect(headers.candidateDiagnostics).toHaveLength(1);
      expect(headers.candidateDiagnostics[0].kind).toBe("excluded");
      expect(overflow.status).toBe("violations");
      expect(overflow.violations.map((v: any) => [v.locator, v.geometry.width, v.overflowPx, v.computedStyle.width])).toEqual([["#overflow", 1000, 200, "1000px"]]);
      expect(overflow.elementsInspected).toBe(22);
    }
    if (previous) expect(measured).toEqual(previous);
    previous = measured;
  }
}, 120_000);

(container ? test : test.skip)("compiled single-line rules count only rendered eligible targets and local scrolling is not page overflow", async () => {
  const html = '<!doctype html><style>body{margin:0;font:16px/20px monospace}.hidden{display:none}.scroll{width:200px;overflow-x:auto}.wide{width:1000px}</style><div role="tab" id="tab-clean">short</div><div role="tab" class="excluded">excluded<br>text</div><div role="tab" class="hidden">hidden</div><table><thead><tr><th id="header-clean">short</th><th class="excluded">excluded<br>text</th><th class="hidden">hidden</th></tr></thead><tbody><tr><th scope="row">row<br>header</th></tr></tbody></table><div class="scroll"><div class="wide">local overflow</div></div>';
  let previous: unknown;
  for (let repetition = 0; repetition < 3; repetition++) {
    const { code, result } = await check(html, measuredRules);
    expect(code).toBe(0);
    const measured = facts(result);
    for (const item of measured) {
      expect(item.rules.map((rule: any) => [rule.name, rule.status, rule.elementsInspected, rule.violations])).toEqual([
        [ruleNames[0], "clean", 1, []], [ruleNames[1], "clean", 1, []], [ruleNames[2], "clean", 0, []],
      ]);
    }
    if (previous) expect(measured).toEqual(previous);
    previous = measured;
  }
  let excludedPrevious: unknown;
  for (let repetition = 0; repetition < 3; repetition++) {
    const empty = await check('<!doctype html><div role="tab" class="excluded">excluded</div><table><thead><tr><th class="excluded">excluded</th></tr></thead></table>', measuredRules);
    expect(empty.code).toBe(0);
    const measured = facts(empty.result);
    for (const item of measured) expect(item.rules.map((rule: any) => [rule.status, rule.elementsInspected])).toEqual([["clean", 0], ["clean", 0], ["clean", 0]]);
    if (excludedPrevious) expect(measured).toEqual(excludedPrevious);
    excludedPrevious = measured;
  }
}, 120_000);

(container ? test : test.skip)("compiled tab generated content and label cardinality fail without discarding other rules", async () => {
  for (const [html, configuration, expected] of [
    ['<!doctype html><style>#tab::before{content:"generated"}</style><div role="tab" id="tab">label</div>', {}, "generated-content-unsupported"],
    ['<!doctype html><div role="tab" id="tab"><span>one</span><span>two</span></div>', { labelSelector: "span" }, "label-selector-cardinality"],
  ] as const) {
    const rules = measuredRules.map((rule) => rule.name === ruleNames[0] ? { ...rule, ...configuration } : rule);
    let previous: unknown;
    for (let repetition = 0; repetition < 3; repetition++) {
      const { code, result } = await check(html, rules);
      expect(code).toBe(2);
      const measured = facts(result);
      for (const item of measured) {
        const tabs = item.rules.find((rule: any) => rule.name === ruleNames[0]);
        expect([tabs.status, tabs.elementsInspected, tabs.failure.code]).toEqual(["failed", 0, expected]);
        expect(item.rules.filter((rule: any) => rule.name !== ruleNames[0]).every((rule: any) => rule.status === "clean")).toBe(true);
      }
      if (previous) expect(measured).toEqual(previous);
      previous = measured;
    }
  }
}, 120_000);

(container ? test : test.skip)("compiled overflow measurement failure stays incomplete and retains successful independent rules in every engine", async () => {
  const html = '<!doctype html><style>body{margin:0}#unmeasurable{width:1000px;height:20px}</style><div role="tab">short</div><table><thead><tr><th>short</th></tr></thead></table><div id="unmeasurable"></div><script>document.getElementById("unmeasurable").getBoundingClientRect = () => { throw new Error("fixture geometry unavailable") }</script>';
  let previous: unknown;
  for (let repetition = 0; repetition < 3; repetition++) {
    const { code, result } = await check(html, measuredRules);
    expect(code).toBe(2);
    const measured = facts(result);
    expect(measured).toHaveLength(3);
    for (const item of measured) {
      const overflow = item.rules.find((rule: any) => rule.name === ruleNames[2]);
      expect([overflow.status, overflow.elementsInspected, overflow.failure.code]).toEqual(["failed", 0, "rule-script-failed"]);
      expect(item.rules.filter((rule: any) => rule.name !== ruleNames[2]).map((rule: any) => [rule.status, rule.elementsInspected])).toEqual([["clean", 1], ["clean", 1]]);
    }
    if (previous) expect(measured).toEqual(previous);
    previous = measured;
  }
}, 120_000);
