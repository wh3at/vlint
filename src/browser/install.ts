import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import coreBundle from "playwright-core/lib/coreBundle";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { interruptFailure, isAbortError, raceAbort, signalAborted } from "./readiness";

/**
 * Internal Playwright installer seam. `playwright-core/lib/coreBundle` bundles
 * Playwright's own registry and out-of-process downloader entrypoint — the same
 * proven seam exercised by the U1 compiled feasibility probe.
 */
interface RegistryExecutable {
  revision: number;
  browserVersion: string;
  executablePath(): string;
  executablePathOrDie(language: string): string;
}

interface Registry {
  findExecutable(name: string): RegistryExecutable;
  install(
    executables: readonly RegistryExecutable[],
    options: { readonly force: boolean },
  ): Promise<void>;
}

interface RegistryBundle {
  readonly registry: Registry;
  installBrowsersForNpmInstall(names: readonly string[]): Promise<void>;
  runOopDownloadBrowserMain(): void;
}

interface CoreBundle {
  readonly registry: RegistryBundle;
}

const bundle = coreBundle as unknown as CoreBundle;

export const MANAGED_BROWSER_NAME = "chromium-headless-shell";
export type ManagedBrowserName = typeof MANAGED_BROWSER_NAME;

export interface ManagedBrowserInfo {
  readonly name: ManagedBrowserName;
  readonly revision: string;
  readonly browserVersion: string;
  readonly executablePath: string;
}

export type InstallOutcomeKind = "already-present" | "installed" | "repaired";

export interface InstallOutcome {
  readonly kind: InstallOutcomeKind;
  readonly browser: ManagedBrowserInfo;
}

export type EnvironmentView = Readonly<Record<string, string | undefined>>;

export type VersionProbe = (executablePath: string) => VersionProbeResult;

export interface VersionProbeResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
}

export interface InstallOptions {
  readonly force: boolean;
  readonly environment?: EnvironmentView;
  readonly signal?: AbortSignal;
  /** Test-only seam: runs the install in-process instead of the detached worker. */
  readonly installAction?: () => Promise<void>;
  /** Test-only seam overriding the actual-version probe. */
  readonly versionProbe?: VersionProbe;
}

/**
 * Internal worker token. The compiled CLI dispatches an invocation whose argv
 * contains this token to {@link runInstallerWorkerMain}, beside the OOP
 * downloader dispatch, so the whole Playwright installer (including its OOP
 * downloader descendant) runs inside a process group the parent owns.
 */
export const INSTALLER_WORKER_TOKEN = "__vlint_internal_browser_installer_worker__";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;
const VERSION_PATTERN = /\d+\.\d+\.\d+\.\d+/;
const WORKER_GRACE_MS = 3_000;

function browserSetupFailure(code: Failure["code"], message: string): Failure {
  return { stage: "browser-setup", code, message, target: null, rule: null };
}

export function isInstallerWorkerInvocation(argv: readonly string[]): boolean {
  return argv.includes(INSTALLER_WORKER_TOKEN);
}

export function isOopDownloaderInvocation(firstArg: string | undefined): boolean {
  return firstArg !== undefined && firstArg.endsWith("/oopBrowserDownload.js");
}

export function runOopDownloaderMain(): void {
  bundle.registry.runOopDownloadBrowserMain();
}

/**
 * Internal installer worker entrypoint. Runs the Playwright install in-process
 * and exits 0 on success / nonzero on failure. Its stdout/stderr are piped and
 * discarded by the parent; its OOP downloader descendant inherits this worker's
 * process group, so nothing leaks and the whole group is killable on abort.
 * Exported for the compiled CLI's earliest dispatch.
 */
export async function runInstallerWorkerMain(argv: readonly string[]): Promise<void> {
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  const force = argv.includes("--force");
  try {
    if (force) {
      const executable = bundle.registry.registry.findExecutable(MANAGED_BROWSER_NAME);
      await bundle.registry.registry.install([executable], { force: true });
    } else {
      await bundle.registry.installBrowsersForNpmInstall([MANAGED_BROWSER_NAME]);
    }
    process.exit(0);
  } catch {
    process.exit(2);
  }
}

