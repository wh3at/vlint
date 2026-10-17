import { expect, test } from "bun:test";
import { resolve } from "node:path";

const enabled = process.env.VLINT_BROWSER_CONTAINER_ACCEPTANCE === "1";

(enabled ? test : test.skip)("compiled browser preparation, repeat preparation, forced repair, and offline status launch all engines", async () => {
  const name = `vlint-56-${process.pid}-${Date.now()}`;
  async function docker(...args: string[]) {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`docker ${args.join(" ")}: ${code}\n${stdout}\n${stderr}`);
    return stdout;
  }
  try {
    await docker("run", "--name", name, "-d", "-e", "PLAYWRIGHT_SKIP_BROWSER_GC=1", "-e", "PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-56", "-v", `${resolve("dist")}:/artifacts:ro`, "ubuntu@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf", "sleep", "infinity");
    await docker("exec", name, "sh", "-c", "apt-get update >/tmp/bootstrap.log 2>&1 && apt-get install -y ca-certificates >>/tmp/bootstrap.log 2>&1");
    for (const args of [[], [], ["--force"]]) {
      const output = await docker("exec", name, "/artifacts/vlint-linux-x64", "browser", "install", ...args);
      expect(output).toContain("chromium, firefox, webkit ready");
    }
    await docker("network", "disconnect", "bridge", name);
    const ready = JSON.parse(await docker("exec", name, "/artifacts/vlint-linux-x64", "browser", "status", "--format", "json"));
    expect(ready.ready).toBe(true);
    expect(ready.engines.map((engine: { engine: string }) => engine.engine)).toEqual(["chromium", "firefox", "webkit"]);
    for (const engine of ready.engines) {
      expect(engine.status).toBe("ready");
      expect(engine.dependencyValidation).toBe("passed");
      expect(engine.launch).toBe("passed");
      expect(engine.emptyPage).toBe("passed");
      expect(engine.close).toBe("passed");
      expect(engine.obtainedVersion).toBe(engine.expectedVersion);
      expect(engine.revision).toMatch(/^\d+$/);
      expect(engine.artifact.downloadURLs.length).toBeGreaterThan(0);
    }
    expect(ready.engines[1].obtainedVersion).toMatch(/^\d+\.\d+$/);
    expect(ready.engines[2].versionSource).toBe("playwright-metadata");
    await docker("exec", name, "sh", "-c", "find /tmp/browsers-56/firefox-* -type f -name firefox -exec chmod a-x {} +");
    const failed = JSON.parse(await docker("exec", name, "sh", "-c", "/artifacts/vlint-linux-x64 browser status --format json >/tmp/failed.json; code=$?; cat /tmp/failed.json; test $code = 2"));
    expect(failed.ready).toBe(false);
    expect(failed.engines.map((engine: { status: string }) => engine.status)).toEqual(["ready", "unavailable", "ready"]);
    expect(failed.engines[1].executablePresent).toBe(true);
    expect(failed.engines[1].launch).toBe("failed");
    expect(failed.engines[1].obtainedVersion).toBeNull();
    expect(failed.engines[1].diagnostic).toBeTruthy();
    console.log(JSON.stringify({ container: name, engines: ready.engines, failedFirefox: failed.engines[1] }));
  } finally {
    await docker("rm", "-f", name);
  }
}, 1_800_000);
