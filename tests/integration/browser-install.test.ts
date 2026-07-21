import { expect, test } from "bun:test";
import {
  findManagedBrowser,
  inspectBrowserRequirements,
  installBrowser,
  installBrowserDependencies,
  isDependenciesInstallerWorkerInvocation,
  isDependenciesSupervisorWorkerInvocation,
  isInstallerWorkerInvocation,
  isOopDownloaderInvocation,
  rejectAmbientBrowserOverrides,
  resolveManagedExecutableForCheck,
  verifyActualBrowserVersion,
  type DirectoryScanner,
  type ExistsChecker,
  type ExecutableAccessChecker,
  type VersionProbe,
  type VersionProbeResult,
} from "../../src/browser/install";
import { parseBrowserInstallArgs, runBrowserInstall } from "../../src/commands/browser-install";
import { runBrowserStatus } from "../../src/commands/browser-status";

const CLEAN_ENV = {} as const;

function registryVersion(): string {
  return findManagedBrowser().browserVersion;
}

function matchingProbe(): VersionProbe {
  const version = registryVersion();
  return () => ({ exitCode: 0, timedOut: false, stdout: `Google Chrome for Testing ${version}` });
}

function probe(result: VersionProbeResult): VersionProbe {
  return () => result;
}

function notReadyThenReadySeams(): {
  directoryScanner: DirectoryScanner;
  existsChecker: ExistsChecker;
  executableAccessChecker: ExecutableAccessChecker;
} {
  let callCount = 0;
  const pinnedRevision = findManagedBrowser().revision;
  return {
    directoryScanner: () => {
      callCount++;
      if (callCount <= 1) return [];
      return [`chromium_headless_shell-${pinnedRevision}`];
    },
    existsChecker: () => callCount > 1,
    executableAccessChecker: () => callCount > 1,
  };
}

function neverReadySeams(): {
  directoryScanner: DirectoryScanner;
  existsChecker: ExistsChecker;
  executableAccessChecker: ExecutableAccessChecker;
} {
  return {
    directoryScanner: () => [],
    existsChecker: () => false,
    executableAccessChecker: () => false,
  };
}

function readySeams(): {
  directoryScanner: DirectoryScanner;
  existsChecker: ExistsChecker;
  executableAccessChecker: ExecutableAccessChecker;
} {
  const pinnedRevision = findManagedBrowser().revision;
  return {
    directoryScanner: () => [`chromium_headless_shell-${pinnedRevision}`],
    existsChecker: () => true,
    executableAccessChecker: () => true,
  };
}

test("rejectAmbientBrowserOverrides rejects PLAYWRIGHT_BROWSERS_PATH for both install and check", () => {
  const installResult = rejectAmbientBrowserOverrides("install", { PLAYWRIGHT_BROWSERS_PATH: "/somewhere" });
  expect(installResult.ok).toBe(false);
  if (!installResult.ok) {
    expect(installResult.failure.code).toBe("browser-cache-override-unsupported");
    expect(installResult.failure.stage).toBe("browser-setup");
  }
  const checkResult = rejectAmbientBrowserOverrides("check", { PLAYWRIGHT_BROWSERS_PATH: "/somewhere" });
  if (!checkResult.ok) expect(checkResult.failure.code).toBe("browser-cache-override-unsupported");
});

test("rejectAmbientBrowserOverrides rejects download-host overrides for install only, before installer access", () => {
  for (const env of [
    { PLAYWRIGHT_DOWNLOAD_HOST: "https://evil.example" },
    { PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: "https://evil.example" },
  ]) {
    const installResult = rejectAmbientBrowserOverrides("install", env);
    if (!installResult.ok) expect(installResult.failure.code).toBe("browser-download-host-override-unsupported");
  }
  expect(rejectAmbientBrowserOverrides("check", { PLAYWRIGHT_DOWNLOAD_HOST: "https://evil.example" }).ok).toBe(true);
});

test("rejectAmbientBrowserOverrides accepts a clean environment", () => {
  expect(rejectAmbientBrowserOverrides("install", CLEAN_ENV).ok).toBe(true);
  expect(rejectAmbientBrowserOverrides("check", CLEAN_ENV).ok).toBe(true);
});

