import { expect, test } from "bun:test";
import {
  findManagedBrowser,
  installBrowser,
  isInstallerWorkerInvocation,
  isOopDownloaderInvocation,
  rejectAmbientBrowserOverrides,
  resolveManagedExecutableForCheck,
  verifyActualBrowserVersion,
  type VersionProbe,
  type VersionProbeResult,
} from "../../src/browser/install";
import { parseBrowserInstallArgs, runBrowserInstall } from "../../src/commands/browser-install";

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
  const result = resolveManagedExecutableForCheck(CLEAN_ENV, matchingProbe());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.name).toBe("chromium-headless-shell");
});

test("resolveManagedExecutableForCheck fails with cache override when PLAYWRIGHT_BROWSERS_PATH is set", () => {
  const result = resolveManagedExecutableForCheck({ PLAYWRIGHT_BROWSERS_PATH: "/somewhere" }, matchingProbe());
  if (!result.ok) expect(result.failure.code).toBe("browser-cache-override-unsupported");
});

test("installBrowser classifies already-present when the actual version matches (injected install + probe)", async () => {
  const result = await installBrowser({ force: false, environment: CLEAN_ENV, installAction: async () => undefined, versionProbe: matchingProbe() });
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

test("parseBrowserInstallArgs accepts bare and --force and rejects unknown arguments", () => {
  expect(parseBrowserInstallArgs([]).ok).toBe(true);
  const force = parseBrowserInstallArgs(["--force"]);
  if (force.ok) expect(force.value.force).toBe(true);
  const unknown = parseBrowserInstallArgs(["--bogus"]);
  if (!unknown.ok) expect(unknown.failure.code).toBe("config-schema-invalid");
});


test("runBrowserInstall returns signal-interrupt when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runBrowserInstall({ args: ["--force"], environment: CLEAN_ENV, signal: controller.signal });
  if (!result.ok) expect(result.failure.code).toBe("signal-interrupt");
});

test("worker and OOP downloader invocations are detected", () => {
  expect(isInstallerWorkerInvocation(["__vlint_internal_browser_installer_worker__", "--force"])).toBe(true);
  expect(isInstallerWorkerInvocation(["install"])).toBe(false);
  expect(isOopDownloaderInvocation("/some/path/oopBrowserDownload.js")).toBe(true);
  expect(isOopDownloaderInvocation(undefined)).toBe(false);
});
