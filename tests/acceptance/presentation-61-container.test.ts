import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_PRESENTATION_CONTAINER;
(container ? test : test.skip)("compiled three-engine terminal and JSON summarize coverage and expose only actionable details", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/presentation-61-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('<!doctype html><body style="margin:0"><div style="width:1200px">fixed</div>', { headers: { "content-type": "text/html" } });
  } });
  async function exec(args: string[]) {
    const proc = Bun.spawn(["docker", "exec", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  try {
    const url = `http://127.0.0.1:${server.port}/?raw=secret#fragment`;
    for (const [width, minimum, status, code] of [[1600, 0, "clean", 0], [800, 0, "violations", 1], [800, 1, "incomplete", 2]] as const) {
      await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
        devices: [{ name: "desktop", viewport: { width, height: 600 }, screen: { width, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
        environments: ["windows:chromium", "windows:firefox", "macos:webkit"].map(pair => { const [platform, browser] = pair.split(":"); return { name: pair, platform, browser, devices: ["desktop"] }; }),
        rules: [{ name: "overflow", type: "page-horizontal-overflow" }, { name: "tabs", type: "tab-label-single-line", minimumInspected: minimum }, { name: "off", type: "svg-text-clipping", enabled: false }],
        provider: { type: "static", targets: [{ name: "fixed", url }] },
      }));
      const output = await exec(["-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"]);
      if (output.code !== code) throw new Error(output.stdout + output.stderr);
      const result = JSON.parse(output.stdout);
      expect(result.status).toBe(status);
      expect(result.cases).toBeUndefined();
      expect(result.execution).toBeUndefined();
      expect(result.summary.cases.complete).toBe(status === "incomplete" ? 0 : 3);
      expect(result.environmentRules).toHaveLength(15);
      expect(result.environmentRules.find((row: any) => row.environment === "windows:chromium" && row.rule === "overflow")).toEqual({ environment: "windows:chromium", rule: "overflow", executions: 1, elementsInspected: status === "clean" ? 0 : 3, clean: status === "clean" ? 1 : 0, violations: status === "clean" ? 0 : 1, failed: 0, disabled: 0, notExecuted: 0 });
      expect(result.environmentRules.find((row: any) => row.rule === "off").disabled).toBe(1);
      const stored = await exec([container!, "cat", result.reportPath]);
      const report = JSON.parse(stored.stdout);
      expect(report.cases).toHaveLength(3);
      expect(report.execution.engines.every((engine: any) => engine.obtainedVersion !== null)).toBe(true);
      if (status === "clean") {
        expect(result.diagnostics).toEqual([]);
        expect(output.stdout).not.toContain(url);
      } else {
        expect(result.diagnostics[0].target.url).toBe(url);
        expect(result.diagnostics[0].actualUrl).toBe(url);
        expect(result.diagnostics[0].environment).toBe("windows:chromium");
        expect(result.diagnostics[0].device.name).toBe("desktop");
        expect(result.diagnostics[0].rules[0].violations[0].locator).toBeString();
      }
      const terminal = await exec(["-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check"]);
      expect(terminal.code).toBe(code);
      expect(terminal.stdout).toContain(`: ${status}`);
      expect(terminal.stdout).toContain(`environment=windows:chromium rule=overflow executions=1 elements=${status === "clean" ? 0 : 3}`);
      expect(terminal.stdout).toContain("reportPath:");
      if (status === "clean") expect(terminal.stdout).not.toContain("case target=");
      else expect(terminal.stdout).toContain(url);
      if (status === "incomplete") expect(terminal.stdout).toContain("minimum-inspected-unmet");
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180000);
