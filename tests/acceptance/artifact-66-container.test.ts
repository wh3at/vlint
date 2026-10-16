import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vlintPackage from "../../package.json";

const container = process.env.VLINT_ARTIFACT_CONTAINER;

(container ? test : test.skip)("release archive runs selected init, six environments, five built-ins and local rule with a copyable same-run report", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/artifact-66-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  let visits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    visits++;
    return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body><button role="tab">Tab</button><table><thead><tr><th scope="col">Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table><svg width="200" height="60" style="overflow:hidden;font:20px Arial"><text x="10" y="30">Hello</text></svg></body>', { headers: { "content-type": "text/html" } });
  } });
  async function exec(args: string[]) {
    const proc = Bun.spawn(["docker", "exec", "--user", `${process.getuid!()}:${process.getgid!()}`, "-e", "HOME=/tmp", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", cwd, container!, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  try {
    const archive = `/lane/dist/release/vlint-v${vlintPackage.version}-linux-x64.tar.gz`;
    expect((await exec(["tar", "-xzf", archive, "-C", cwd])).code).toBe(0);
    const binary = `${cwd}/vlint`;
    expect(await exec([binary, "--version"])).toEqual({ stdout: `vlint ${vlintPackage.version}\n`, stderr: "", code: 0 });
    const selected = ["windows:chromium", "windows:firefox", "macos:chromium", "macos:webkit", "iphone:webkit", "android:chromium"];
    const initialized = await exec([binary, "init", ...selected.flatMap(pair => ["--environment", pair])]);
    expect(initialized.code, initialized.stderr).toBe(0);
    const configPath = join(directory, "vlint.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.environments.map((item: any) => item.name)).toEqual(selected.map(pair => pair.replace(":", "-")));
    for (const rule of config.rules) if (rule.type !== "page-horizontal-overflow") rule.minimumInspected = 1;
    await copyFile(resolve("tests/fixtures/plugins/finalize-noop-rule.ts"), join(directory, "local.ts"));
    config.rules.push({ name: "local", type: "local", path: "local.ts", settings: {}, minimumInspected: 1 });
    config.provider = { type: "static", targets: [{ name: "artifact", url: `http://127.0.0.1:${server.port}/` }] };
    await writeFile(configPath, JSON.stringify(config));
    const checked = await exec([binary, "check", "--format", "json"]);
    expect(checked.code, checked.stdout + checked.stderr).toBe(0);
    expect(checked.stderr).toBe("");
    const summary = JSON.parse(checked.stdout);
    expect(summary.status).toBe("clean");
    expect(summary.cases).toBeUndefined();
    expect(summary.execution).toBeUndefined();
    expect(summary.environmentRules).toHaveLength(36);
    expect(summary.summary.cases).toMatchObject({ resolved: 6, complete: 6, failed: 0, notExecuted: 0 });
    const before = visits;
    const stored = await exec(["cat", summary.reportPath]);
    expect(stored.code).toBe(0);
    const report = JSON.parse(stored.stdout);
    expect(report.summary).toEqual(summary.summary);
    expect(report.cases).toHaveLength(6);
    for (const item of report.cases) {
      expect(item.environment).toBe(config.environments[report.cases.indexOf(item)].name);
      expect(item.rules.map((rule: any) => rule.type)).toEqual(["tab-label-single-line", "page-horizontal-overflow", "table-header-single-line", "table-cell-text-overlap", "svg-text-clipping", "local"]);
      expect(item.rules.every((rule: any) => rule.status === "clean")).toBe(true);
      expect(item.rules.map((rule: any) => rule.elementsInspected)).toEqual([1, 0, 1, 2, 1, 1]);
    }
    expect(report.execution.engines.map((item: any) => [item.engine, item.obtainedVersion])).toEqual([["chromium", "149.0.7827.55"], ["firefox", "151.0"], ["webkit", "26.5"]]);
    expect((await exec(["stat", "-c", "%a", summary.reportPath])).stdout.trim()).toBe("600");
    expect((await exec(["cp", summary.reportPath, `${cwd}/ci-report.json`])).code).toBe(0);
    expect(await readFile(join(directory, "ci-report.json"), "utf8")).toBe(stored.stdout);
    expect(visits).toBe(before);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