export function probeBrowserVersion(executablePath: string): VersionProbeResult {
  const proc = Bun.spawnSync([executablePath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: VERSION_PROBE_MAX_BUFFER,
  });
  const stdout = typeof proc.stdout === "string" ? proc.stdout : proc.stdout.toString("utf8");
  return { exitCode: proc.exitCode, timedOut: proc.exitedDueToTimeout === true, stdout };
}

/**
 * Verifies the managed binary's ACTUAL reported version against the registry's
 * expected `browserVersion`. Never trusts the cache directory revision alone: a
 * hang, nonzero exit, unparseable output, or mismatch is `browser-incompatible`.
 */
export function verifyActualBrowserVersion(
  executablePath: string,
  expectedBrowserVersion: string,
  probe: VersionProbe = probeBrowserVersion,
): BoundaryResult<void> {
  const result = probe(executablePath);
  if (result.timedOut) {
    return boundaryFailure(
      browserSetupFailure("browser-incompatible", "managed Chromium did not report its version in time; rerun 'vlint browser install'"),
    );
  }
  if (result.exitCode !== 0) {
    return boundaryFailure(
      browserSetupFailure("browser-incompatible", "managed Chromium failed to report its version; rerun 'vlint browser install'"),
    );
  }
  const match = VERSION_PATTERN.exec(result.stdout);
  const actual = match === null ? undefined : match[0];
  if (actual === undefined || actual !== expectedBrowserVersion) {
    return boundaryFailure(
      browserSetupFailure("browser-incompatible", "managed Chromium version does not match the pinned build; rerun 'vlint browser install --force'"),
    );
  }
  return boundarySuccess(undefined);
}

export function rejectAmbientBrowserOverrides(
  action: "install" | "check",
  environment: EnvironmentView | undefined = process.env,
): BoundaryResult<void> {
  const e = environment ?? process.env;
  if (e.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    return boundaryFailure(
      browserSetupFailure(
        "browser-cache-override-unsupported",
        "PLAYWRIGHT_BROWSERS_PATH is not supported; vlint uses the Playwright standard browser cache only",
      ),
    );
  }
  if (
    action === "install" &&
    (e.PLAYWRIGHT_DOWNLOAD_HOST !== undefined || e.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST !== undefined)
  ) {
    return boundaryFailure(
      browserSetupFailure(
        "browser-download-host-override-unsupported",
        "Playwright download host overrides are not supported",
      ),
    );
  }
  return boundarySuccess(undefined);
}

export function findManagedBrowser(): ManagedBrowserInfo {
  const executable = bundle.registry.registry.findExecutable(MANAGED_BROWSER_NAME);
  return {
    name: MANAGED_BROWSER_NAME,
    revision: String(executable.revision),
    browserVersion: String(executable.browserVersion),
    executablePath: executable.executablePath(),
  };
}

export function managedExecutablePresent(): boolean {
  return existsSync(findManagedBrowser().executablePath);
}

/** Swallows all console output produced while `thunk` runs, then restores. */
function withSuppressedConsole<T>(thunk: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  const info = console.info;
  const warn = console.warn;
  console.log = () => undefined;
  console.error = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  return thunk().finally(() => {
    console.log = log;
    console.error = error;
    console.info = info;
    console.warn = warn;
  });
}

function drain(stream: unknown): void {
  if (stream !== null && typeof stream === "object" && "getReader" in stream) {
    void (async () => {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })().catch(() => undefined);
  }
}

/** SIGTERM the worker process group, wait a short grace, then SIGKILL. */
async function terminateInstallerGroup(pid: number): Promise<void> {
  const signalGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* group already gone */
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + WORKER_GRACE_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signalGroup("SIGKILL");
}

type InstallActionOutcome = { readonly aborted: boolean; readonly success: boolean };

