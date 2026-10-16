import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_REPORT_CONTAINER;
(container ? test : test.skip)("compiled three-engine reports retain clean, violating, and incomplete same-run evidence", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/report-60-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  let visits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    visits++;
    return new Response('<!doctype html><html><body style="margin:0"><div style="width:1200px">fixed</div></body></html>', { headers: { "content-type": "text/html" } });
  } });
  async function exec(args: string[]) {
    const proc = Bun.spawn(["docker", "exec", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  try {
    const url = `http://127.0.0.1:${server.port}/?raw=secret#fragment`;
    for (const [width, minimum, status, code] of [[1600, 0, "clean", 0], [800, 0, "violations", 1], [1600, 2, "incomplete", 2]] as const) {
      await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
        devices: [{ name: "desktop", viewport: { width, height: 600 }, screen: { width, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
        environments: ["windows:chromium", "windows:firefox", "macos:webkit"].map(pair => { const [platform, browser] = pair.split(":"); return { name: pair, platform, browser, devices: ["desktop"] }; }),
        rules: [{ name: "overflow", type: "page-horizontal-overflow" }, { name: "tabs", type: "tab-label-single-line", minimumInspected: minimum }],
        provider: { type: "static", targets: [{ name: "fixed", url }] },
      }));
      const output = await exec(["-e", "TMPDIR=/tmp", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"]);
      const result = JSON.parse(output.stdout);
      if (output.code !== code) throw new Error(output.stdout + output.stderr);
      expect(output.code).toBe(code);
      expect(result.status).toBe(status);
      const before = visits;
      const stored = await exec([container!, "cat", result.reportPath]);
      expect(stored.code).toBe(0);
      const report = JSON.parse(stored.stdout);
      expect(visits).toBe(before);
      expect(report.status).toBe(status);
      expect(result.cases).toBeUndefined();
      expect(result.execution).toBeUndefined();
      expect(report.summary).toEqual(result.summary);
      expect(report.cases).toHaveLength(3);
      expect(report.cases.every((item: any) => item.target.url === url && item.actualUrl === url)).toBe(true);
      expect(report.execution.engines.every((item: any) => item.obtainedVersion !== null)).toBe(true);
      expect(report.cases.every((item: any) => item.rules.some((rule: any) => rule.name === "overflow" && rule.status === (status === "violations" ? "violations" : "clean")))).toBe(true);
      expect(report.cases.every((item: any) => item.rules.some((rule: any) => rule.name === "tabs" && rule.status === (status === "incomplete" ? "failed" : "clean")))).toBe(true);
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);

for (const signal of ["INT", "TERM"]) (container ? test : test.skip)(`compiled ${signal} interruption report preserves completed and unexecuted cases`, async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/report-60-interrupt-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  let waiting: (() => void) | undefined;
  const reached = new Promise<void>(resolve => { waiting = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/waiting2") waiting?.();
    return new Response("<!doctype html><body>fixed</body>", { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: [{ name: "windows", platform: "windows", browser: "chromium", devices: ["desktop"] }],
      provider: { type: "static", targets: ["complete", "waiting", "waiting2", "unexecuted"].map(name => ({ name, url: `http://127.0.0.1:${server.port}/${name}`, ...(name.startsWith("waiting") ? { readyCondition: { selector: "#never" } } : {}) })) },
    }));
    const proc = Bun.spawn(["docker", "exec", "-w", cwd, container!, "sh", "-c", '/lane/dist/vlint-linux-x64 check --format json & pid=$!; echo "$pid" > /tmp/report-60-interrupt.pid; wait "$pid"; code=$?; echo "child-exit=$code" >&2; exit "$code"'], { stdout: "pipe", stderr: "pipe" });
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("waiting case not reached")), 15000))]);
    const killer = Bun.spawn(["docker", "exec", "-w", cwd, container!, "sh", "-c", `kill -${signal} "$(cat /tmp/report-60-interrupt.pid)"`]);
    expect(await killer.exited).toBe(0);
    const output = JSON.parse(await new Response(proc.stdout).text());
    expect(await new Response(proc.stderr).text()).toContain("child-exit=2");
    expect(await proc.exited).toBe(2);
    const reader = Bun.spawn(["docker", "exec", container!, "cat", output.reportPath], { stdout: "pipe" });
    const report = JSON.parse(await new Response(reader.stdout).text());
    expect(await reader.exited).toBe(0);
    expect(report.status).toBe("incomplete");
    expect(report.cases[0].status).toBe("complete");
    expect(report.cases[0].rules.some((item: any) => item.status === "clean")).toBe(true);
    expect(report.cases[3].status).toBe("not-executed");
    expect(JSON.stringify(report)).toContain("signal-interrupt");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
