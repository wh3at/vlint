import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSuiteInventory, containerSuites, verifySuiteReport } from "../../scripts/test-three-engine";

async function withReport(source: string, check: (report: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), "vlint-acceptance-runner-"));
  try {
    await writeFile(join(directory, "fixture.test.ts"), `import { expect, test } from "bun:test";\n${source}`);
    const proc = Bun.spawn([process.execPath, "test", "./fixture.test.ts", "--reporter=junit", "--reporter-outfile=result.xml"], {
      cwd: directory, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stdout + stderr).toBe(0);
    check(await readFile(join(directory, "result.xml"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("acceptance gate accepts an executed passing suite", async () => {
  await withReport('test("runs", () => expect(1).toBe(1));', report => {
    expect(() => verifySuiteReport(report, ["fixture.test.ts"])).not.toThrow();
  });
});

test("acceptance gate rejects a successful test process containing a skipped test", async () => {
  await withReport('test("runs", () => expect(1).toBe(1)); test.skip("missing", () => {});', report => {
    expect(() => verifySuiteReport(report, ["fixture.test.ts"])).toThrow(/skipped/);
  });
});

test("acceptance gate rejects a scheduled file absent from the test report", async () => {
  await withReport('test("runs", () => expect(1).toBe(1));', report => {
    expect(() => verifySuiteReport(report, ["fixture.test.ts", "missing.test.ts"])).toThrow(/missing.test.ts/);
  });
});

test("acceptance gate rejects missing or empty test results", () => {
  expect(() => verifySuiteReport("", ["fixture.test.ts"])).toThrow();
  expect(() => verifySuiteReport('<testsuites tests="0" failures="0" skipped="0"></testsuites>', ["fixture.test.ts"])).toThrow();
});

test("acceptance inventory rejects an unregistered container suite", () => {
  const files = containerSuites.map(suite => suite.file);
  expect(() => checkSuiteInventory([...files, "tests/acceptance/new-container.test.ts"])).toThrow(/unregistered.*new-container/);
});

test("acceptance inventory rejects a registered suite that was deleted or renamed", () => {
  const files = containerSuites.map(suite => suite.file).filter(file => !file.endsWith("single-line-overflow-63.test.ts"));
  expect(() => checkSuiteInventory(files)).toThrow(/missing.*single-line-overflow/);
});

test("acceptance entrypoint audits the repository inventory without preparing browsers", async () => {
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/test-three-engine.ts"), "--check"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("suites registered");
});
