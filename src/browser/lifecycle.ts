import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { chromium } from "playwright";
import type { EffectiveAuditCase, ReadyState, Viewport } from "../contracts/config";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";
import { resolveManagedExecutableForCheck, type VersionProbe } from "./install";
import {
  createDeadline,
  interruptFailure,
  isAbortError,
  isTimeoutError,
  raceAbort,
  signalAborted,
  waitForFonts,
  waitForReadyCondition,
  type Deadline,
} from "./readiness";

/** Run-level launch budget (KTD7). Distinct from the per-target deadline. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
/** Bounded budget for closing a page, context, or browser so a never-settling close cannot hang the CLI. */
const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

function browserSetupFailure(code: Failure["code"], message: string): Failure {
  return { stage: "browser-setup", code, message, target: null, device: null, rule: null };
}

function authFailure(code: Failure["code"], message: string): Failure {
  return { stage: "authentication", code, message, target: null, device: null, rule: null };
}

function navFailure(code: Failure["code"], message: string): Failure {
  return { stage: "navigation", code, message, target: null, device: null, rule: null };
}

function cleanupFailure(target: string | null, device: string | null, message: string): Failure {
  return { stage: "browser-setup", code: "browser-cleanup-failed", message, target, device, rule: null };
}

/**
 * Stamps the owning target and device onto a failure produced while acquiring a
 * case, without overriding an identity the failure already carries.
 */
function stampIdentity(name: string, device: string | null, failure: Failure): Failure {
  return {
    ...failure,
    target: failure.target === null ? name : failure.target,
    device: failure.device === null ? device : failure.device,
  };
}

/** Exact device-aware context options applied per audit case. Verified by integration tests. */
export interface ContextOptions {
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  /** null omits the option so Playwright's Chromium default user agent is preserved. */
  readonly userAgent: string | null;
  readonly locale: string;
  readonly timezoneId: string;
}

/**
 * Structural source for {@link contextOptionsFor}. {@link EffectiveAuditCase}
 * satisfies this; the legacy single-device path supplies a desktop-default view.
 */
interface DeviceContextSource {
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly userAgent: string | null;
  readonly locale: string;
  readonly timezoneId: string;
}

/** Validated Playwright storage state. Shape checked on read; semantics re-checked by Playwright. */
export interface BrowserState {
  readonly [key: string]: unknown;
}

/** Owns one Page and its BrowserContext for a single target. */
export interface BrowserTargetScope {
  readonly page: Page;
  close(): Promise<BoundaryResult<void>>;
}

/** Owns one Browser process shared across all targets in a run. */
export interface BrowserRunScope {
  readonly browserVersion: string;
  acquireCase(auditCase: EffectiveAuditCase, signal?: AbortSignal): Promise<BoundaryResult<BrowserTargetScope>>;
  close(): Promise<BoundaryResult<void>>;
}

export interface CreateRunScopeOptions {
  readonly launchTimeoutMs?: number;
  /** Cancellation for the run-level launch. Abort before/during launch returns an interrupt failure and reaps a late-settling browser. */
  readonly signal?: AbortSignal;
  /** Test seam: replaces the real Playwright launch to fault-inject launch failure. */
  readonly launch?: () => Promise<Browser>;
  /** Test seam overriding the actual-version probe used by the check-path resolution. */
  readonly versionProbe?: VersionProbe;
  /** Bounded budget (ms) for closing the managed browser; defaults to a generous safety cap. */
  readonly closeTimeoutMs?: number;
}

function contextOptionsFor(source: DeviceContextSource): ContextOptions {
  return {
    viewport: source.viewport,
    screen: source.screen,
    deviceScaleFactor: source.deviceScaleFactor,
    isMobile: source.isMobile,
    hasTouch: source.hasTouch,
    userAgent: source.userAgent,
    locale: source.locale,
    timezoneId: source.timezoneId,
  };
}

/** Identity and presentation for one acquisition, built from an audit case or legacy target. */
interface AcquisitionRequest extends DeviceContextSource {
  readonly name: string;
  readonly deviceName: string | null;
  readonly url: string;
  readonly timeoutMs: number;
  readonly browserState: string | null;
  readonly readyCondition: {
    readonly selector: string;
    readonly state: ReadyState;
  } | null;
}

