import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderInstaller } from "../../scripts/package-release";

const root = resolve(import.meta.dir, "../..");
const management = join(root, "src/browser/management.ts");
const install = join(root, "src/browser/install.ts");

for (const initCwd of [undefined, "", "/explicit-origin", "relative-origin"]) {
  test(`browser worker preserves relative cache resolution with INIT_CWD=${String(initCwd)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "vlint-cache-test-"));
    try {
      const script = join(directory, "probe.ts");
      await writeFile(script, `
import { mock } from "bun:test";
const { managedExecutable } = await import(${JSON.stringify(management)});
const expected = managedExecutable("chromium").executablePath();
mock.module(${JSON.stringify(management)}, () => ({
  managedExecutable,
  inspectManagedBrowsers: async () => ({ ready: true }),
  prepareManagedBrowsers: async () => {},
}));
const spawn = Bun.spawn;
Bun.spawn = (options) => {
  const child = spawn({ ...options, cmd: [process.execPath, "-e", ${JSON.stringify(`import { managedExecutable } from ${JSON.stringify(management)}; console.log(managedExecutable("chromium").executablePath());`)}], stdout: "pipe" });
  return { pid: child.pid, exited: (async () => {
    const actual = (await new Response(child.stdout).text()).trim();
    if (actual !== expected) throw new Error(actual + " != " + expected);
    return await child.exited;
  })() };
};
const { installBrowser } = await import(${JSON.stringify(install)});
await installBrowser({ force: false });
`);
      const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "./browsers" };
      delete env.INIT_CWD;
      if (initCwd !== undefined) env.INIT_CWD = initCwd;
      const proc = Bun.spawn([process.execPath, script], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`installer retains invocation directory with INIT_CWD=${String(initCwd)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "vlint-installer-cache-"));
    try {
      const bin = join(directory, "bin");
      await mkdir(bin);
      const log = join(directory, "calls");
      const fake = `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PWD" "\${INIT_CWD-unset}" "$PLAYWRIGHT_BROWSERS_PATH" >> "$CALL_LOG"\n`;
      await writeFile(join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(bin, "sha256sum"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(bin, "awk"), "#!/bin/sh\nprintf 'checksum archive\\n'\n", { mode: 0o755 });
      await writeFile(join(bin, "tar"), `#!/bin/sh\ncp "$FAKE_BINARY" vlint\n`, { mode: 0o755 });
      const binary = join(directory, "candidate");
      await writeFile(binary, fake, { mode: 0o755 });
      const script = join(directory, "install.sh");
      await writeFile(script, renderInstaller("0.10.0", "wh3at/vlint"));
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VLINT_INSTALL_DIR: join(directory, "installed"), CALL_LOG: log, FAKE_BINARY: binary, PLAYWRIGHT_BROWSERS_PATH: "./browsers" };
      delete env.INIT_CWD;
      if (initCwd !== undefined) env.INIT_CWD = initCwd;
      const proc = Bun.spawn(["sh", script], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      expect(await Bun.file(log).text()).toBe(`${directory}|${initCwd ?? "unset"}|./browsers\n`.repeat(2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