test("verifyActualBrowserVersion accepts a matching version and rejects mismatch/nonzero/hang/unparseable", () => {
  const path = "/dev/null";
  const version = registryVersion();
  expect(verifyActualBrowserVersion(path, version, probe({ exitCode: 0, timedOut: false, stdout: `Google Chrome for Testing ${version}` })).ok).toBe(true);
  expect(verifyActualBrowserVersion(path, version, probe({ exitCode: 0, timedOut: false, stdout: "Google Chrome for Testing 1.2.3.4" })).ok).toBe(false);
  expect(verifyActualBrowserVersion(path, version, probe({ exitCode: 3, timedOut: false, stdout: "" })).ok).toBe(false);
  expect(verifyActualBrowserVersion(path, version, probe({ exitCode: null, timedOut: true, stdout: "" })).ok).toBe(false);
  expect(verifyActualBrowserVersion(path, version, probe({ exitCode: 0, timedOut: false, stdout: "no version here" })).ok).toBe(false);
  const mismatch = verifyActualBrowserVersion(path, version, probe({ exitCode: 0, timedOut: false, stdout: "148.0.0.0" }));
  if (!mismatch.ok) expect(mismatch.failure.code).toBe("browser-incompatible");
});


test("resolveManagedExecutableForCheck resolves when the actual version matches (injected probe)", () => {
  const result = resolveManagedExecutableForCheck(CLEAN_ENV, matchingProbe(), readySeams());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.name).toBe("chromium-headless-shell");
});

test("resolveManagedExecutableForCheck fails with cache override when PLAYWRIGHT_BROWSERS_PATH is set", () => {
  const result = resolveManagedExecutableForCheck({ PLAYWRIGHT_BROWSERS_PATH: "/somewhere" }, matchingProbe());
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});

test("installBrowser classifies already-present when the actual version matches (injected install + probe)", async () => {
  const result = await installBrowser({ force: false, environment: CLEAN_ENV, installAction: async () => undefined, versionProbe: matchingProbe(), ...readySeams() });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.kind).toBe("already-present");
});

test("installBrowser classifies a forced action as repaired when the version verifies", async () => {
  const result = await installBrowser({ force: true, environment: CLEAN_ENV, installAction: async () => undefined, versionProbe: matchingProbe() });
  if (result.ok) expect(result.value.kind).toBe("repaired");
});

test("installBrowser no-force mismatch fails with browser-incompatible and --force guidance, not already-present", async () => {
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => undefined,
    versionProbe: probe({ exitCode: 0, timedOut: false, stdout: "Google Chrome for Testing 148.0.0.0" }),
    ...notReadyThenReadySeams(),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-incompatible");
    expect(result.failure.message).toContain("--force");
  }
});

test("installBrowser force mismatch fails with browser-install-failed", async () => {
  const result = await installBrowser({
    force: true,
    environment: CLEAN_ENV,
    installAction: async () => undefined,
    versionProbe: probe({ exitCode: 0, timedOut: false, stdout: "148.0.0.0" }),
  });
  if (!result.ok) expect(result.failure.code).toBe("browser-install-failed");
});

test("installBrowser maps an installer failure to a sanitized browser-install-failed, never leaking the raw exception", async () => {
  const sentinel = "RAW-INSTALLER-SECRET-" + Math.random().toString(36);
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => {
      throw new Error(sentinel);
    },
    versionProbe: matchingProbe(),
    ...notReadyThenReadySeams(),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-install-failed");
    expect(result.failure.message).not.toContain(sentinel);
  }
});

test("installBrowser suppresses Playwright installer console output during the install action", async () => {
  const original = console.log;
  let spyCalls = 0;
  console.log = () => {
    spyCalls += 1;
  };
  try {
    const result = await installBrowser({
      force: false,
      environment: CLEAN_ENV,
      installAction: async () => {
        console.log("DOWNLOAD-PROGRESS-LEAK 50%");
      },
      versionProbe: matchingProbe(),
      ...notReadyThenReadySeams(),
    });
    expect(result.ok).toBe(true);
    expect(spyCalls).toBe(0); // the adapter's suppression swallowed the progress line
  } finally {
    console.log = original;
  }
  expect(console.log).toBe(original);
});

test("installBrowser returns signal-interrupt when aborted during the install action", async () => {
  const controller = new AbortController();
  const result = installBrowser({
    force: false,
    environment: CLEAN_ENV,
    signal: controller.signal,
    installAction: () => new Promise<void>(() => undefined), // never resolves on its own
    versionProbe: matchingProbe(),
  });
  controller.abort();
  const resolved = await result;
  if (!resolved.ok) expect(resolved.failure.code).toBe("signal-interrupt");
});

