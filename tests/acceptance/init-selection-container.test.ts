import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const container = process.env.VLINT_INIT_CONTAINER;
(container ? test : test.skip)("compiled init generates all six valid editable environments consumed by three real engines", async () => {
  const directory = await mkdtemp(resolve("tests/fixtures/init-58-"));
  const cwd = `/lane/tests/fixtures/${directory.split("/").at(-1)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("<!doctype html><html><body>init fixture</body></html>", { headers: { "content-type": "text/html" } }); } });
  async function command(args: string[]) {
    const proc = Bun.spawn(["docker", "exec", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", "-w", cwd, container!, "/lane/dist/vlint-linux-x64", ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { output, error, code };
  }
  try {
    const selected = ["windows:chromium", "windows:firefox", "macos:chromium", "macos:webkit", "iphone:webkit", "android:chromium"];
    const init = await command(["init", ...selected.flatMap((choice) => ["--environment", choice])]);
    expect(init).toEqual({ code: 0, error: "", output: "vlint init: created vlint.config.json\n" });
    const config = await Bun.file(join(directory, "vlint.config.json")).json();
    expect(config.devices).toHaveLength(6);
    expect(config.devices[0]).toMatchObject({ viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    expect(config.devices[5]).toMatchObject({ viewport: { width: 360, height: 732 }, screen: { width: 360, height: 808 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const check = await command(["check", "--url", `http://127.0.0.1:${server.port}/`, "--format", "json"]);
      if (check.code !== 0) throw new Error(JSON.stringify(check));
      const result = JSON.parse(check.output);
      expect(result.status).toBe("clean");
      expect(result.cases.map((item: any) => item.environment)).toEqual(selected.map((choice) => choice.replace(":", "-")));
      expect(result.execution.engines.map((item: any) => item.engine).sort()).toEqual(["chromium", "firefox", "webkit"]);
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
