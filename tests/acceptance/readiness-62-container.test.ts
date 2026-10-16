import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_READINESS_CONTAINER;

(container ? test : test.skip)("compiled rule boundaries reject newly errored FontFaces in all three engines", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/readiness-62-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('<html><body><button role="tab">label</button></body></html>', { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "font.ts"), `export default {
      contractVersion: 1,
      metadata: { name: "font-boundary", description: "load a failing font during measurement" },
      settingsSchema: { type: "object", properties: {}, required: [], exactKeys: [] },
      evaluate: async () => {
        const face = new FontFace("broken", "url(/missing.woff2)");
        document.fonts.add(face);
        await face.load().catch(() => {});
        await document.fonts.ready;
        return { elementsInspected: 1, violations: [] };
      }
    };`);
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: [["windows", "chromium"], ["windows", "firefox"], ["macos", "webkit"]].map(([platform, browser]) => ({ name: browser, platform, browser, devices: ["desktop"] })),
      rules: [{ name: "tabs", type: "tab-label-single-line" }, { name: "font", type: "local", path: "font.ts" }],
      provider: { type: "static", targets: [{ name: "page", url: `http://127.0.0.1:${server.port}/` }] },
    }));
    const proc = Bun.spawn(["docker", "exec", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    const output = JSON.parse(stdout);
    let result = output;
    if (output.reportPath) {
      const read = Bun.spawn(["docker", "exec", container!, "cat", output.reportPath], { stdout: "pipe" });
      result = JSON.parse(await new Response(read.stdout).text());
      expect(await read.exited).toBe(0);
    }
    expect(code).toBe(2);
    expect(result.cases).toHaveLength(3);
    for (const item of result.cases) {
      expect(item.rules[0].status).toBe("clean");
      expect(item.rules[0].elementsInspected).toBe(1);
      expect(item.rules[1].status).toBe("failed");
      expect(item.rules[1].failure.code).toBe("font-load-failed");
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 120_000);

(container ? test : test.skip)("compiled acquisition and measurement boundaries preserve URL, readiness, font and failure scope across engines", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/readiness-matrix-62-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const requested: string[] = [];
  const font = await readFile(resolve("tests/fixtures/app/fonts/test-regular.ttf"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requested.push(path);
    if (path === "/font.ttf") return new Response(font, { headers: { "content-type": "font/ttf" } });
    if (path === "/missing.ttf" || path === "/unused.ttf" || path === "/subset.ttf") return new Response("missing", { status: 404 });
    if (path === "/slow.ttf") { await Bun.sleep(4000); return new Response(font); }
    if (path.startsWith("/redirect")) return Response.redirect(new URL("/good", request.url).href);
    const css = path === "/css-good" ? "@font-face{font-family:fixture;src:url('/font.ttf')}body{font-family:fixture}" : path === "/css-error" ? "@font-face{font-family:fixture;src:url('/missing.ttf')}body{font-family:fixture}" : path === "/unused" ? "@font-face{font-family:fixture;src:url('/unused.ttf');font-weight:900}@font-face{font-family:fixture;src:url('/subset.ttf');unicode-range:U+4E00-9FFF}body{font-family:fixture}" : "";
    const js = path.startsWith("/js-") ? `const face=new FontFace('fixture','url(${path === "/js-good" ? "/font.ttf" : path === "/js-slow" ? "/slow.ttf" : "/missing.ttf"})');document.fonts.add(face);face.load().catch(()=>{});` : "";
    return new Response(`<html><head><style>${css}</style></head><body><main id="ready">abc</main><button role="tab">label</button><script>${js}</script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    await writeFile(join(directory, "boundary.ts"), `export default {
      contractVersion: 1, metadata: { name: "boundary" },
      settingsSchema: { type: "object", properties: {}, required: [], exactKeys: [] },
      evaluate: async () => {
        const path = location.pathname;
        if (path === '/rule-error') throw new Error('fixture rule failure');
        if (path === '/url-away' || path === '/url-roundtrip') {
          history.pushState({}, '', '/good');
          if (path === '/url-roundtrip') history.replaceState({}, '', path);
        }
        if (path === '/ready-away' || path === '/ready-roundtrip') {
          document.querySelector('#ready').remove();
          if (path === '/ready-roundtrip') document.body.insertAdjacentHTML('beforeend', '<main id="ready">restored</main>');
        }
        return { elementsInspected: 1, violations: [] };
      }
    };`);
    const paths = ["good", "css-good", "css-error", "unused", "js-good", "js-error", "js-slow", "redirect-denied", "redirect-allowed", "url-away", "url-roundtrip", "ready-away", "ready-roundtrip", "rule-error", "after"];
    const base = `http://127.0.0.1:${server.port}`;
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: [["windows", "chromium"], ["windows", "firefox"], ["macos", "webkit"]].map(([platform, browser]) => ({ name: browser, platform, browser, devices: ["desktop"] })),
      defaults: { timeoutMs: 10000, readyCondition: { selector: "#ready" } },
      rules: [{ name: "tabs", type: "tab-label-single-line" }, { name: "boundary", type: "local", path: "boundary.ts" }],
      provider: { type: "static", targets: paths.map((path) => ({ name: path, url: `${base}/${path}`, ...(path === "js-slow" ? { timeoutMs: 2000 } : {}), ...(path === "redirect-allowed" || path === "url-away" ? { allowedUrls: [`${base}/good`] } : {}) })) },
    }));
    const proc = Bun.spawn(["docker", "exec", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", "check", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(2);
    const output = JSON.parse(stdout);
    let result = output;
    if (output.reportPath) {
      const read = Bun.spawn(["docker", "exec", container!, "cat", output.reportPath], { stdout: "pipe" });
      result = JSON.parse(await new Response(read.stdout).text());
      expect(await read.exited).toBe(0);
    }
    expect(result.cases).toHaveLength(45);
    for (const engine of ["chromium", "firefox", "webkit"]) {
      const cases = result.cases.filter((item: any) => item.environment === engine);
      const get = (name: string) => cases.find((item: any) => item.target.name === name);
      for (const name of ["good", "css-good", "unused", "js-good", "redirect-allowed", "url-roundtrip", "ready-roundtrip", "after"]) {
        expect(get(name).status, `${engine} ${name}: ${JSON.stringify(get(name))}`).toBe("complete");
        expect(get(name).rules.every((rule: any) => rule.status === "clean")).toBe(true);
      }
      for (const name of ["css-error", "js-error"]) expect(get(name).failures[0].code).toBe("font-load-failed");
      expect(get("js-slow").failures[0].code).toBe("font-timeout");
      expect(get("redirect-denied").failures[0].code).toBe("url-mismatch");
      for (const [name, code] of [["url-away", "url-mismatch"], ["ready-away", "ready-lost"]] as const) {
        expect(get(name).rules[0].status).toBe("clean");
        expect(get(name).rules[1].failure.code).toBe(code);
        expect(get(name).rules[1].elementsInspected).toBe(0);
      }
      expect(get("rule-error").rules[0].status).toBe("clean");
      expect(get("rule-error").rules[1].status).toBe("failed");
      expect(get("rule-error").rules[2].status).toBe("clean");
    }
    expect(requested).not.toContain("/unused.ttf");
    expect(requested).not.toContain("/subset.ttf");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 180_000);

(container ? test : test.skip)("compiled interruption preserves completed rules and stops subsequent cases in each engine", async () => {
  for (const [platform, browser] of [["windows", "chromium"], ["windows", "firefox"], ["macos", "webkit"]] as const) {
    const directory = await mkdtemp(resolve("tests/fixtures/readiness-interrupt-62-"));
    const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
    const entered = new Set<string>();
    const visited = new Set<string>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/entered/")) entered.add(path);
      else visited.add(path);
      return new Response('<html><body><button role="tab">label</button></body></html>', { headers: { "content-type": "text/html" } });
    } });
    try {
      await writeFile(join(directory, "block.ts"), `export default {
        contractVersion: 1, metadata: { name: "block" },
        settingsSchema: { type: "object", properties: {}, required: [], exactKeys: [] },
        evaluate: async () => {
          if (location.pathname !== '/first') {
            await fetch('/entered' + location.pathname);
            await new Promise(() => {});
          }
          return { elementsInspected: 1, violations: [] };
        }
      };`);
      await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
        devices: [{ name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
        environments: [{ name: browser, platform, browser, devices: ["desktop"] }],
        rules: [{ name: "tabs", type: "tab-label-single-line" }, { name: "block", type: "local", path: "block.ts" }],
        provider: { type: "static", targets: ["first", "blocked-a", "blocked-b", "never"].map((name) => ({ name, url: `http://127.0.0.1:${server.port}/${name}` })) },
      }));
      const pidFile = `/tmp/readiness-62-${browser}.pid`;
      const proc = Bun.spawn(["docker", "exec", "-w", cwd, container!, "sh", "-c", `echo $$ > ${pidFile}; exec /lane/dist/vlint-linux-x64 check --format json`], { stdout: "pipe", stderr: "pipe" });
      const deadline = Date.now() + 25000;
      while (entered.size < 2 && Date.now() < deadline) await Bun.sleep(25);
      expect(entered.size, browser).toBe(2);
      const signal = Bun.spawn(["docker", "exec", container!, "sh", "-c", `kill -TERM $(cat ${pidFile})`]);
      expect(await signal.exited).toBe(0);
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(2);
      const output = JSON.parse(stdout);
      let result = output;
      if (output.reportPath) {
        const read = Bun.spawn(["docker", "exec", container!, "cat", output.reportPath], { stdout: "pipe" });
        result = JSON.parse(await new Response(read.stdout).text());
        expect(await read.exited).toBe(0);
      }
      expect(result.cases[0].status).toBe("complete");
      expect(result.cases[0].rules.every((rule: any) => rule.status === "clean")).toBe(true);
      expect(result.cases[3].status).toBe("not-executed");
      expect(result.cases[3].rules.every((rule: any) => rule.status === "not-executed")).toBe(true);
      expect(result.failures.some((failure: any) => failure.code === "signal-interrupt")).toBe(true);
      expect(visited.has("/never")).toBe(false);
    } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
  }
}, 180_000);
