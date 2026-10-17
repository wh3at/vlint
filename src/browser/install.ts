import { escapeTerminal } from "../output/terminal";
import { inspectManagedBrowsers, managedExecutable, prepareManagedBrowsers } from "./management";
import { readdirSync, readFileSync } from "node:fs";
import coreBundle from "playwright-core/lib/coreBundle";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { interruptFailure, isAbortError, raceAbort, signalAborted } from "./readiness";

const bundle = coreBundle as unknown as { registry: { runOopDownloadBrowserMain(): void } };

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

export interface InstallOptions {
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export const INSTALLER_WORKER_TOKEN = "__vlint_internal_browser_installer_worker__";

const WORKER_GRACE_MS = 3_000;

function browserSetupFailure(code: Failure["code"], message: string): Failure {
  return { stage: "browser-setup", code, message, target: null, device: null, rule: null };
}

export function isInstallerWorkerInvocation(argv: readonly string[]): boolean {
  return argv.length === 4
    && argv[2] === INSTALLER_WORKER_TOKEN
    && (argv[3] === "--force" || argv[3] === "--no-force");
}

export function isOopDownloaderInvocation(firstArg: string | undefined): boolean {
  return firstArg !== undefined && firstArg.endsWith("/oopBrowserDownload.js");
}

export function runOopDownloaderMain(): void {
  bundle.registry.runOopDownloadBrowserMain();
}

export async function runInstallerWorkerMain(argv: readonly string[]): Promise<void> {
  process.on("SIGINT", () => undefined);
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  const force = argv.includes("--force");
  try {
    await prepareManagedBrowsers(force);
    process.exit(0);
  } catch (error) {
    console.error(escapeTerminal(error instanceof Error ? error.message : String(error)));
    process.exit(2);
  }
}

export function findManagedBrowser(): ManagedBrowserInfo {
  const executable = managedExecutable("chromium");
  return {
    name: MANAGED_BROWSER_NAME,
    revision: String(executable.revision),
    browserVersion: String(executable.browserVersion),
    executablePath: executable.executablePath(),
  };
}

async function terminateInstallerTree(pid: number): Promise<void> {
  const snapshot = (child: number) => {
    try {
      const stat = readFileSync(`/proc/${child}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      return { state: fields[0], parent: Number(fields[1]), start: fields[19] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const processes = new Map<number, NonNullable<ReturnType<typeof snapshot>>>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const info = snapshot(Number(entry));
    if (info !== undefined) processes.set(Number(entry), info);
  }
  const owned = new Set([pid]);
  for (const parent of owned) {
    for (const [child, info] of processes) {
      if (info.parent === parent) owned.add(child);
    }
  }
  const alive = (child: number): boolean => {
    const current = snapshot(child);
    return current !== undefined && current.state !== "Z" && current.start === processes.get(child)?.start;
  };
  const signalOwned = (sig: "SIGTERM" | "SIGKILL"): void => {
    for (const child of [...owned].reverse()) {
      if (!alive(child)) continue;
      try { process.kill(child, sig); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(`Browser preparation cleanup could not send ${sig} to process ${child}: ${escapeTerminal(String(error))}`);
        }
      }
    }
  };
  signalOwned("SIGTERM");
  const deadline = Date.now() + WORKER_GRACE_MS;
  while ([...owned].some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if ([...owned].some(alive)) signalOwned("SIGKILL");
}

type InstallActionOutcome = { readonly aborted: boolean; readonly success: boolean };

async function runInstallAction(options: InstallOptions): Promise<InstallActionOutcome> {
  const proc = Bun.spawn({
    cmd: [process.execPath, INSTALLER_WORKER_TOKEN, options.force ? "--force" : "--no-force"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: false,
  });
  const pid = proc.pid;
  try {
    const code = await raceAbort(options.signal, proc.exited);
    return { aborted: false, success: code === 0 };
  } catch (error) {
    if (isAbortError(error)) {
      await terminateInstallerTree(pid);
      await proc.exited;
      return { aborted: true, success: false };
    }
    throw error;
  }
}

export async function installBrowser(options: InstallOptions): Promise<BoundaryResult<InstallOutcome>> {
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());
  const before = await inspectManagedBrowsers(options.signal);
  if (signalAborted(options.signal)) return boundaryFailure(interruptFailure());
  const outcome = await runInstallAction(options);
  if (outcome.aborted) return boundaryFailure(interruptFailure());
  if (!outcome.success) {
    return boundaryFailure(browserSetupFailure("browser-install-failed", "Browser and OS dependency preparation failed; run 'vlint browser install' in a terminal with Playwright's required permissions"));
  }
  const after = await inspectManagedBrowsers(options.signal);
  if (!after.ready) {
    return boundaryFailure(browserSetupFailure("browser-install-failed", "Browser preparation completed but launch verification failed; run 'vlint browser status'"));
  }
  return boundarySuccess({
    kind: options.force ? "repaired" : before.ready ? "already-present" : "installed",
    browser: findManagedBrowser(),
  });
}
