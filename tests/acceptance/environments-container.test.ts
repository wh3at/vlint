import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_ENVIRONMENT_CONTAINER;
const selected = ["windows:chromium", "windows:firefox", "macos:chromium", "macos:webkit", "iphone:webkit", "android:chromium"];
const desktop = { name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 1000, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const compact = { ...desktop, name: "compact", viewport: { width: 400, height: 500 }, screen: { width: 700, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function command(cwd: string) {
  const proc = Bun.spawn(["docker", "exec", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!stdout.trim()) throw new Error(`${code}: ${stderr}`);
  return { code, result: JSON.parse(stdout) };
}

(container ? test : test.skip)("compiled six environments preserve order, apply UA and explicit screens, and isolate engine loss", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/environment-57-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const observations: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/observed") { observations.push(JSON.parse(url.searchParams.get("value")!)); return new Response("ok"); }
    return new Response(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>fixture<script>fetch('/observed?value='+encodeURIComponent(JSON.stringify({ua:navigator.userAgent,width:innerWidth,height:innerHeight,screen:screen.width,screenHeight:screen.height,dpr:devicePixelRatio,touch:navigator.maxTouchPoints>0}))).then(()=>document.body.dataset.ready='yes')</script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  const environments = selected.map((pair) => { const [platform, browser] = pair.split(":"); return { name: pair, platform, browser, devices: ["compact", "desktop"] }; });
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({ devices: [desktop, compact, { ...desktop, name: "unused" }], environments, defaults: { readyCondition: { selector: 'body[data-ready="yes"]' } }, provider: { type: "static", targets: [{ name: "first", url: `http://127.0.0.1:${server.port}/first` }, { name: "second", url: `http://127.0.0.1:${server.port}/second` }] } }));
    const { code, result } = await command(cwd);
    if (code !== 0) throw new Error(JSON.stringify(result));
    expect(code).toBe(0);
    expect(result.cases.map((item: any) => [item.target.name, item.environment, item.device.name])).toEqual(["first", "second"].flatMap((target) => selected.flatMap((environment) => ["compact", "desktop"].map((device) => [target, environment, device]))));
    expect(result.execution.environments.map((item: any) => item.name)).toEqual(selected);
    expect(result.execution.devices).toHaveLength(2);
    expect(result.execution.engines.map((item: any) => item.engine).sort()).toEqual(["chromium", "firefox", "webkit"]);
    console.log(JSON.stringify({ execution: result.execution, observations }));
    expect(observations).toHaveLength(24);
    expect(observations.filter((item) => item.width === 400 && item.height === 500 && item.dpr === 2)).toHaveLength(12);
    expect(observations.filter((item) => item.width === 400 && item.screen === 700 && item.screenHeight === 800)).toHaveLength(10);
    expect(observations.filter((item) => item.width === 400 && String(item.ua).includes("Firefox") && item.screen === 400 && item.screenHeight === 500 && item.touch === false)).toHaveLength(2);
    expect(observations.filter((item) => item.width === 400 && String(item.ua).includes("Chrome/") && item.touch === true)).toHaveLength(6);
    expect(observations.filter((item) => item.width === 400 && !String(item.ua).includes("Chrome/") && item.touch === false)).toHaveLength(6);
    expect(result.execution.devices.find((item: any) => item.name === "compact").screen).toEqual({ width: 700, height: 800 });
    expect(observations.filter((item) => item.width === 800 && item.height === 600 && item.screen === 1000 && item.screenHeight === 900 && item.dpr === 1 && item.touch === false)).toHaveLength(12);
    for (const item of result.execution.environments) {
      expect(observations.filter((observed) => observed.ua === item.userAgent)).toHaveLength(4);
      expect(item.userAgent).toMatch(item.platform === "windows" ? /Windows/ : item.platform === "android" ? /Android/ : item.platform === "iphone" ? /iPhone/ : /Macintosh/);
    }
    const sabotage = Bun.spawn(["docker", "exec", container!, "sh", "-c", "find /tmp/browsers-57/firefox-* -type f -name firefox -exec chmod a-x {} +"], { stdout: "pipe", stderr: "pipe" });
    expect(await sabotage.exited).toBe(0);
    try {
      const failed = await command(cwd);
      expect(failed.code).toBe(2);
      expect(failed.result.cases).toHaveLength(24);
      expect(failed.result.cases.filter((item: any) => item.environment === "windows:firefox")).toHaveLength(4);
      expect(failed.result.cases.filter((item: any) => item.environment === "windows:firefox").every((item: any) => item.status === "failed")).toBe(true);
      expect(failed.result.cases.filter((item: any) => item.environment !== "windows:firefox").every((item: any) => item.status === "complete")).toBe(true);
      expect(failed.result.execution.engines.find((item: any) => item.engine === "firefox").diagnostic).toBeTruthy();
    } finally {
      const restore = Bun.spawn(["docker", "exec", container!, "sh", "-c", "find /tmp/browsers-57/firefox-* -type f -name firefox -exec chmod a+x {} +"]);
      expect(await restore.exited).toBe(0);
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);

(container ? test : test.skip)("compiled minimums remain independent across environments and preserve conflict resolution", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/minimum-environment-57-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const tab = request.headers.get("user-agent")?.includes("Firefox") ? "" : '<button role="tab">label</button>';
    return new Response(`<html><body>${tab}</body></html>`, { headers: { "content-type": "text/html" } });
  } });
  const environments = selected.map((pair) => { const [platform, browser] = pair.split(":"); return { name: pair, platform, browser, devices: ["desktop"] }; });
  const target = { name: "page", url: `http://127.0.0.1:${server.port}/` };
  async function save(minimum: number | null, deviceMinimum?: number, combined?: number) {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ ...desktop, ...(deviceMinimum === undefined ? {} : { ruleMinimums: { tabs: deviceMinimum } }) }], environments,
      rules: [{ name: "tabs", type: "tab-label-single-line", ...(minimum === null ? {} : { minimumInspected: minimum }) }],
      provider: { type: "static", targets: [{ ...target, ...(deviceMinimum === undefined ? {} : { ruleOverrides: { tabs: { minimumInspected: 1 } } }), ...(combined === undefined ? {} : { deviceRuleMinimums: { desktop: { tabs: combined } } }) }] },
    }));
  }
  try {
    await save(null);
    const zero = await command(cwd);
    expect(zero.code).toBe(0);
    expect(zero.result.cases.map((item: any) => item.rules[0].elementsInspected)).toEqual([1, 0, 1, 1, 1, 1]);
    await save(1);
    const minimum = await command(cwd);
    expect(minimum.code).toBe(2);
    expect(minimum.result.cases.map((item: any) => item.rules[0].status)).toEqual(["clean", "failed", "clean", "clean", "clean", "clean"]);
    expect(minimum.result.cases[1].rules[0].failure.code).toBe("minimum-inspected-unmet");
    await save(1, 2);
    const conflict = await command(cwd);
    expect(conflict.code).toBe(2);
    expect(conflict.result.failures[0].message).toContain("conflict");
    expect(conflict.result.execution.engines).toEqual([]);
    await save(1, 2, 1);
    const combined = await command(cwd);
    expect(combined.code).toBe(2);
    expect(combined.result.cases.map((item: any) => item.rules[0].status)).toEqual(["clean", "failed", "clean", "clean", "clean", "clean"]);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);
