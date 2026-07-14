import { chromium, type Browser } from "playwright";
import coreBundle from "playwright-core/lib/coreBundle";

interface RegistryExecutable {
  executablePathOrDie(language: string): string;
}

interface Registry {
  findExecutable(name: string): RegistryExecutable;
  install(executables: readonly RegistryExecutable[], options?: { force?: boolean }): Promise<void>;
}

interface RegistryBundle {
  registry: Registry;
  installBrowsersForNpmInstall(browserNames: readonly string[]): Promise<boolean | void>;
  runOopDownloadBrowserMain(): void;
}

interface CoreBundle {
  registry: RegistryBundle;
}

type ProbeFailureCode =
  | "browser-cache-override-unsupported"
  | "browser-download-host-override-unsupported"
  | "browser-install-failed"
  | "browser-launch-failed"
  | "invalid-arguments"
  | "signal-interrupt";

interface ProbeSuccess {
  readonly ok: true;
  readonly action: "install" | "check";
  readonly revision: string;
  readonly value?: string;
}

interface ProbeFailure {
  readonly ok: false;
  readonly code: ProbeFailureCode;
  readonly message: string;
}

const bundle = coreBundle as unknown as CoreBundle;
const browserName = "chromium-headless-shell";
let activeBrowser: Browser | undefined;
let interrupted = false;

function emit(value: ProbeSuccess | ProbeFailure): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code: ProbeFailureCode, message: string): never {
  emit({ ok: false, code, message });
  process.exit(2);
}

function rejectAmbientOverrides(action: "install" | "check"): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    fail("browser-cache-override-unsupported", "PLAYWRIGHT_BROWSERS_PATH is not supported");
  }
  if (
    action === "install" &&
    (process.env.PLAYWRIGHT_DOWNLOAD_HOST !== undefined ||
      process.env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST !== undefined)
  ) {
    fail(
      "browser-download-host-override-unsupported",
      "Playwright download host overrides are not supported",
    );
  }
}

async function closeBrowser(): Promise<void> {
  const browser = activeBrowser;
  activeBrowser = undefined;
  if (browser !== undefined) await browser.close().catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void closeBrowser().finally(() => fail("signal-interrupt", `Interrupted by ${signal}`));
  });
}

async function install(force: boolean): Promise<void> {
  rejectAmbientOverrides("install");
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  try {
    const registry = bundle.registry.registry;
    if (force) {
      const executable = registry.findExecutable(browserName);
      await registry.install([executable], { force: true });
    } else {
      await bundle.registry.installBrowsersForNpmInstall([browserName]);
    }
    const executable = registry.findExecutable(browserName);
    executable.executablePathOrDie("javascript");
    emit({ ok: true, action: "install", revision: "1228" });
  } catch {
    fail("browser-install-failed", "Playwright Chromium installation failed");
  }
}

async function check(url: string): Promise<void> {
  rejectAmbientOverrides("check");
  try {
    activeBrowser = await chromium.launch({ headless: true });
    const page = await activeBrowser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const value = await page.locator("#probe").textContent();
    await closeBrowser();
    emit({ ok: true, action: "check", revision: "1228", value: value ?? "" });
  } catch {
    await closeBrowser();
    fail("browser-launch-failed", "Playwright Chromium launch or navigation failed");
  }
}

const [action, ...args] = process.argv.slice(2);
if (action?.endsWith("/oopBrowserDownload.js") === true) {
  bundle.registry.runOopDownloadBrowserMain();
} else if (action === "install") {
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length > 0) fail("invalid-arguments", `Unknown argument: ${unknown[0]}`);
  await install(args.includes("--force"));
} else if (action === "check") {
  const url = args[0];
  if (url === undefined || args.length !== 1) fail("invalid-arguments", "Usage: check <url>");
  await check(url);
} else {
  fail("invalid-arguments", "Usage: <install [--force] | check <url>>");
}
