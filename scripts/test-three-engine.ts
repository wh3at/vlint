import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { packageRelease } from "./package-release";
import packageJson from "../package.json";

export const containerSuites = [
  { file: "tests/acceptance/environments-container.test.ts", environment: "VLINT_ENVIRONMENT_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/init-selection-container.test.ts", environment: "VLINT_INIT_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/report-60-container.test.ts", environment: "VLINT_REPORT_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/presentation-61-container.test.ts", environment: "VLINT_PRESENTATION_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/readiness-62-container.test.ts", environment: "VLINT_READINESS_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/single-line-overflow-63.test.ts", environment: "VLINT_RULES_63_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/table-cell-64-container.test.ts", environment: "VLINT_TABLE_CELL_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/svg-local-65-container.test.ts", environment: "VLINT_SVG_LOCAL_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/artifact-66-container.test.ts", environment: "VLINT_ARTIFACT_CONTAINER", group: "three-engine" },
  { file: "tests/acceptance/browser-privilege-55-container.test.ts", environment: "VLINT_PRIVILEGE_CONTAINER", group: "privilege" },
  { file: "tests/acceptance/installer-container-59.test.ts", environment: "VLINT_INSTALLER_CONTAINER_ACCEPTANCE", group: "installer" },
  { file: "tests/acceptance/browser-management-container.test.ts", environment: "VLINT_BROWSER_CONTAINER_ACCEPTANCE", group: "installer" },
] as const;

export function checkSuiteInventory(discovered: readonly string[]): void {
  for (const file of discovered) {
    if (!containerSuites.some(suite => suite.file === file)) throw new Error(`unregistered container suite: ${file}`);
  }
  for (const suite of containerSuites) {
    if (!discovered.includes(suite.file)) throw new Error(`missing container suite: ${suite.file}`);
  }
}