test("parseBrowserInstallArgs accepts force/with-deps once and rejects invalid arguments", () => {
  const bare = parseBrowserInstallArgs([]);
  if (bare.ok) expect(bare.value).toEqual({ force: false, withDeps: false });
  const both = parseBrowserInstallArgs(["--with-deps", "--force"]);
  if (both.ok) expect(both.value).toEqual({ force: true, withDeps: true });
  for (const args of [["--bogus"], ["--force", "--force"], ["--with-deps", "--with-deps"]]) {
    const invalid = parseBrowserInstallArgs(args);
    if (!invalid.ok) expect(invalid.failure.code).toBe("config-schema-invalid");
  }
});


test("runBrowserInstall installs system dependencies before the browser payload", async () => {
  const calls: string[] = [];
  const result = await runBrowserInstall({
    args: ["--with-deps"],
    environment: CLEAN_ENV,
    dependenciesInstaller: async () => {
      calls.push("dependencies");
      return { ok: true, value: undefined };
    },
    browserInstaller: async (options) => {
      calls.push("browser");
      expect(options.force).toBe(false);
      return {
        ok: true,
        value: {
          kind: "installed",
          browser: {
            name: "chromium-headless-shell",
            revision: "1234",
            browserVersion: "123.0.0.0",
            executablePath: "/cache/chromium",
          },
        },
      };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual(["dependencies", "browser"]);
});

test("runBrowserInstall stops when system dependency installation fails", async () => {
  let browserCalled = false;
  const result = await runBrowserInstall({
    args: ["--with-deps"],
    dependenciesInstaller: async () => ({
      ok: false,
      failure: {
        stage: "browser-setup",
        code: "browser-install-failed",
        message: "dependency failure",
        target: null,
        device: null,
        rule: null,
      },
    }),
    browserInstaller: async () => {
      browserCalled = true;
      throw new Error("must not run");
    },
  });
  expect(result.ok).toBe(false);
  expect(browserCalled).toBe(false);
});

test("installBrowserDependencies classifies success, failure, and cancellation", async () => {
  expect((await installBrowserDependencies({ installAction: async () => undefined })).ok).toBe(true);
  const failed = await installBrowserDependencies({
    installAction: async () => {
      throw new Error("raw");
    },
  });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.failure.code).toBe("browser-install-failed");

  const controller = new AbortController();
  controller.abort();
  const aborted = await installBrowserDependencies({
    signal: controller.signal,
    installAction: async () => undefined,
  });
  expect(aborted.ok).toBe(false);
  if (!aborted.ok) expect(aborted.failure.code).toBe("signal-interrupt");
});

test("runBrowserInstall rejects environment overrides before installing dependencies", async () => {
  let dependenciesCalled = false;
  const result = await runBrowserInstall({
    args: ["--with-deps"],
    environment: { PLAYWRIGHT_BROWSERS_PATH: "/tmp/other" },
    dependenciesInstaller: async () => {
      dependenciesCalled = true;
      return { ok: true, value: undefined };
    },
  });
  expect(result.ok).toBe(false);
  expect(dependenciesCalled).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});

test("runBrowserInstall returns signal-interrupt when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runBrowserInstall({ args: ["--force"], environment: CLEAN_ENV, signal: controller.signal });
  if (!result.ok) expect(result.failure.code).toBe("signal-interrupt");
});

test("worker and OOP downloader invocations require their exact internal shape", () => {
  expect(isInstallerWorkerInvocation([
    "/opt/vlint",
    "/$bunfs/root/src/cli.ts",
    "__vlint_internal_browser_installer_worker__",
    "--force",
  ])).toBe(true);
  expect(isInstallerWorkerInvocation([
    "/opt/vlint",
    "/$bunfs/root/src/cli.ts",
    "__vlint_internal_browser_installer_worker__",
    "--no-force",
  ])).toBe(true);
  expect(isDependenciesInstallerWorkerInvocation([
    "/opt/vlint",
    "/$bunfs/root/src/cli.ts",
    "__vlint_internal_browser_dependencies_installer_worker__",
  ])).toBe(true);
  expect(isDependenciesSupervisorWorkerInvocation([
    "/opt/vlint",
    "/$bunfs/root/src/cli.ts",
    "__vlint_internal_browser_dependencies_supervisor_worker__",
  ])).toBe(true);
  expect(isInstallerWorkerInvocation(["/opt/vlint", "/$bunfs/root/src/cli.ts", "install"])).toBe(false);
  expect(isDependenciesInstallerWorkerInvocation([
    "/opt/vlint",
    "/$bunfs/root/src/cli.ts",
    "check",
    "--url",
    "__vlint_internal_browser_dependencies_installer_worker__",
  ])).toBe(false);
  expect(isOopDownloaderInvocation("/some/path/oopBrowserDownload.js")).toBe(true);
  expect(isOopDownloaderInvocation(undefined)).toBe(false);
});

// ── U1: inspectBrowserRequirements tests ──────────────────────────────────

test("inspectBrowserRequirements returns ready when executable is present, executable, and version matches", () => {
  const browser = findManagedBrowser();
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => true,
    executableAccessChecker: () => true,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.status).toBe("ready");
    expect(result.value.requirements.revision).toBe(browser.revision);
  }
});

