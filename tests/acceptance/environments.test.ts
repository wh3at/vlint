import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve("dist/vlint-linux-x64");
const device = { name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 1000, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

test("compiled check rejects omitted environments instead of selecting implicit Chromium", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vlint-57-"));
  try {
    await writeFile(join(cwd, "vlint.config.json"), JSON.stringify({ devices: [device] }));
    const proc = Bun.spawn([binary, "check", "--url", "http://127.0.0.1:1/", "--format", "json"], { cwd, stdout: "pipe", stderr: "pipe" });
    const output = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(2);
    expect(output.failures[0].code).toBe("config-schema-invalid");
    expect(output.failures[0].message).toContain("environments");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

const environment = { name: "windows", platform: "windows", browser: "chromium", devices: ["desktop"] };
for (const [name, change, message] of [
  ["empty environments", { environments: [] }, "environments"],
  ["empty references", { environments: [{ ...environment, devices: [] }] }, "devices"],
  ["unknown reference", { environments: [{ ...environment, devices: ["missing"] }] }, "unknown device"],
  ["duplicate names", { environments: [environment, environment] }, "duplicate environment"],
  ["unsupported pair", { environments: [{ ...environment, browser: "webkit" }] }, "unsupported"],
  ["device UA", { devices: [{ ...device, userAgent: "forbidden" }] }, "userAgent"],
  ["environment override", { environments: [{ ...environment, ruleOverrides: {} }] }, "unknown field"],
  ["target environment override", { provider: { type: "static", targets: [{ name: "page", url: "http://127.0.0.1/", environments: [] }] } }, "unknown field"],
] as const) {
  test(`compiled check rejects ${name}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vlint-57-invalid-"));
    try {
      await writeFile(join(cwd, "vlint.config.json"), JSON.stringify(Object.assign({ devices: [device], environments: [environment] }, change)));
      const proc = Bun.spawn([binary, "check", "--url", "http://127.0.0.1:1/", "--format", "json"], { cwd, stdout: "pipe", stderr: "pipe" });
      const output = JSON.parse(await new Response(proc.stdout).text());
      expect(await proc.exited).toBe(2);
      expect(output.failures[0].code).toBe("config-schema-invalid");
      expect(output.failures[0].message).toContain(message);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("compiled check launches only the selected engine and leaves an empty cache untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vlint-57-empty-"));
  const cache = await mkdtemp(join(tmpdir(), "vlint-57-cache-"));
  try {
    await writeFile(join(cwd, "vlint.config.json"), JSON.stringify({ devices: [device], environments: [environment] }));
    const proc = Bun.spawn([binary, "check", "--url", "http://127.0.0.1:1/", "--format", "json"], { cwd, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, PLAYWRIGHT_DOWNLOAD_HOST: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
    const output = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(2);
    expect(output.execution.engines.map((item: any) => item.engine)).toEqual(["chromium"]);
    expect(output.cases).toHaveLength(1);
    expect(output.cases[0].environment).toBe("windows");
    expect(output.cases[0].failures[0].code).toBe("browser-launch-failed");
    expect(output.execution.engines[0].obtainedVersion).toBeNull();
    expect(output.execution.engines[0].diagnostic).toContain("Executable doesn't exist");
    expect(await readdir(cache)).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); }
});