async function checkAcceptanceInventory(root: string): Promise<void> {
  const discovered: string[] = [];
  for await (const file of new Bun.Glob("tests/acceptance/**/*.test.ts").scan({ cwd: root })) {
    const source = await readFile(join(root, file), "utf8");
    if (/container(?:-\d+)?\.test\.ts$/.test(file) || /process\.env\.VLINT_\w*CONTAINER/.test(source)) discovered.push(file);
  }
  checkSuiteInventory(discovered);
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

export function verifySuiteReport(report: string, files: readonly string[]): void {
  const root = /<testsuites\b[^>]*>/.exec(report)?.[0];
  if (root === undefined) throw new Error("missing JUnit test results");
  for (const field of ["failures", "errors", "skipped"]) {
    if (Number(attribute(root, field) ?? "0") !== 0) throw new Error(`acceptance report contains ${field}`);
  }
  const cases = [...report.matchAll(/<testcase\b[^>]*>/g)].map(match => match[0]);
  if (cases.length === 0 || Number(attribute(root, "tests")) !== cases.length) throw new Error("empty or incomplete JUnit test results");
  if (/<(?:skipped|failure|error)\b/.test(report)) throw new Error("acceptance report contains skipped or failed tests");
  for (const file of files) {
    if (!cases.some(tag => attribute(tag, "file") === file)) throw new Error(`suite did not execute: ${file}`);
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const group = args.length === 0 ? "three-engine" : args.length === 2 && args[0] === "--group" ? args[1] : undefined;
  await checkAcceptanceInventory(root);
  if (args.length === 1 && args[0] === "--check") {
    console.log(`acceptance inventory: ${containerSuites.length} suites registered`);
    return;
  }
  if (group !== "three-engine" && group !== "privilege") throw new Error("usage: test-three-engine.ts [--check | --group three-engine|privilege]");
  const binary = join(root, "dist/vlint-linux-x64");
  await access(binary, constants.X_OK);
  const selected = containerSuites.filter(suite => suite.group === group);
  const output = join(root, "dist/acceptance", group, `${Date.now()}-${process.pid}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  console.log(`acceptance ${group}: logs and reports in ${output}`);
  await writeFile(join(output, "inputs.json"), JSON.stringify({ group, suites: selected.map(suite => suite.file), binarySha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex") }) + "\n");
  let sequence = 0;
  let cancelled = false;
  let active: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => { cancelled = true; active?.kill(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  async function command(args: string[], label: string, env = process.env, cleanup = false): Promise<string> {
    if (cancelled && !cleanup) throw new Error("acceptance interrupted");
    const prefix = join(output, `${sequence++}-${label}`);
    await writeFile(`${prefix}.command.json`, JSON.stringify(args) + "\n");
    active = Bun.spawn(args, { cwd: root, env, stdin: "ignore", stdout: Bun.file(`${prefix}.stdout.log`), stderr: Bun.file(`${prefix}.stderr.log`), timeout: 900_000 });
    const code = await active.exited;
    active = undefined;
    const stdout = await readFile(`${prefix}.stdout.log`, "utf8");
    if (code !== 0) throw new Error(`${label} exited ${code}: ${prefix}\n${(stdout + await readFile(`${prefix}.stderr.log`, "utf8")).slice(-2000)}`);
    return stdout;
  }
  let container: string | undefined;
  let failure: unknown;
  try {
    container = `vlint-${group}-${randomUUID()}`;
    await command(["docker", "create", "--name", container, "--init", "--network", "host",
      "-e", "PLAYWRIGHT_SKIP_BROWSER_GC=1", "-e", "PLAYWRIGHT_BROWSERS_PATH=/tmp/vlint-browsers",
      "-v", `${root}:/lane:ro`, "-v", `${join(root, "tests/fixtures")}:/lane/tests/fixtures`,
      "ubuntu@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf", "sleep", "infinity"], "create");
    await command(["docker", "start", container], "start");
    await command(["docker", "cp", process.execPath, `${container}:/usr/local/bin/bun`], "bun");
    await command(["docker", "exec", container, "sh", "-ec", "apt-get update && apt-get install -y ca-certificates && /lane/dist/vlint-linux-x64 browser install"], "prepare");
    const status = JSON.parse(await command(["docker", "exec", "-e", "PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1", container, "/lane/dist/vlint-linux-x64", "browser", "status", "--format", "json"], "readiness"));
    if (status.ready !== true || JSON.stringify(status.engines.map((engine: { engine: string }) => engine.engine)) !== JSON.stringify(["chromium", "firefox", "webkit"])) throw new Error("three managed engines are not ready");
    if (group === "privilege") {
      await command(["docker", "exec", container, "sh", "-ec", "apt-get install -y python3 sudo && useradd --create-home --groups sudo vlintreview"], "privilege");
    } else {
      await packageRelease({ root, outputDirectory: join(root, "dist/release"), version: packageJson.version, repository: "wh3at/vlint", binaryPath: binary });
    }
    for (const suite of selected) {
      console.log(`acceptance: ${suite.file}`);
      const report = join(output, `${basename(suite.file)}.xml`);
      await command([process.execPath, "test", suite.file, "--reporter=junit", `--reporter-outfile=${report}`], basename(suite.file), { ...process.env, [suite.environment]: container });
      verifySuiteReport(await readFile(report, "utf8"), [suite.file]);
    }
    if (cancelled) throw new Error("acceptance interrupted");
  } catch (error) {
    failure = error;
  } finally {
    if (container !== undefined) {
      try {
        await command(["docker", "exec", container, "sh", "-ec", "find /tmp -mindepth 2 -maxdepth 2 -path '/tmp/vlint-*/report.json' -printf '%P\\0' | tar --null -C /tmp -czf /tmp/acceptance-reports.tar.gz -T -"], "collect", process.env, true);
        await command(["docker", "cp", `${container}:/tmp/acceptance-reports.tar.gz`, join(output, "complete-reports.tar.gz")], "reports", process.env, true);
      } catch (error) {
        console.error(error);
        failure ??= error;
      }
      try {
        await command(["docker", "rm", "-f", container], "cleanup", process.env, true);
      } catch (error) {
        console.error(error);
        failure ??= error;
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (failure !== undefined) throw failure;
  console.log(`acceptance ${group}: ${selected.length} suites passed without skips`);
}

if (import.meta.main) await main();
