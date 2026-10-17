import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readReport } from "./docker-exec";

const container = process.env.VLINT_TABLE_CELL_CONTAINER;

(container ? test : test.skip)("compiled table-cell clipping distinguishes unavailable Canvas and repeats stable three-engine coverage", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/table-cell-64-"));
  const paths = ["/clean", "/violation", "/excluded", "/outside", "/unmeasurable"];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<html><body><style>table{table-layout:fixed;width:200px;border-spacing:0;margin-bottom:20px}td{width:100px;padding:0;font:20px monospace;white-space:nowrap}span{display:block;${path === "/clean" || path === "/unmeasurable" ? "clip-path:path('M0 0H100V100H0Z')" : ""}}</style>
      <table ${path === "/outside" ? 'style="display:none"' : ''}><tr><td id="source" ${path === "/excluded" ? 'class="excluded"' : ''}><span>MMMMMMMMMMMMMMMM</span></td><td id="neighbor" class="excluded"></td></tr></table>
      ${path === "/unmeasurable" ? '<script>HTMLCanvasElement.prototype.getContext=function(){return null}</script>' : ''}</body></html>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: [{ name: "chromium", platform: "windows", browser: "chromium", devices: ["desktop"] }, { name: "firefox", platform: "windows", browser: "firefox", devices: ["desktop"] }, { name: "webkit", platform: "macos", browser: "webkit", devices: ["desktop"] }],
      rules: [{ name: "cells", type: "table-cell-text-overlap", excludeSelectors: [".excluded"] }, { name: "overflow", type: "page-horizontal-overflow" }],
      provider: { type: "static", targets: paths.map((path) => ({ name: path, url: `http://127.0.0.1:${server.port}${path}` })) },
    }));
    let baseline: unknown;
    for (let repetition = 0; repetition < 3; repetition++) {
      const proc = Bun.spawn(["docker", "exec", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", `/lane/tests/fixtures/${directory.split("/").at(-1)}`, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (!stdout.trim()) throw new Error(`${code}: ${stderr}`);
      const summary = JSON.parse(stdout);
      const result = await readReport(container!, summary.reportPath);
      expect(code).toBe(2);
      expect(summary.status).toBe("incomplete");
      expect(result.cases).toHaveLength(15);
      expect(result.cases.map((item: any) => [item.target.name, item.environment])).toEqual(paths.flatMap(path => ["chromium", "firefox", "webkit"].map(engine => [path, engine])));
      expect(result.execution.engines.every((engine: any) => engine.obtainedVersion !== null)).toBe(true);
      for (const item of result.cases) {
        const cells = item.rules.find((rule: any) => rule.name === "cells");
        expect(item.rules.find((rule: any) => rule.name === "tab-label-single-line").status).toBe("clean");
        expect(item.rules.find((rule: any) => rule.name === "overflow").status).toBe("clean");
        if (item.target.name === "/unmeasurable") {
          expect(item.status).toBe("failed");
          expect(cells.status).toBe("failed");
          expect(cells.failure.code).toBe("rule-script-failed");
        } else {
          expect(item.status).toBe("complete");
          expect(cells.elementsInspected).toBe(["/outside", "/excluded"].includes(item.target.name) ? 0 : 1);
          expect(cells.status).toBe(item.target.name === "/violation" ? "violations" : "clean");
          if (item.target.name === "/violation") {
            expect(cells.violations).toHaveLength(1);
            expect(cells.violations[0]).toMatchObject({ type: "table-cell-text-overlap", locator: "#source", adjacentLocator: "#neighbor" });
            expect(cells.violations[0].overlapPx).toBeGreaterThan(1);
          } else expect(cells.violations).toEqual([]);
        }
      }
      const observed = result.cases.map((item: any) => ({ environment: item.environment, target: item.target.name, status: item.status, rules: item.rules }));
      if (repetition === 0) {
        baseline = observed;
        console.log(JSON.stringify({ engines: result.execution.engines, cases: observed }));
      } else expect(observed).toEqual(baseline);
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);

(container ? test : test.skip)("compiled table-cell existing clipping and neighbor contracts hold across three engines", async () => {
  const fixtures = [
    { page: "table-cell-text-overlap-edges.html", count: 19, ids: ["spanning", "positioned-body", "positioned-outside", "escapes-overflow"], adjacent: ["second-row-neighbor", "positioned-neighbor", "outside-neighbor", "overflow-neighbor"] },
    { page: "table-cell-text-overlap-clipping.html", count: 30, ids: ["rounded-edge", "scaled-up", "circle-default", "ellipse-default", "round-inflated", "path-visible", "url-visible"] },
    { page: "table-cell-text-overlap-clip-shapes.html", count: 26, ids: ["round-inset", "path-wide", "url-round-rect", "obb-full", "url-negative-rx"] },
  ];
  const directory = await mkdtemp(resolve("tests/fixtures/table-cell-regression-64-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const page = new URL(request.url).pathname.slice(1);
    if (!fixtures.some(fixture => fixture.page === page)) return new Response("missing", { status: 404 });
    return new Response(Bun.file(resolve("tests/fixtures/app/pages", page)), { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "narrow", viewport: { width: 390, height: 720 }, screen: { width: 390, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: [{ name: "chromium", platform: "windows", browser: "chromium", devices: ["narrow"] }, { name: "firefox", platform: "windows", browser: "firefox", devices: ["narrow"] }, { name: "webkit", platform: "macos", browser: "webkit", devices: ["narrow"] }],
      provider: { type: "static", targets: fixtures.map(fixture => ({ name: fixture.page, url: `http://127.0.0.1:${server.port}/${fixture.page}` })) },
    }));
    let baseline: unknown;
    for (let repetition = 0; repetition < 3; repetition++) {
      const proc = Bun.spawn(["docker", "exec", "-w", `/lane/tests/fixtures/${directory.split("/").at(-1)}`, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (!stdout.trim()) throw new Error(`${code}: ${stderr}`);
      expect(code).toBe(1);
      const summary = JSON.parse(stdout);
      const report = await readReport(container!, summary.reportPath);
      expect(report.cases).toHaveLength(9);
      for (const item of report.cases) {
        const fixture = fixtures.find(fixture => fixture.page === item.target.name)!;
        const cells = item.rules.find((rule: any) => rule.type === "table-cell-text-overlap");
        expect(item.status).toBe("complete");
        expect(cells.status).toBe("violations");
        expect(cells.elementsInspected).toBe(fixture.count);
        expect(cells.violations.map((violation: any) => [violation.locator, violation.adjacentLocator])).toEqual(fixture.ids.map((id, index) => [`#${id}`, `#${fixture.adjacent?.[index] ?? `${id}-neighbor`}`]));
      }
      const observed = report.cases.map((item: any) => ({ environment: item.environment, target: item.target.name, rules: item.rules }));
      if (repetition === 0) baseline = observed;
      else expect(observed).toEqual(baseline);
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);
