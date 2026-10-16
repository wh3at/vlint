import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { exec } from "./docker-exec";

const container = process.env.VLINT_SVG_LOCAL_CONTAINER;
const engines = ["windows:chromium", "windows:firefox", "macos:webkit"];

(container ? test : test.skip)("compiled SVG and local evaluations retain three-engine facts, isolate failure and repeat stably", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/svg-local-65-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const modes = ["clean", "violation", "excluded", "unmeasurable", "canvas-unavailable", "local-throw", "local-invalid", "local-violation"];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const script = mode === "unmeasurable" ? 'SVGGraphicsElement.prototype.getScreenCTM = () => null;' : mode === "canvas-unavailable" ? 'HTMLCanvasElement.prototype.getContext = () => null;' : "";
    return new Response(`<!doctype html><body data-mode="${mode}"><svg width="100" height="60" style="overflow:hidden;font:20px Arial"><text id="ink" x="${mode === "violation" ? 85 : 10}" y="30">Hello</text><text id="excluded" x="95" y="30">Excluded</text><text id="unsupported" x="95" y="30" transform="rotate(5)">Rotated</text><defs><text id="definition" x="95" y="30">Definition</text></defs></svg><script>${script}</script>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "probe.ts"), `export default {
      contractVersion: 1,
      metadata: { name: "svg-local-probe" },
      settingsSchema: { type: "object", exactKeys: [] },
      evaluate: async () => {
        const mode = document.body.dataset.mode;
        if (mode === "local-throw") throw new Error("fixture failure");
        if (mode === "local-invalid") return { elementsInspected: -1, violations: [] };
        const ink = document.querySelector("#ink");
        if (!ink) throw new Error("missing fixture ink");
        const rect = ink.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0) throw new Error("invalid fixture geometry");
        return { elementsInspected: 1, violations: mode === "local-violation" ? [{ message: "fixture local violation", locator: "#ink", geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, details: { candidate: ink.id } }] : [] };
      }
    };`);
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: engines.map(pair => { const [platform, browser] = pair.split(":"); return { name: pair, platform, browser, devices: ["desktop"] }; }),
      rules: [{ name: "svg", type: "svg-text-clipping", excludeSelectors: ["#excluded"] }, { name: "probe", type: "local", path: "probe.ts" }, { name: "after", type: "local", path: "after.ts" }],
      provider: { type: "static", targets: modes.map(mode => ({ name: mode, url: `http://127.0.0.1:${server.port}/${mode}`, ruleOverrides: mode === "excluded" ? { svg: { excludeSelectors: ["#ink", "#excluded"] } } : {} })) },
    }));
    await writeFile(join(directory, "after.ts"), 'export default { contractVersion: 1, metadata: { name: "after" }, settingsSchema: { type: "object", exactKeys: [] }, evaluate: async () => ({ elementsInspected: 1, violations: [] }) };');
    const observations: unknown[] = [];
    for (let repetition = 0; repetition < 2; repetition++) {
      const output = await exec(["-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"]);
      if (!output.stdout.trim()) throw new Error(output.stderr);
      const summary = JSON.parse(output.stdout);
      const stored = await exec([container!, "cat", summary.reportPath]);
      expect(stored.code).toBe(0);
      const report = JSON.parse(stored.stdout);
      expect(output.code).toBe(2);
      expect(report.status).toBe("incomplete");
      expect(report.cases).toHaveLength(modes.length * engines.length);
      expect(report.execution.engines.map((engine: any) => engine.engine).sort()).toEqual(["chromium", "firefox", "webkit"]);
      expect(report.execution.engines.every((engine: any) => engine.obtainedVersion !== null)).toBe(true);
      console.log(JSON.stringify({ repetition, engines: report.execution.engines }));
      const stable = report.cases.map((item: any) => {
        const mode = item.target.name;
        const svg = item.rules.find((rule: any) => rule.name === "svg");
        const probe = item.rules.find((rule: any) => rule.name === "probe");
        const after = item.rules.find((rule: any) => rule.name === "after");
        expect(engines).toContain(item.environment);
        const unavailable = ["unmeasurable", "canvas-unavailable"].includes(mode);
        expect(svg.status).toBe(unavailable ? "failed" : mode === "violation" ? "violations" : "clean");
        expect(svg.elementsInspected).toBe(unavailable || mode === "excluded" ? 0 : 1);
        expect(svg.failure?.code ?? null).toBe(unavailable ? "geometry-evaluation-failed" : null);
        expect(svg.violations.map((violation: any) => violation.locator)).toEqual(mode === "violation" ? ["#ink"] : []);
        if (mode === "violation") {
          expect(svg.violations[0].directions).toEqual(["right"]);
          expect(svg.violations[0].geometry.width).toBeGreaterThan(20);
        }
        const localFailed = ["local-throw", "local-invalid"].includes(mode);
        expect(probe.status).toBe(localFailed ? "failed" : mode === "local-violation" ? "violations" : "clean");
        expect(probe.elementsInspected).toBe(localFailed ? 0 : 1);
        expect(probe.failure?.code ?? null).toBe(mode === "local-throw" ? "plugin-evaluator-invalid" : mode === "local-invalid" ? "local-fact-invalid" : null);
        expect(probe.violations.map((violation: any) => violation.locator)).toEqual(mode === "local-violation" ? ["#ink"] : []);
        if (mode === "local-violation") expect(probe.violations[0].details).toEqual({ candidate: "ink" });
        expect(after.status).toBe("clean");
        expect(after.elementsInspected).toBe(1);
        return { mode, environment: item.environment, status: item.status, rules: item.rules };
      });
      observations.push(stable);
    }
    expect(observations[1]).toEqual(observations[0]);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180000);
