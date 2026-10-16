import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve("dist/vlint-linux-x64");

test("compiled init requires explicit selections without a terminal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vlint-58-"));
  try {
    const proc = Bun.spawn([binary, "init"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(error).toContain("--environment windows:chromium");
    expect(error).toContain("init --help");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("compiled init saves only explicit environments and public preset values without UA", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vlint-58-"));
  try {
    const proc = Bun.spawn([binary, "init", "--environment", "windows:firefox", "--environment", "iphone:webkit"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    const config = JSON.parse(await readFile(join(cwd, "vlint.config.json"), "utf8"));
    expect(config.environments).toEqual([
      { name: "windows-firefox", platform: "windows", browser: "firefox", devices: ["windows-firefox"] },
      { name: "iphone-webkit", platform: "iphone", browser: "webkit", devices: ["iphone-webkit"] },
    ]);
    expect(config.devices[1]).toEqual({ name: "iphone-webkit", viewport: { width: 402, height: 681 }, screen: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    expect(JSON.stringify(config)).not.toContain("userAgent");
    expect(JSON.stringify(config)).not.toContain("defaultBrowserType");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("compiled help discovers init, all six selections, repeatable syntax and examples", async () => {
  const root = Bun.spawn([binary, "--help"], { stdout: "pipe" });
  expect(await new Response(root.stdout).text()).toContain("init");
  expect(await root.exited).toBe(0);
  const proc = Bun.spawn([binary, "init", "--help"], { stdout: "pipe" });
  const help = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  for (const choice of ["windows:chromium", "windows:firefox", "macos:chromium", "macos:webkit", "iphone:webkit", "android:chromium"]) expect(help).toContain(choice);
  expect(help).toContain("--environment <platform:browser>");
  expect(help).toContain("Examples:");
});

for (const selection of ["windows:webkit", "linux:chromium", "iphone:firefox", "chromium", "", "Windows:chromium"]) {
  test(`compiled init rejects invalid selection ${JSON.stringify(selection)}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vlint-58-"));
    try {
      const proc = Bun.spawn([binary, "init", "--environment", selection], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(await new Response(proc.stderr).text()).toContain("init-environment-invalid");
      expect(await proc.exited).toBe(2);
      expect(await Bun.file(join(cwd, "vlint.config.json")).exists()).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("compiled terminal platform then browser selections match flags with and without a TTY", async () => {
  const directories = await Promise.all([0, 1, 2].map(() => mkdtemp(join(tmpdir(), "vlint-58-tty-"))));
  try {
    for (const [index, mode] of ["interactive", "flags"].entries()) {
      const proc = Bun.spawn(["python3", resolve("tests/fixtures/init-58-terminal.py"), binary, directories[index]!, mode], { stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      if (mode === "interactive") expect(output).toContain("Browser (chromium, firefox)");
    }
    const proc = Bun.spawn([binary, "init", "--environment", "windows:firefox", "--environment", "iphone:webkit"], { cwd: directories[2]!, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const configs = await Promise.all(directories.map((cwd) => readFile(join(cwd, "vlint.config.json"), "utf8")));
    expect(configs[0]).toBe(configs[1]);
    expect(configs[0]).toBe(configs[2]);
  } finally { await Promise.all(directories.map((cwd) => rm(cwd, { recursive: true, force: true }))); }
});

for (const kind of ["file", "directory", "symlink", "dangling-symlink"]) {
  test(`compiled init preserves existing ${kind} without migration`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vlint-58-preserve-"));
    const path = join(cwd, "vlint.config.json");
    const target = join(cwd, "target");
    try {
      if (kind === "file") await writeFile(path, '{"old":"unchanged"}');
      if (kind === "directory") await mkdir(path);
      if (kind === "symlink") await writeFile(target, "unchanged");
      if (kind.includes("symlink")) await symlink(target, path);
      const before = await lstat(path);
      const proc = Bun.spawn([binary, "init", "--environment", "android:chromium"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(await new Response(proc.stderr).text()).toContain("config-already-exists");
      expect(await proc.exited).toBe(2);
      expect((await lstat(path)).ino).toBe(before.ino);
      if (kind === "file") expect(await readFile(path, "utf8")).toBe('{"old":"unchanged"}');
      if (kind === "symlink") expect(await readFile(target, "utf8")).toBe("unchanged");
      if (kind === "dangling-symlink") expect(await Bun.file(target).exists()).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