async function runInstallAction(options: InstallOptions): Promise<InstallActionOutcome> {
  // Test seam: run the caller-supplied action in-process, with console output
  // suppressed so Playwright progress never reaches the terminal.
  if (options.installAction !== undefined) {
    const action = options.installAction;
    try {
      await withSuppressedConsole(() => raceAbort(options.signal, action()));
      return { aborted: false, success: true };
    } catch (error) {
      if (isAbortError(error)) return { aborted: true, success: false };
      return { aborted: false, success: false };
    }
  }

  // Production: detach the whole Playwright installer in a worker process whose
  // group the parent owns, draining+discarding its stdio. The OOP downloader
  // descendant inherits this group, so an abort reaps the entire tree.
  const tmp = mkdtempSync(join(tmpdir(), "vlint-install-"));
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, INSTALLER_WORKER_TOKEN, options.force ? "--force" : "--no-force"],
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      cwd: tmp,
    });
    drain(proc.stdout);
    drain(proc.stderr);
    const pid = proc.pid;
    try {
      const code = await raceAbort(options.signal, proc.exited);
      return { aborted: false, success: code === 0 };
    } catch (error) {
      if (isAbortError(error)) {
        await terminateInstallerGroup(pid);
        return { aborted: true, success: false };
      }
      throw error;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function verifyAndClassify(
  force: boolean,
  wasPresent: boolean,
  probe: VersionProbe | undefined,
): BoundaryResult<InstallOutcome> {
  let browser: ManagedBrowserInfo;
  try {
    const executable = bundle.registry.registry.findExecutable(MANAGED_BROWSER_NAME);
    executable.executablePathOrDie("javascript");
    browser = findManagedBrowser();
  } catch {
    return boundaryFailure(
      browserSetupFailure("browser-install-failed", "Chromium installation failed; rerun 'vlint browser install'"),
    );
  }
  const verified = verifyActualBrowserVersion(browser.executablePath, browser.browserVersion, probe);
  if (!verified.ok) {
    if (!force) return boundaryFailure(verified.failure);
    return boundaryFailure(
      browserSetupFailure(
        "browser-install-failed",
        "Chromium installation completed but the version check failed; rerun 'vlint browser install'",
      ),
    );
  }
  const kind: InstallOutcomeKind = force ? "repaired" : wasPresent ? "already-present" : "installed";
  return boundarySuccess({ kind, browser });
}

/**
 * Installs (or repairs) the managed Chromium headless shell via a detached
 * internal worker. Idempotent when the cache is valid; `force` triggers a
 * Playwright-owned repair. Never downloads during `vlint check`.
 *
 * After the worker exits 0, the parent re-verifies the binary's actual
 * `--version`. A no-force install leaving a mismatched cache fails with
 * `browser-incompatible` (+ `--force` hint) rather than claiming
 * `already-present`; a force repair that still mismatches is
 * `browser-install-failed`. An abort mid-install kills the worker group (grace
 * then force) and returns a sanitized `signal-interrupt`. Raw downloader
 * progress/exceptions never reach the terminal.
 */
export async function installBrowser(options: InstallOptions): Promise<BoundaryResult<InstallOutcome>> {
  const guard = rejectAmbientBrowserOverrides("install", options.environment);
  if (!guard.ok) return boundaryFailure(guard.failure);
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());

  const wasPresent = managedExecutablePresent();
  const outcome = await runInstallAction(options);
  if (outcome.aborted) return boundaryFailure(interruptFailure());
  if (!outcome.success) {
    return boundaryFailure(
      browserSetupFailure("browser-install-failed", "Chromium installation failed; rerun 'vlint browser install'"),
    );
  }
  return verifyAndClassify(options.force, wasPresent, options.versionProbe);
}

/**
 * Check-path resolution: confirms the managed executable is present AND that its
 * actual `--version` matches the pinned registry version, without downloading.
 */
export function resolveManagedExecutableForCheck(
  environment: EnvironmentView | undefined = process.env,
  probe: VersionProbe | undefined = undefined,
): BoundaryResult<ManagedBrowserInfo> {
  const guard = rejectAmbientBrowserOverrides("check", environment);
  if (!guard.ok) return boundaryFailure(guard.failure);
  let browser: ManagedBrowserInfo;
  try {
    browser = findManagedBrowser();
  } catch {
    return boundaryFailure(
      browserSetupFailure(
        "browser-incompatible",
        "Managed Chromium cache is incompatible with this vlint build; rerun 'vlint browser install'",
      ),
    );
  }
  if (!existsSync(browser.executablePath)) {
    return boundaryFailure(
      browserSetupFailure("browser-missing", "Managed Chromium is not installed; run 'vlint browser install'"),
    );
  }
  const verified = verifyActualBrowserVersion(browser.executablePath, browser.browserVersion, probe);
  if (!verified.ok) return boundaryFailure(verified.failure);
  return boundarySuccess(browser);
}
