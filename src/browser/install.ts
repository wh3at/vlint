import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import coreBundle from "playwright-core/lib/coreBundle";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type BrowserSetupDiagnostic,
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
  installDeps(
    executables: readonly RegistryExecutable[],
    dryRun: boolean,
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
  readonly directoryScanner?: DirectoryScanner;
  readonly existsChecker?: ExistsChecker;
  readonly executableAccessChecker?: ExecutableAccessChecker;
}

export interface InstallDependenciesOptions {
  readonly signal?: AbortSignal;
  /** Test-only seam overriding Playwright's privileged dependency installer. */
  readonly installAction?: () => Promise<void>;
}

/**
 * Internal worker token. The compiled CLI dispatches an invocation whose argv
 * contains this token to {@link runInstallerWorkerMain}, beside the OOP
 * downloader dispatch, so the whole Playwright installer (including its OOP
 * downloader descendant) runs inside a process group the parent owns.
 */
export const INSTALLER_WORKER_TOKEN = "__vlint_internal_browser_installer_worker__";
export const DEPENDENCIES_INSTALLER_WORKER_TOKEN =
  "__vlint_internal_browser_dependencies_installer_worker__";
export const DEPENDENCIES_SUPERVISOR_WORKER_TOKEN =
  "__vlint_internal_browser_dependencies_supervisor_worker__";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;
const VERSION_PATTERN = /\d+\.\d+\.\d+\.\d+/;
const WORKER_GRACE_MS = 3_000;

function browserSetupFailure(code: Failure["code"], message: string): Failure {
  return { stage: "browser-setup", code, message, target: null, device: null, rule: null };
}

export function isInstallerWorkerInvocation(argv: readonly string[]): boolean {
  return argv.length === 4
    && argv[2] === INSTALLER_WORKER_TOKEN
    && (argv[3] === "--force" || argv[3] === "--no-force");
}

export function isDependenciesInstallerWorkerInvocation(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[2] === DEPENDENCIES_INSTALLER_WORKER_TOKEN;
}