async function raceTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    const error = new Error("launch timed out");
    error.name = "TimeoutError";
    reject(error);
  }, timeoutMs);
  task.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return promise;
}
/**
 * Awaits a close operation within a bounded budget. Resolves false on error or
 * timeout so a never-settling close surfaces as a typed failure rather than a
 * hang. A late-settling close is left to clean itself up — page/context/browser
 * closes hold no resource the caller must reap (unlike a late-launched browser).
 */
async function settleClose(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await raceTimeout(task, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function defaultLaunch(executablePath: string, timeoutMs: number): Promise<Browser> {
  return raceTimeout(chromium.launch({ headless: true, executablePath }), timeoutMs);
}

/** Creates the single run-level Browser after confirming the managed executable is present. */
export async function createBrowserRunScope(
  options: CreateRunScopeOptions = {},
): Promise<BoundaryResult<BrowserRunScope>> {
  const resolved = resolveManagedExecutableForCheck(undefined, options.versionProbe);
  if (!resolved.ok) return boundaryFailure(resolved.failure);
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());

  const timeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const launchPromise =
    options.launch !== undefined
      ? options.launch()
      : defaultLaunch(resolved.value.executablePath, timeoutMs);

  let browser: Browser;
  try {
    browser = await raceAbort(options.signal, launchPromise);
  } catch (error) {
    if (isAbortError(error)) {
      // A launch that settles after the abort must not leak an orphan browser.
      launchPromise.then(
        (late) => {
          void late.close().catch(() => undefined);
        },
        () => undefined,
      );
      return boundaryFailure(interruptFailure());
    }
    return boundaryFailure(
      browserSetupFailure("browser-launch-failed", "failed to launch the managed Chromium browser"),
    );
  }

  let closed = false;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const close = async (): Promise<BoundaryResult<void>> => {
    if (closed) return boundarySuccess(undefined);
    closed = true;
    if (await settleClose(browser.close(), closeTimeoutMs)) return boundarySuccess(undefined);
    return boundaryFailure(cleanupFailure(null, null, "failed to close the managed browser process"));
  };
  const version = browser.version();

  return boundarySuccess({
    browserVersion: version,
    acquireCase: (auditCase, signal) => acquireCaseScope(browser, auditCase, signal),
    close,
  });
}

/** Reads and shape-validates a browser-state file within the size cap. */
export async function readBrowserState(
  path: string,
  signal: AbortSignal | undefined = undefined,
): Promise<BoundaryResult<BrowserState>> {
  if (signalAborted(signal)) return boundaryFailure(interruptFailure());

  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return boundaryFailure(authFailure("state-missing", "browser state file was not found"));
    }
    return boundaryFailure(authFailure("state-read-failed", "cannot access browser state file"));
  }
  // stat() follows symlinks, so only a regular file at the resolved target is accepted.
  if (!stats.isFile()) {
    return boundaryFailure(authFailure("state-not-regular", "browser state must resolve to a regular file"));
  }
  if (stats.size > MAX_STATE_BYTES) {
    return boundaryFailure(authFailure("state-too-large", "browser state exceeds 8 MiB"));
  }

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return boundaryFailure(authFailure("state-read-failed", "cannot read browser state file"));
  }
  try {
    if (signalAborted(signal)) return boundaryFailure(interruptFailure());
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_STATE_BYTES + 1, 0);
    if (bytesRead > MAX_STATE_BYTES) {
      return boundaryFailure(authFailure("state-too-large", "browser state exceeds 8 MiB"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return boundaryFailure(authFailure("state-invalid", "browser state is not valid JSON"));
    }
    const validated = validateBrowserState(parsed);
    if (validated === null) {
      return boundaryFailure(authFailure("state-invalid", "browser state has an invalid shape"));
    }
    return boundarySuccess(validated);
  } catch {
    return boundaryFailure(authFailure("state-read-failed", "cannot read browser state file"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function validateBrowserState(value: unknown): BrowserState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ("cookies" in record) {
    if (!Array.isArray(record.cookies)) return null;
    if (!record.cookies.every(isCookieEntry)) return null;
  }
  if ("origins" in record) {
    if (!Array.isArray(record.origins)) return null;
    if (!record.origins.every(isOriginEntry)) return null;
  }
  return value as BrowserState;
}

function isCookieEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  return "name" in entry && typeof (entry as Record<string, unknown>).name === "string" &&
    "value" in entry && typeof (entry as Record<string, unknown>).value === "string";
}

function isOriginEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  return "origin" in entry && typeof (entry as Record<string, unknown>).origin === "string";
}

/** Creates an isolated context with exact options and optional validated storage state. */
export async function createBrowserContext(
  browser: Browser,
  options: ContextOptions,
  state: BrowserState | null,
): Promise<BoundaryResult<BrowserContext>> {
  try {
    // Stateful and stateless acquisitions share one options object (U3 unified
    // path): device emulation plus presentation flow into a single newContext
    // call; storageState is added only when a validated state was read.
    const contextOptions: BrowserContextOptions = {
      viewport: options.viewport,
      screen: options.screen,
      deviceScaleFactor: options.deviceScaleFactor,
      isMobile: options.isMobile,
      hasTouch: options.hasTouch,
      locale: options.locale,
      timezoneId: options.timezoneId,
      ...(options.userAgent === null ? {} : { userAgent: options.userAgent }),
      ...(state === null
        ? {}
        : {
            // BrowserState was structurally validated on read; adapt to Playwright's storageState shape.
            storageState: state as unknown as NonNullable<BrowserContextOptions["storageState"]>,
          }),
    };
    return boundarySuccess(await browser.newContext(contextOptions));
  } catch {
    return boundaryFailure(
      browserSetupFailure("browser-context-failed", "failed to create an isolated browser context"),
    );
  }
}

/** Creates a fresh page on the context. */
export async function createBrowserPage(context: BrowserContext): Promise<BoundaryResult<Page>> {
  try {
    return boundarySuccess(await context.newPage());
  } catch {
    return boundaryFailure(browserSetupFailure("browser-page-failed", "failed to create a browser page"));
  }
}

/** Navigates to the target URL, requiring a 200..399 main response within the remaining budget. */
export async function navigateToTarget(
  page: Page,
  url: string,
  deadline: Deadline,
  signal: AbortSignal | undefined = undefined,
): Promise<BoundaryResult<void>> {
  if (signalAborted(signal)) return boundaryFailure(interruptFailure());
  const timeout = deadline.remainingMs();
  try {
    const response = await raceAbort(signal, page.goto(url, { waitUntil: "domcontentloaded", timeout }));
    if (response === null) {
      return boundaryFailure(navFailure("navigation-network", "navigation produced no response"));
    }
    const status = response.status();
    if (status < 200 || status > 399) {
      return boundaryFailure(navFailure("navigation-http-status", "main response status is outside the accepted 200..399 range"));
    }
    return boundarySuccess(undefined);
  } catch (error) {
    if (isAbortError(error)) return boundaryFailure(interruptFailure());
    if (isTimeoutError(error)) {
      return boundaryFailure(navFailure("navigation-timeout", "navigation did not complete within the target deadline"));
    }
    return boundaryFailure(navFailure("navigation-network", "navigation failed at the network layer"));
  }
}

/** Best-effort LIFO cleanup used when acquisition fails partway. Swallows errors so the primary acquisition failure stays authoritative. */
async function closeTargetQuiet(page: Page, context: BrowserContext): Promise<void> {
  await page.close().catch(() => undefined);
  await context.close().catch(() => undefined);
}

/**
 * Builds a target scope that closes its page then context idempotently and
 * surfaces a typed `browser-cleanup-failed` (target- and device-attributed) on
 * close error. Exported so the typed-close fault path is directly testable.
 */
export function makeTargetScope(
  page: Page,
  context: BrowserContext,
  targetName: string,
  deviceName: string | null = null,
  closeTimeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS,
): BrowserTargetScope {
  let closed = false;
  return {
    page,
    close: async (): Promise<BoundaryResult<void>> => {
      if (closed) return boundarySuccess(undefined);
      closed = true;
      // Bounded so a never-settling Playwright close returns a typed cleanup
      // failure instead of hanging the CLI.
      const pageClosed = await settleClose(page.close(), closeTimeoutMs);
      const contextClosed = await settleClose(context.close(), closeTimeoutMs);
      if (!pageClosed || !contextClosed) {
        return boundaryFailure(
          cleanupFailure(targetName, deviceName, "failed to close the target page or browser context"),
        );
      }
      return boundarySuccess(undefined);
    },
  };
}

/**
 * Runs the full acquisition: state read, context/page setup, navigation, ready
 * condition, and fonts — each consuming only the remaining budget (KTD7). Any
 * failure closes only the resources this scope already acquired, in reverse
 * order (KTD6), and never touches the shared browser. Failures are stamped with
 * the owning target/case name so identity is never lost.
 */
async function acquireScope(
  browser: Browser,
  request: AcquisitionRequest,
  signal: AbortSignal | undefined,
): Promise<BoundaryResult<BrowserTargetScope>> {
  // KTD7: the monotonic deadline begins immediately before the state read.
  const deadline = createDeadline(request.timeoutMs);
  const options = contextOptionsFor(request);

  let state: BrowserState | null = null;
  if (request.browserState !== null) {
    if (signalAborted(signal)) return boundaryFailure(stampIdentity(request.name, request.deviceName, interruptFailure()));
    const read = await readBrowserState(request.browserState, signal);
    if (!read.ok) return boundaryFailure(stampIdentity(request.name, request.deviceName, read.failure));
    state = read.value;
  }

  if (signalAborted(signal)) return boundaryFailure(stampIdentity(request.name, request.deviceName, interruptFailure()));
  const contextResult = await createBrowserContext(browser, options, state);
  if (!contextResult.ok) return boundaryFailure(stampIdentity(request.name, request.deviceName, contextResult.failure));
  const context = contextResult.value;

  if (signalAborted(signal)) {
    await context.close().catch(() => undefined);
    return boundaryFailure(stampIdentity(request.name, request.deviceName, interruptFailure()));
  }
  const pageResult = await createBrowserPage(context);
  if (!pageResult.ok) {
    await context.close().catch(() => undefined);
    return boundaryFailure(stampIdentity(request.name, request.deviceName, pageResult.failure));
  }
  const page = pageResult.value;

  const nav = await navigateToTarget(page, request.url, deadline, signal);
  if (!nav.ok) {
    await closeTargetQuiet(page, context);
    return boundaryFailure(stampIdentity(request.name, request.deviceName, nav.failure));
  }

  if (request.readyCondition !== null) {
    const ready = await waitForReadyCondition(
      page,
      request.readyCondition.selector,
      request.readyCondition.state,
      deadline,
      signal,
    );
    if (!ready.ok) {
      await closeTargetQuiet(page, context);
      return boundaryFailure(stampIdentity(request.name, request.deviceName, ready.failure));
    }
  }

  const fonts = await waitForFonts(page, deadline, signal);
  if (!fonts.ok) {
    await closeTargetQuiet(page, context);
    return boundaryFailure(stampIdentity(request.name, request.deviceName, fonts.failure));
  }

  return boundarySuccess(makeTargetScope(page, context, request.name, request.deviceName));
}

/** Device-aware acquisition from a resolved audit case (the scheduler's input). */
async function acquireCaseScope(
  browser: Browser,
  auditCase: EffectiveAuditCase,
  signal: AbortSignal | undefined,
): Promise<BoundaryResult<BrowserTargetScope>> {
  return acquireScope(
    browser,
    {
      name: auditCase.name,
      deviceName: auditCase.deviceName,
      url: auditCase.url,
      viewport: auditCase.viewport,
      screen: auditCase.screen,
      deviceScaleFactor: auditCase.deviceScaleFactor,
      isMobile: auditCase.isMobile,
      hasTouch: auditCase.hasTouch,
      userAgent: auditCase.userAgent,
      locale: auditCase.locale,
      timezoneId: auditCase.timezoneId,
      timeoutMs: auditCase.timeoutMs,
      browserState: auditCase.browserState,
      readyCondition: auditCase.readyCondition,
    },
    signal,
  );
}

