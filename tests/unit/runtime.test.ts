import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

const root = join(import.meta.dir, "../..");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-runtime-"));
  directories.push(directory);
  await mkdir(join(directory, "scripts"));
  await cp(join(root, "scripts/check-runtime.ts"), join(directory, "scripts/check-runtime.ts"));
  await Bun.write(join(directory, "package.json"), JSON.stringify({ ...pkg, engines: { bun: version } }));
  return directory;
}

async function run(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("runtime check accepts exactly the project Bun version and identifies a mismatch", async () => {
  const matching = await project(Bun.version);
  expect(await run(matching, ["run", "scripts/check-runtime.ts"])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  const mismatching = await project("0.0.0");
  const result = await run(mismatching, ["run", "scripts/check-runtime.ts"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Bun version mismatch: expected 0.0.0, running ${Bun.version}`);
  expect(result.stderr).toContain("mise install");
});

test("all package validation and build scripts stop on a runtime mismatch before executing work", async () => {
  const directory = await project("0.0.0");
  await Bun.write(join(directory, "scripts/build.ts"), 'await Bun.write("build-started", "yes");');
  const scripts = Object.keys(pkg.scripts);
  for (const name of scripts) {
    const result = await run(directory, ["run", name]);
    expect(result.exitCode, name).not.toBe(0);
    expect(result.stderr, name).toContain("Bun version mismatch: expected 0.0.0");
  }
  expect(await Bun.file(join(directory, "build-started")).exists()).toBe(false);
});

test("direct single-file tests check the runtime before loading test code", async () => {
  const directory = await project("0.0.0");
  await cp(join(root, "bunfig.toml"), join(directory, "bunfig.toml"));
  await Bun.write(join(directory, "probe.test.ts"), 'import { test } from "bun:test"; test("probe", async () => { await Bun.write("test-started", "yes"); });');
  const rejected = await run(directory, ["test", "./probe.test.ts"]);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("Bun version mismatch: expected 0.0.0");
  expect(await Bun.file(join(directory, "test-started")).exists()).toBe(false);
  await Bun.write(join(directory, "package.json"), JSON.stringify({ ...pkg, engines: { bun: Bun.version } }));
  expect((await run(directory, ["test", "./probe.test.ts"])).exitCode).toBe(0);
  expect(await Bun.file(join(directory, "test-started")).exists()).toBe(true);
});

test("mise and every CI Bun setup agree with package.json", async () => {
  const mise = Bun.TOML.parse(await Bun.file(join(root, "mise.toml")).text()) as { tools: { bun: string } };
  expect(mise.tools.bun).toBe(pkg.engines.bun);
  let setups = 0;
  for await (const path of new Bun.Glob(".github/workflows/*.{yml,yaml}").scan({ cwd: root, dot: true })) {
    const workflow = Bun.YAML.parse(await Bun.file(join(root, path)).text()) as {
      env?: Record<string, string>;
      jobs: Record<string, { steps: { uses?: string; with?: Record<string, string> }[] }>;
    };
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue;
        setups++;
        const pin = step.with?.["bun-version"];
        const version = pin === "${{ env.BUN_VERSION }}" ? workflow.env?.BUN_VERSION : pin;
        expect(version, path).toBe(pkg.engines.bun);
      }
    }
  }
  expect(setups).toBeGreaterThan(0);
});
