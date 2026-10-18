import { platform, arch, release } from "node:os";
import { existsSync } from "node:fs";
import { chromium, firefox, webkit, type Browser } from "playwright";
import coreBundle from "playwright-core/lib/coreBundle";
import { escapeTerminal } from "../output/terminal";

import type { BrowserEngine } from "../contracts/config";
import type { EngineExecution } from "../contracts/result";

interface Executable {
  readonly name: string;
  readonly revision: string;
  readonly browserVersion?: string;
  readonly directory: string;
  readonly downloadURLs: readonly string[];
  executablePath(): string;
}

interface Registry {
  findExecutable(name: string): Executable;
  installDeps(executables: readonly Executable[], dryRun: boolean): Promise<void>;
  install(executables: readonly Executable[], options: { force: boolean }): Promise<void>;
  validateHostRequirementsForExecutablesIfNeeded(executables: readonly Executable[], language: string): Promise<void>;
}

const registry = (coreBundle as unknown as { registry: { registry: Registry } }).registry.registry;
const engines = { chromium, firefox, webkit };

export interface EngineReadiness extends EngineExecution {
  readonly status: "ready" | "unavailable";
  readonly executablePresent: boolean;
  readonly dependencyValidation: "passed" | "failed" | "not-run";
  readonly launch: "passed" | "failed" | "not-run";
  readonly emptyPage: "passed" | "failed" | "not-run";
  readonly close: "passed" | "failed" | "not-run";
  readonly diagnostic: string | null;
}

export function managedExecutable(engine: BrowserEngine): Executable {
  return registry.findExecutable(engine === "chromium" ? "chromium-headless-shell" : engine);
}

export function managedEngineExecution(engine: BrowserEngine, obtainedVersion: string | null = null): EngineExecution {
  const executable = managedExecutable(engine);
  return {
    engine,
    expectedVersion: executable.browserVersion ?? null,
    obtainedVersion,
    versionSource: obtainedVersion === null ? null : engine === "webkit" ? "playwright-metadata" : "browser.version",
    revision: executable.revision,
    artifact: { name: executable.name, directory: executable.directory, downloadURLs: executable.downloadURLs },
    executablePath: executable.executablePath(),
    diagnostic: null,
  };
}

export async function prepareManagedBrowsers(force: boolean): Promise<void> {
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  const executables = [managedExecutable("chromium"), managedExecutable("firefox"), managedExecutable("webkit")];
  await registry.installDeps(executables, false);
  await registry.install(executables, { force });
  await registry.validateHostRequirementsForExecutablesIfNeeded(executables, "javascript");
}

function withCancellation<T>(operation: Promise<T>, signal?: AbortSignal, onLateResult?: (value: T) => Promise<void>): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      if (cancelled) {
        void onLateResult?.(value).catch(() => {});
      } else {
        resolve(value);
      }
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export async function inspectManagedBrowsers(signal?: AbortSignal): Promise<{ ready: boolean; host: { platform: string; architecture: string; release: string }; engines: EngineReadiness[] }> {
  const results: EngineReadiness[] = [];
  for (const engine of Object.keys(engines) as BrowserEngine[]) {
    signal?.throwIfAborted();
    const executable = managedExecutable(engine);
    const path = executable.executablePath();
    let browser: Browser | undefined;
    let obtainedVersion: string | null = null;
    let dependencyValidation: EngineReadiness["dependencyValidation"] = "not-run";
    let launch: EngineReadiness["launch"] = "not-run";
    let emptyPage: EngineReadiness["emptyPage"] = "not-run";
    let close: EngineReadiness["close"] = "not-run";
    let diagnostic: string | null = null;
    try {
      signal?.throwIfAborted();
      dependencyValidation = "failed";
      await withCancellation(registry.validateHostRequirementsForExecutablesIfNeeded([executable], "javascript"), signal);
      dependencyValidation = "passed";
      launch = "failed";
      browser = await withCancellation(engines[engine].launch({ headless: true, timeout: 30_000 }), signal, (lateBrowser) => lateBrowser.close());
      launch = "passed";
      obtainedVersion = browser.version();
      if (executable.browserVersion !== undefined && obtainedVersion !== executable.browserVersion) {
        throw new Error(`managed browser version does not match expected version: expected ${executable.browserVersion}, obtained ${obtainedVersion}`);
      }
      emptyPage = "failed";
      const page = await withCancellation(browser.newPage(), signal);
      await withCancellation(page.close(), signal);
      emptyPage = "passed";
    } catch (error) {
      signal?.throwIfAborted();
      diagnostic = escapeTerminal(error instanceof Error ? error.message : String(error));
    } finally {
      if (browser !== undefined) {
        close = "failed";
        try {
          await withCancellation(browser.close(), signal);
          close = "passed";
        } catch (error) {
          signal?.throwIfAborted();
          diagnostic = escapeTerminal(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const ready = dependencyValidation === "passed" && launch === "passed" && emptyPage === "passed" && close === "passed";
    results.push({ ...managedEngineExecution(engine, obtainedVersion), status: ready ? "ready" : "unavailable",
      executablePresent: existsSync(path), dependencyValidation, launch, emptyPage, close, diagnostic });
  }
  return { ready: results.every((result) => result.status === "ready"), host: { platform: platform(), architecture: arch(), release: release() }, engines: results };
}