test("inspectBrowserRequirements returns missing when no cache entries exist", () => {
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [],
    existsChecker: () => false,
    executableAccessChecker: () => true,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.status).toBe("missing");
});

test("inspectBrowserRequirements returns partial when pinned directory exists but executable is absent", () => {
  const browser = findManagedBrowser();
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => false,
    executableAccessChecker: () => true,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.status).toBe("partial");
    expect(result.value.executablePresent).toBe(false);
  }
});

test("inspectBrowserRequirements returns partial when pinned chromium exists but headless shell is absent", () => {
  const browser = findManagedBrowser();
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [`chromium-${browser.revision}`],
    existsChecker: () => false,
    executableAccessChecker: () => true,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.status).toBe("partial");
});

test("inspectBrowserRequirements returns revision-mismatch when only older revisions exist", () => {
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [
      "chromium_headless_shell-1000",
      "chromium_headless_shell-999",
    ],
    existsChecker: () => false,
    executableAccessChecker: () => true,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.status).toBe("revision-mismatch");
    expect(result.value.detectedRevisions).toHaveLength(2);
  }
});

test("inspectBrowserRequirements returns not-executable when executable exists but is not executable", () => {
  const browser = findManagedBrowser();
  const result = inspectBrowserRequirements({
    environment: CLEAN_ENV,
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => true,
    executableAccessChecker: () => false,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.status).toBe("not-executable");
    expect(result.value.executablePresent).toBe(true);
    expect(result.value.executableAccessible).toBe(false);
  }
});

