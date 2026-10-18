import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { releaseNames, renderInstaller } from "../../scripts/package-release";

async function runInstaller(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "vlint-installer-test-"));
  try {
    const bin = join(root, "bin");
    const assets = join(root, "assets");
    const destination = join(root, "destination");
    await Promise.all([bin, assets, destination].map((path) => mkdir(path)));
    const executable = "#!/bin/sh\nexit 0\n";
    await writeFile(join(assets, "vlint"), executable);
    const names = releaseNames("0.1.0");
    const archive = join(assets, names.archive);
    const tar = spawnSync("tar", ["-czf", archive, "vlint"], { cwd: assets });
    expect(tar.status).toBe(0);
    const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(join(assets, "SHA256SUMS"), `${checksum}  ${names.archive}\n`);
    const scripts: Record<string, string> = {
      curl: '#!/bin/sh\ncp "$ASSETS/${2##*/}" "$4"\n',
      mv: '#!/bin/sh\nif [ "$MODE" = failure ]; then exit 23; fi\n/bin/mv "$@"\nstatus=$?\nif [ "$status" -eq 0 ]; then\n  case "$MODE" in HUP|INT|TERM) kill -s "$MODE" "$PPID" ;; esac\nfi\nexit "$status"\n',
    };
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(join(bin, name), content);
      await chmod(join(bin, name), 0o755);
    }
    const target = join(destination, "vlint");
    if (mode === "directory") await mkdir(target);
    else if (mode === "directory-symlink") await symlink(assets, target);
    else await writeFile(target, "previous executable\n");
    const installer = join(root, "install.sh");
    await writeFile(installer, renderInstaller("0.1.0", "example/vlint"));
    const result = spawnSync("/bin/sh", [installer], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSETS: assets, MODE: mode, VLINT_INSTALL_DIR: destination },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect((await readdir(destination)).filter((name) => name.startsWith(".vlint."))).toEqual([]);
    expect((await readdir(assets)).filter((name) => name.startsWith(".vlint."))).toEqual([]);
    if (mode.startsWith("directory")) {
      expect((await readdir(target)).filter((name) => name.startsWith(".vlint."))).toEqual([]);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      contents: mode.startsWith("directory") ? undefined : await readFile(target, "utf8"),
      executable,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rendered installer commits a successful replacement", async () => {
  const result = await runInstaller("success");
  expect(result.status).toBe(0);
  expect(result.contents).toBe(result.executable);
  expect(result.stdout).toContain("installed to");
  expect(result.stderr).not.toContain("previous executable preserved");
});

for (const [signal, status] of [["HUP", 129], ["INT", 130], ["TERM", 143]] as const) {
  test(`rendered installer commits replacement before handling ${signal} at rename boundary`, async () => {
    const result = await runInstaller(signal);
    expect(result.status).toBe(status);
    expect(result.contents).toBe(result.executable);
    expect(result.stderr).not.toContain("previous executable preserved");
    expect(result.stderr).not.toContain("installation failed");
  });
}

test("rendered installer does not commit a failed rename", async () => {
  const result = await runInstaller("failure");
  expect(result.status).toBe(23);
  expect(result.contents).toBe("previous executable\n");
  expect(result.stderr).toContain("previous executable preserved");
  expect(result.stdout).not.toContain("installed to");
});

for (const mode of ["directory", "directory-symlink"]) {
  test(`rendered installer rejects ${mode} destination without nesting the candidate`, async () => {
    const result = await runInstaller(mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("previous executable preserved");
    expect(result.stdout).not.toContain("installed to");
  });
}