export function isDependenciesSupervisorWorkerInvocation(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[2] === DEPENDENCIES_SUPERVISOR_WORKER_TOKEN;
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

export async function runDependenciesInstallerWorkerMain(): Promise<void> {
  try {
    const executable = bundle.registry.registry.findExecutable(MANAGED_BROWSER_NAME);
    await bundle.registry.registry.installDeps([executable], false);
    process.exit(0);
  } catch {
    process.exit(2);
  }
}

/**
 * Privileged dependency supervisor. Its detached child owns the apt process
 * group; an abort byte from the unprivileged parent lets this root process reap
 * the complete group before exiting.
 */
export async function runDependenciesSupervisorWorkerMain(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() !== 0) process.exit(2);
  const proc = Bun.spawn({
    cmd: [process.execPath, DEPENDENCIES_INSTALLER_WORKER_TOKEN],
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  const abort = new Promise<"abort">((resolve) => {
    process.stdin.once("data", () => resolve("abort"));
    process.stdin.resume();
  });
  const outcome = await Promise.race([
    proc.exited.then((code) => ({ kind: "exit" as const, code })),
    abort.then(() => ({ kind: "abort" as const })),
  ]);
  if (outcome.kind === "abort") {
    await terminateInstallerGroup(proc.pid);
    await proc.exited.catch(() => undefined);
    process.exit(130);
  }
  process.exit(outcome.code);
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

async function acquireDependencyPrivileges(
  signal: AbortSignal | undefined,
): Promise<InstallActionOutcome | null> {
  if (typeof process.getuid !== "function" || process.getuid() === 0) return null;
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ["sudo", "-v"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    return { aborted: false, success: false };
  }
  try {
    const code = await raceAbort(signal, proc.exited);
    return code === 0 ? null : { aborted: false, success: false };
  } catch (error) {
    if (!isAbortError(error)) throw error;
    proc.kill("SIGTERM");
    await proc.exited.catch(() => undefined);
    return { aborted: true, success: false };
  }
}

async function runDependenciesInstallAction(
  options: InstallDependenciesOptions,
): Promise<InstallActionOutcome> {
  if (options.installAction !== undefined) {
    try {
      await raceAbort(options.signal, options.installAction());
      return { aborted: false, success: true };
    } catch (error) {
      if (isAbortError(error)) return { aborted: true, success: false };
      return { aborted: false, success: false };
    }
  }

  const privilege = await acquireDependencyPrivileges(options.signal);
  if (privilege !== null) return privilege;

  const tmp = mkdtempSync(join(tmpdir(), "vlint-install-deps-"));
  try {
    const supervisorCommand =
      typeof process.getuid === "function" && process.getuid() === 0
        ? [process.execPath, DEPENDENCIES_SUPERVISOR_WORKER_TOKEN]
        : ["sudo", "--", process.execPath, DEPENDENCIES_SUPERVISOR_WORKER_TOKEN];
    const proc = Bun.spawn({
      cmd: supervisorCommand,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      cwd: tmp,
    });
    try {
      const code = await raceAbort(options.signal, proc.exited);
      proc.stdin.end();
      return { aborted: false, success: code === 0 };
    } catch (error) {
      if (isAbortError(error)) {
        try {
          proc.stdin.write("abort\n");
          proc.stdin.end();
        } catch {
          /* supervisor already exited */
        }
        await proc.exited.catch(() => undefined);
        return { aborted: true, success: false };
      }
      throw error;
    }
  } catch {
    return { aborted: false, success: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function postInstallVerify(
  force: boolean,
  wasReady: boolean,
  options: InstallOptions,
): BoundaryResult<InstallOutcome> {
  const after = inspectBrowserRequirements({
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.versionProbe !== undefined ? { versionProbe: options.versionProbe } : {}),
    ...(options.directoryScanner !== undefined
      ? { directoryScanner: options.directoryScanner }
      : {}),
    ...(options.existsChecker !== undefined ? { existsChecker: options.existsChecker } : {}),
    ...(options.executableAccessChecker !== undefined
      ? { executableAccessChecker: options.executableAccessChecker }
      : {}),
  });
  if (!after.ok) {
    return boundaryFailure(
      browserSetupFailure("browser-install-failed", "Chromium installation failed; rerun 'vlint browser install'"),
    );
  }

  const info = after.value;
  if (info.status !== "ready") {
    return boundaryFailure(
      browserSetupFailure(
        "browser-install-failed",
        force
          ? "Chromium installation completed but is not ready; rerun 'vlint browser install'"
          : "Chromium installation failed; rerun 'vlint browser install'",
      ),
    );
  }

  const verified = verifyActualBrowserVersion(
    info.requirements.executablePath,
    info.requirements.browserVersion,
    options.versionProbe,
  );
  if (!verified.ok) {
    if (!force) return boundaryFailure(verified.failure);
    return boundaryFailure(
      browserSetupFailure(
        "browser-install-failed",
        "Chromium installation completed but the version check failed; rerun 'vlint browser install'",
      ),
    );
  }

  const kind: InstallOutcomeKind = force ? "repaired" : wasReady ? "already-present" : "installed";
  return boundarySuccess({
    kind,
    browser: {
      name: MANAGED_BROWSER_NAME,
      revision: info.requirements.revision,
      browserVersion: info.requirements.browserVersion,
      executablePath: info.requirements.executablePath,
    },
  });
}

/**
 * Explicitly installs the Ubuntu libraries required by the pinned managed
 * browser. The worker remains in the terminal's foreground process group so
 * sudo can prompt and terminal cancellation reaches privileged descendants.
 * This path is never called by `vlint check`.
 */
export async function installBrowserDependencies(
  options: InstallDependenciesOptions = {},
): Promise<BoundaryResult<void>> {
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());
  const outcome = await runDependenciesInstallAction(options);
  if (outcome.aborted) return boundaryFailure(interruptFailure());
  if (!outcome.success) {
    return boundaryFailure(
      browserSetupFailure(
        "browser-install-failed",
        "Chromium system dependency installation failed; rerun 'vlint browser install --with-deps'",
      ),
    );
  }
  return boundarySuccess(undefined);
}

/**
 * Installs (or repairs) the managed Chromium headless shell via a detached
 * internal worker. Uses the cache-state classifier to no-op when ready,
 * or invoke the Playwright repair path for missing/partial/mismatched
 * cache states. Never downloads during `vlint check`.
 *
 * After the worker exits 0, the parent re-verifies the binary's actual
 * `--version`. A no-force install leaving a mismatched cache fails with
 * `browser-incompatible` (+ `--force` hint); a force repair that still
 * mismatches is `browser-install-failed`. An abort mid-install kills the
 * worker group (grace then force) and returns a sanitized `signal-interrupt`.
 * Raw downloader progress/exceptions never reach the terminal.
 */
export async function installBrowser(options: InstallOptions): Promise<BoundaryResult<InstallOutcome>> {
  const guard = rejectAmbientBrowserOverrides("install", options.environment);
  if (!guard.ok) return boundaryFailure(guard.failure);
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());

  const before = inspectBrowserRequirements({
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.versionProbe !== undefined ? { versionProbe: options.versionProbe } : {}),
    ...(options.directoryScanner !== undefined
      ? { directoryScanner: options.directoryScanner }
      : {}),
    ...(options.existsChecker !== undefined ? { existsChecker: options.existsChecker } : {}),
    ...(options.executableAccessChecker !== undefined
      ? { executableAccessChecker: options.executableAccessChecker }
      : {}),
  });
  if (!before.ok) return boundaryFailure(before.failure);

  const wasReady = before.value.status === "ready";

  if (wasReady && !options.force) {
    return boundarySuccess({
      kind: "already-present",
      browser: {
        name: MANAGED_BROWSER_NAME,
        revision: before.value.requirements.revision,
        browserVersion: before.value.requirements.browserVersion,
        executablePath: before.value.requirements.executablePath,
      },
    });
  }

  const outcome = await runInstallAction(options);
  if (outcome.aborted) return boundaryFailure(interruptFailure());
  if (!outcome.success) {
    return boundaryFailure(
      browserSetupFailure("browser-install-failed", "Chromium installation failed; rerun 'vlint browser install'"),
    );
  }
  return postInstallVerify(options.force, wasReady, options);
}

function snapshotToDiagnostic(snapshot: BrowserSnapshot): BrowserSetupDiagnostic {
  return {
    requirements: {
      name: snapshot.requirements.name,
      revision: snapshot.requirements.revision,
      browserVersion: snapshot.requirements.browserVersion,
      executablePath: snapshot.requirements.executablePath,
      cacheRoot: snapshot.requirements.cacheRoot,
    },
    status: snapshot.status,
    environment: {
      xdgCacheHome: snapshot.environment.xdgCacheHome,
      playwrightBrowsersPath: snapshot.environment.playwrightBrowsersPath,
    },
    detectedRevisions: snapshot.detectedRevisions.map((e) => ({
      revision: e.revision,
      path: e.path,
    })),
    executablePresent: snapshot.executablePresent,
    executableAccessible: snapshot.executableAccessible,
  };
}

function browserSetupFailureWithDiagnostic(
  code: Failure["code"],
  message: string,
  diagnostic: BrowserSetupDiagnostic,
): Failure {
  const base = browserSetupFailure(code, message);
  return { ...base, browserDiagnostic: diagnostic };
}

/**
 * Check-path resolution: confirms the managed executable is present AND that its
 * actual `--version` matches the pinned registry version, without downloading.
 * When the browser is not ready, attaches a structured diagnostic payload.
 */
export function resolveManagedExecutableForCheck(
  environment: EnvironmentView | undefined = process.env,
  probe: VersionProbe | undefined = undefined,
  extraSeams: {
    readonly directoryScanner?: DirectoryScanner;
    readonly existsChecker?: ExistsChecker;
    readonly executableAccessChecker?: ExecutableAccessChecker;
  } = {},
): BoundaryResult<ManagedBrowserInfo> {
  const snapshot = inspectBrowserRequirements({
    environment,
    ...(probe !== undefined ? { versionProbe: probe } : {}),
    ...extraSeams,
  });
  if (!snapshot.ok) return boundaryFailure(snapshot.failure);

  const info = snapshot.value;

  if (info.status !== "ready") {
    return boundaryFailure(
      browserSetupFailureWithDiagnostic(
        "browser-missing",
        "Managed Chromium is not installed; run 'vlint browser install'",
        snapshotToDiagnostic(info),
      ),
    );
  }

  const verified = verifyActualBrowserVersion(
    info.requirements.executablePath,
    info.requirements.browserVersion,
    probe,
  );
  if (!verified.ok) return boundaryFailure(verified.failure);

  return boundarySuccess({
    name: MANAGED_BROWSER_NAME,
    revision: info.requirements.revision,
    browserVersion: info.requirements.browserVersion,
    executablePath: info.requirements.executablePath,
  });
}

// ── U1: Browser requirements snapshot and cache-state classifier ──────────

export type ReadinessStatus =
  | "ready"
  | "missing"
  | "partial"
  | "revision-mismatch"
  | "not-executable";

export interface CacheEntry {
  readonly revision: string;
  readonly path: string;
}

export interface EnvironmentFlags {
  readonly xdgCacheHome: string | undefined;
  readonly playwrightBrowsersPath: string | undefined;
}

export interface BrowserRequirements {
  readonly name: ManagedBrowserName;
  readonly revision: string;
  readonly browserVersion: string;
  readonly executablePath: string;
  readonly cacheRoot: string;
}

export interface BrowserSnapshot {
  readonly requirements: BrowserRequirements;
  readonly status: ReadinessStatus;
  readonly environment: EnvironmentFlags;
  readonly detectedRevisions: readonly CacheEntry[];
  readonly executablePresent: boolean;
  readonly executableAccessible: boolean;
}

export type DirectoryScanner = (path: string) => readonly string[];
export type ExistsChecker = (path: string) => boolean;
export type ExecutableAccessChecker = (path: string) => boolean;

export interface SnapshotOptions {
  readonly environment?: EnvironmentView;
  readonly directoryScanner?: DirectoryScanner;
  readonly existsChecker?: ExistsChecker;
  readonly executableAccessChecker?: ExecutableAccessChecker;
  readonly versionProbe?: VersionProbe;
}

const CHROMIUM_HEADLESS_SHELL_PREFIX = "chromium_headless_shell-";
const CHROMIUM_PREFIX = "chromium-";

function defaultDirectoryScanner(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function defaultExistsChecker(path: string): boolean {
  return existsSync(path);
}

function defaultExecutableAccessChecker(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cacheRootPath(executablePath: string): string {
  return dirname(dirname(dirname(executablePath)));
}

interface ScanResult {
  readonly headlessShell: readonly CacheEntry[];
  readonly chromium: readonly CacheEntry[];
}

function scanCacheDirectory(
  cacheRoot: string,
  scanner: DirectoryScanner,
): ScanResult {
  const headlessShell: CacheEntry[] = [];
  const chromium: CacheEntry[] = [];
  try {
    for (const name of scanner(cacheRoot)) {
      if (name.startsWith(CHROMIUM_HEADLESS_SHELL_PREFIX)) {
        headlessShell.push({
          revision: name.slice(CHROMIUM_HEADLESS_SHELL_PREFIX.length),
          path: join(cacheRoot, name),
        });
      } else if (name.startsWith(CHROMIUM_PREFIX)) {
        chromium.push({
          revision: name.slice(CHROMIUM_PREFIX.length),
          path: join(cacheRoot, name),
        });
      }
    }
  } catch {
    /* cache root not accessible */
  }
  return { headlessShell, chromium };
}

function detectEnvironmentFlags(env: EnvironmentView): EnvironmentFlags {
  return {
    xdgCacheHome: env["XDG_CACHE_HOME"],
    playwrightBrowsersPath: env["PLAYWRIGHT_BROWSERS_PATH"],
  };
}

export function inspectBrowserRequirements(
  options: SnapshotOptions = {},
): BoundaryResult<BrowserSnapshot> {
  const env = options.environment ?? process.env;

  const guard = rejectAmbientBrowserOverrides("check", env);
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

  const scanner = options.directoryScanner ?? defaultDirectoryScanner;
  const existsCheck = options.existsChecker ?? defaultExistsChecker;
  const executableCheck =
    options.executableAccessChecker ?? defaultExecutableAccessChecker;

  const cacheRoot = cacheRootPath(browser.executablePath);
  const { headlessShell: cacheEntries, chromium: chromiumEntries } =
    scanCacheDirectory(cacheRoot, scanner);
  const pinnedRevision = browser.revision;

  const hasPinnedHeadlessShell = cacheEntries.some(
    (e) => e.revision === pinnedRevision,
  );
  const hasAnyHeadlessShell = cacheEntries.length > 0;
  const hasPinnedChromium = chromiumEntries.some(
    (e) => e.revision === pinnedRevision,
  );

  const executablePath = browser.executablePath;
  const executablePresent = existsCheck(executablePath);
  const executableAccessible =
    executablePresent && executableCheck(executablePath);

  let status: ReadinessStatus;

  if (hasPinnedHeadlessShell) {
    if (!executablePresent) {
      status = "partial";
    } else if (!executableAccessible) {
      status = "not-executable";
    } else {
      status = "ready";
    }
  } else if (hasPinnedChromium) {
    status = "partial";
  } else if (hasAnyHeadlessShell) {
    status = "revision-mismatch";
  } else {
    status = "missing";
  }

  return boundarySuccess({
    requirements: {
      name: MANAGED_BROWSER_NAME,
      revision: browser.revision,
      browserVersion: browser.browserVersion,
      executablePath: browser.executablePath,
      cacheRoot,
    },
    status,
    environment: detectEnvironmentFlags(env),
    detectedRevisions: cacheEntries,
    executablePresent,
    executableAccessible,
  });
}
