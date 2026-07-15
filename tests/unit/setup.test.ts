import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryFailure, boundarySuccess } from "../../src/contracts/failure";
import { loadConfig } from "../../src/config/load";
import { CONFIG_NAME, runInitCommand } from "../../src/commands/init";
import { runSetupCommand, type SetupBrowserInstaller } from "../../src/commands/setup";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vlint-setup-test-"));
}

function successfulInstaller(calls: string[]): SetupBrowserInstaller {
  return async () => {
    calls.push("install");
    return boundarySuccess({
      kind: "installed",
      browser: {
        name: "chromium-headless-shell",
        revision: "1234",
        browserVersion: "123.0.0.0",
        executablePath: "/cache/chromium",
      },
    });
  };
}

describe("vlint setup", () => {
  test("creates config and installs the browser on a fresh project", async () => {
    const cwd = await temporaryDirectory();
    const calls: string[] = [];

    const result = await runSetupCommand(cwd, {}, undefined, successfulInstaller(calls));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toBe("created");
    expect(result.value.browser.kind).toBe("installed");
    expect(calls).toEqual(["install"]);
    expect((await loadConfig(cwd)).ok).toBe(true);
  });

  test("keeps an existing valid config and remains idempotent", async () => {
    const cwd = await temporaryDirectory();
    expect((await runInitCommand(cwd)).ok).toBe(true);
    const before = await readFile(join(cwd, CONFIG_NAME), "utf8");
    const calls: string[] = [];

    const result = await runSetupCommand(cwd, {}, undefined, successfulInstaller(calls));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toBe("already-present");
    expect(await readFile(join(cwd, CONFIG_NAME), "utf8")).toBe(before);
    expect(calls).toEqual(["install"]);
  });

  test("does not install a browser when an existing config is invalid", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, CONFIG_NAME), "not json\n", "utf8");
    const calls: string[] = [];

    const result = await runSetupCommand(cwd, {}, undefined, successfulInstaller(calls));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config-invalid-json");
    expect(calls).toEqual([]);
  });

  test("rejects a symlink config instead of silently accepting another file", async () => {
    const source = await temporaryDirectory();
    expect((await runInitCommand(source)).ok).toBe(true);
    const cwd = await temporaryDirectory();
    await symlink(join(source, CONFIG_NAME), join(cwd, CONFIG_NAME));
    const calls: string[] = [];

    const result = await runSetupCommand(cwd, {}, undefined, successfulInstaller(calls));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config-read-failed");
    expect(calls).toEqual([]);
  });

  test("leaves a created config recoverable when browser installation fails", async () => {
    const cwd = await temporaryDirectory();
    const failed: SetupBrowserInstaller = async () =>
      boundaryFailure({
        stage: "browser-setup",
        code: "browser-install-failed",
        message: "failed",
        target: null,
        device: null,
        rule: null,
      });

    const first = await runSetupCommand(cwd, {}, undefined, failed);
    expect(first.ok).toBe(false);
    expect((await loadConfig(cwd)).ok).toBe(true);

    const calls: string[] = [];
    const second = await runSetupCommand(cwd, {}, undefined, successfulInstaller(calls));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.config).toBe("already-present");
  });
  test("does not create a config when setup is already cancelled", async () => {
    const cwd = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];

    const result = await runSetupCommand(
      cwd,
      {},
      controller.signal,
      successfulInstaller(calls),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("signal-interrupt");
    expect((await loadConfig(cwd)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

});
