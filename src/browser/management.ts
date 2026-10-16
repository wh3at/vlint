import { platform, arch, release } from "node:os";
import { existsSync } from "node:fs";
import { chromium, firefox, webkit, type Browser } from "playwright";
import coreBundle from "playwright-core/lib/coreBundle";
import { escapeTerminal } from "../output/terminal";

import type { BrowserEngine } from "../contracts/config";

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

export interface EngineReadiness {
  readonly engine: BrowserEngine;
  readonly status: "ready" | "unavailable";
  readonly expectedVersion: string | null;
  readonly obtainedVersion: string | null;
  readonly versionSource: "browser.version" | "playwright-metadata" | null;
  readonly revision: string;
  readonly artifact: { readonly name: string; readonly directory: string; readonly downloadURLs: readonly string[] };
  readonly executablePath: string;
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

export async function prepareManagedBrowsers(force: boolean): Promise<void> {
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  const executables = [managedExecutable("chromium"), managedExecutable("firefox"), managedExecutable("webkit")];
  await registry.installDeps(executables, false);
  await registry.install(executables, { force });
  await registry.validateHostRequirementsForExecutablesIfNeeded(executables, "javascript");
}

export async function inspectManagedBrowsers(signal?: AbortSignal): Promise<{ ready: boolean; host: { platform: string; architecture: string; release: string }; engines: EngineReadiness[] }> {
  const results: EngineReadiness[] = [];
  for (const engine of Object.keys(engines) as BrowserEngine[]) {
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
      await registry.validateHostRequirementsForExecutablesIfNeeded([executable], "javascript");
      dependencyValidation = "passed";
      launch = "failed";
      browser = await engines[engine].launch({ headless: true, timeout: 30_000 });
      launch = "passed";
      obtainedVersion = browser.version();
      emptyPage = "failed";
      const page = await browser.newPage();
      await page.close();
      emptyPage = "passed";
    } catch (error) {
      diagnostic = escapeTerminal(error instanceof Error ? error.message : String(error));
    } finally {
      if (browser !== undefined) {
        close = "failed";
        try {
          await browser.close();
          close = "passed";
        } catch (error) {
          diagnostic = escapeTerminal(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const ready = dependencyValidation === "passed" && launch === "passed" && emptyPage === "passed" && close === "passed";
    results.push({ engine, status: ready ? "ready" : "unavailable", expectedVersion: executable.browserVersion ?? null,
      obtainedVersion, versionSource: obtainedVersion === null ? null : engine === "webkit" ? "playwright-metadata" : "browser.version",
      revision: executable.revision, artifact: { name: executable.name, directory: executable.directory, downloadURLs: executable.downloadURLs },
      executablePath: path, executablePresent: existsSync(path), dependencyValidation, launch, emptyPage, close, diagnostic });
  }
  return { ready: results.every((result) => result.status === "ready"), host: { platform: platform(), architecture: arch(), release: release() }, engines: results };
}