test("inspectBrowserRequirements rejects PLAYWRIGHT_BROWSERS_PATH before inspecting the cache", () => {
  const result = inspectBrowserRequirements({
    environment: { PLAYWRIGHT_BROWSERS_PATH: "/somewhere" },
    directoryScanner: () => [],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});

test("inspectBrowserRequirements reports XDG_CACHE_HOME in environment flags", () => {
  const result = inspectBrowserRequirements({
    environment: { XDG_CACHE_HOME: "/custom/cache" },
    directoryScanner: () => [],
    existsChecker: () => false,
    versionProbe: matchingProbe(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.environment.xdgCacheHome).toBe("/custom/cache");
  }
});

// ── U2: resolveManagedExecutableForCheck diagnostics ──────────────────────

test("resolveManagedExecutableForCheck returns diagnostic with status missing when no cache entries exist", () => {
  const result = resolveManagedExecutableForCheck(
    CLEAN_ENV,
    matchingProbe(),
    {
      directoryScanner: () => [],
      existsChecker: () => false,
      executableAccessChecker: () => true,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-missing");
    expect(result.failure.browserDiagnostic).toBeDefined();
    expect(result.failure.browserDiagnostic?.status).toBe("missing");
    expect(result.failure.browserDiagnostic?.requirements.revision).toBeDefined();
    expect(result.failure.browserDiagnostic?.requirements.cacheRoot).toBeDefined();
  }
});

test("resolveManagedExecutableForCheck returns diagnostic with status partial when pinned dir exists but executable absent", () => {
  const browser = findManagedBrowser();
  const result = resolveManagedExecutableForCheck(
    CLEAN_ENV,
    matchingProbe(),
    {
      directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
      existsChecker: () => false,
      executableAccessChecker: () => true,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-missing");
    expect(result.failure.browserDiagnostic?.status).toBe("partial");
  }
});

test("resolveManagedExecutableForCheck returns diagnostic with status revision-mismatch when only older revisions exist", () => {
  const result = resolveManagedExecutableForCheck(
    CLEAN_ENV,
    matchingProbe(),
    {
      directoryScanner: () => [
        "chromium_headless_shell-1000",
        "chromium_headless_shell-999",
      ],
      existsChecker: () => false,
      executableAccessChecker: () => true,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-missing");
    expect(result.failure.browserDiagnostic?.status).toBe("revision-mismatch");
    expect(result.failure.browserDiagnostic?.detectedRevisions.length).toBe(2);
  }
});

test("resolveManagedExecutableForCheck returns diagnostic with status not-executable when executable is not accessible", () => {
  const browser = findManagedBrowser();
  const result = resolveManagedExecutableForCheck(
    CLEAN_ENV,
    matchingProbe(),
    {
      directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
      existsChecker: () => true,
      executableAccessChecker: () => false,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("browser-missing");
    expect(result.failure.browserDiagnostic?.status).toBe("not-executable");
    expect(result.failure.browserDiagnostic?.executablePresent).toBe(true);
    expect(result.failure.browserDiagnostic?.executableAccessible).toBe(false);
  }
});

test("resolveManagedExecutableForCheck rejects PLAYWRIGHT_BROWSERS_PATH before inspecting the cache", () => {
  const result = resolveManagedExecutableForCheck(
    { PLAYWRIGHT_BROWSERS_PATH: "/somewhere" },
    matchingProbe(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});

// ── U3: installBrowser idempotent no-op and repair ────────────────────────

test("installBrowser returns already-present without invoking install when ready (injected seams)", async () => {
  const browser = findManagedBrowser();
  let installCalled = false;
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => {
      installCalled = true;
    },
    versionProbe: matchingProbe(),
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => true,
    executableAccessChecker: () => true,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.kind).toBe("already-present");
  expect(installCalled).toBe(false);
});

test("installBrowser invokes install and returns installed when partial repaired by install action", async () => {
  const browser = findManagedBrowser();
  let executableExists = false;
  let installCalled = false;
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => {
      installCalled = true;
      executableExists = true;
    },
    versionProbe: matchingProbe(),
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => executableExists,
    executableAccessChecker: () => true,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.kind).toBe("installed");
    expect(result.value.browser.revision).toBe(browser.revision);
  }
  expect(installCalled).toBe(true);
});

test("installBrowser invokes install for revision-mismatch and succeeds when post-install is ready", async () => {
  const browser = findManagedBrowser();
  let hasPinned = false;
  const scanner = () => (hasPinned
    ? [`chromium_headless_shell-${browser.revision}`]
    : ["chromium_headless_shell-1000", "chromium_headless_shell-999"]);
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => {
      hasPinned = true;
    },
    versionProbe: matchingProbe(),
    directoryScanner: scanner,
    existsChecker: () => hasPinned,
    executableAccessChecker: () => true,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.kind).toBe("installed");
});

test("installBrowser returns repaired when forced install succeeds", async () => {
  const browser = findManagedBrowser();
  const result = await installBrowser({
    force: true,
    environment: CLEAN_ENV,
    installAction: async () => undefined,
    versionProbe: matchingProbe(),
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => true,
    executableAccessChecker: () => true,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.kind).toBe("repaired");
});

test("installBrowser fails with browser-install-failed when post-install executable is still not executable", async () => {
  const browser = findManagedBrowser();
  const result = await installBrowser({
    force: false,
    environment: CLEAN_ENV,
    installAction: async () => undefined,
    versionProbe: matchingProbe(),
    directoryScanner: () => [`chromium_headless_shell-${browser.revision}`],
    existsChecker: () => true,
    executableAccessChecker: () => false,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("browser-install-failed");
});

// ── U4: browser status command ────────────────────────────────────────────

test("runBrowserStatus returns JSON with status missing and metadata via --format json", () => {
  const result = runBrowserStatus({
    format: "json",
    environment: CLEAN_ENV,
    ...neverReadySeams(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.ready).toBe(false);
    const parsed = JSON.parse(result.value.output);
    expect(parsed.status).toBeDefined();
    expect(parsed.requirements).toBeDefined();
    expect(parsed.requirements.revision).toBeDefined();
    expect(parsed.requirements.executablePath).toBeDefined();
    expect(parsed.requirements.cacheRoot).toBeDefined();
  }
});

test("runBrowserStatus returns terminal output with repair hint for non-ready status", () => {
  const result = runBrowserStatus({ format: "terminal", environment: CLEAN_ENV, ...neverReadySeams() });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.ready).toBe(false);
    expect(result.value.output).toContain("browser status:");
    expect(result.value.output).toContain("vlint browser install");
  }
});

test("runBrowserStatus reports PLAYWRIGHT_BROWSERS_PATH override before cache inspection", () => {
  const result = runBrowserStatus({
    format: "terminal",
    environment: { PLAYWRIGHT_BROWSERS_PATH: "/somewhere" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});
