import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";

import { buildStandardConfig } from "../../src/commands/init";
import type { DeviceProfile, EffectiveAuditCase, ReadyCondition, Viewport } from "../../src/contracts/config";
import {
  createBrowserContext,
  createBrowserPage,
  createBrowserRunScope,
  makeTargetScope,
  navigateToTarget,
  readBrowserState,
  type BrowserRunScope,
} from "../../src/browser/lifecycle";
import { findManagedBrowser, type VersionProbe } from "../../src/browser/install";
import { createDeadline } from "../../src/browser/readiness";
import { startFixtureServer, type FixtureServer } from "../fixtures/app/server";

const STATE_FIXTURES = join(import.meta.dir, "../fixtures/app/state");

let server: FixtureServer;
let run: BrowserRunScope;
let tmp: string;

// The dev cache (revision 1228 -> stale 1223 binary) fails the real version
// probe, so lifecycle tests inject a probe that matches the registry metadata
// to exercise launch/context/navigation/readiness independent of that check.
function matchingProbe(): VersionProbe {
  const version = findManagedBrowser().browserVersion;
  return () => ({ exitCode: 0, timedOut: false, stdout: `Google Chrome for Testing ${version}` });
}

beforeAll(async () => {
  server = startFixtureServer();
  const scope = await createBrowserRunScope({ versionProbe: matchingProbe() });
  if (!scope.ok) throw new Error(`browser launch failed in beforeAll: ${scope.failure.code}`);
  run = scope.value;
  tmp = await mkdtemp(join(tmpdir(), "vlint-state-"));
});

afterAll(async () => {
  await run.close().catch(() => undefined);
  server.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

interface TargetOverrides {
  viewport?: Viewport;
  deviceScaleFactor?: number;
  locale?: string;
  timezoneId?: string;
  timeoutMs?: number;
  browserState?: string;
  readyCondition?: ReadyCondition;
}

function target(url: string, overrides: TargetOverrides = {}): EffectiveAuditCase {
  const viewport = overrides.viewport ?? { width: 1280, height: 720 };
  const device: DeviceProfile = {
    name: "test-device",
    viewport,
    screen: viewport,
    deviceScaleFactor: overrides.deviceScaleFactor ?? 1,
    isMobile: false,
    hasTouch: false,
  };
  return auditCase(device, url, {
    name: "t",
    ...(overrides.locale !== undefined ? { locale: overrides.locale } : {}),
    ...(overrides.timezoneId !== undefined ? { timezoneId: overrides.timezoneId } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.browserState !== undefined ? { browserState: overrides.browserState } : {}),
    ...(overrides.readyCondition !== undefined ? { readyCondition: overrides.readyCondition } : {}),
  });
}

// Canonical standard devices, sourced from the same authority as `vlint init`
// so the observed emulation matches the generated config byte-for-byte.
const standardConfig = buildStandardConfig();
if (!standardConfig.ok) {
  throw new Error(`standard device config unavailable: ${standardConfig.failure.code}`);
}
const MACBOOK = standardConfig.value.devices.find((d) => d.name === "macbook-air-13-m5");
const IPHONE = standardConfig.value.devices.find((d) => d.name === "iphone-17");
if (MACBOOK === undefined || IPHONE === undefined) {
  throw new Error("standard device config is missing macbook-air-13-m5 or iphone-17");
}

interface CaseOverrides {
  name?: string;
  locale?: string;
  timezoneId?: string;
  timeoutMs?: number;
  browserState?: string;
  readyCondition?: ReadyCondition;
}

function auditCase(device: DeviceProfile, url: string, overrides: CaseOverrides = {}): EffectiveAuditCase {
  return {
    name: overrides.name ?? device.name,
    url,
    deviceName: device.name,
    viewport: device.viewport,
    screen: device.screen,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: device.userAgent ?? null,
    locale: overrides.locale ?? "en-US",
    timezoneId: overrides.timezoneId ?? "UTC",
    timeoutMs: overrides.timeoutMs ?? 30_000,
    browserState: overrides.browserState ?? null,
    readyCondition:
      overrides.readyCondition === undefined
        ? null
        : { selector: overrides.readyCondition.selector, state: overrides.readyCondition.state ?? "visible" },
    rules: [],
  };
}

interface DeviceObservation {
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  language: string;
  userAgent: string;
  touch: boolean;
  timezone: string;
}

// page.evaluate runs in the browser; Node's TS lib omits these DOM globals, so
// the surface is narrowed once here (named const) instead of via inline casts.
async function observeDevice(page: Page): Promise<DeviceObservation> {
  return page.evaluate(() => {
    const dom = globalThis as unknown as {
      devicePixelRatio: number;
      screen: { width: number; height: number };
      navigator: { language: string; userAgent: string; maxTouchPoints: number };
      Intl: { DateTimeFormat: (...a: unknown[]) => { resolvedOptions: () => { timeZone: string } } };
    };
    return {
      devicePixelRatio: dom.devicePixelRatio,
      screenWidth: dom.screen.width,
      screenHeight: dom.screen.height,
      language: dom.navigator.language,
      userAgent: dom.navigator.userAgent,
      touch: dom.navigator.maxTouchPoints > 0,
      timezone: dom.Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}

// Under mobile emulation a desktop document reports the 980px default layout
// viewport, not the configured one. A width=device-width document surfaces the
// configured viewport as the layout viewport for both mobile and desktop contexts.
async function probeViewport(page: Page): Promise<{ width: number; height: number }> {
  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
  );
  return page.evaluate(() => {
    const dom = globalThis as unknown as {
      document: { documentElement: { clientWidth: number; clientHeight: number } };
    };
    const root = dom.document.documentElement;
    return { width: root.clientWidth, height: root.clientHeight };
  });
}

test("public page is acquired and the ready page text is readable", async () => {
  const t = await run.acquireCase(target(`${server.url}/index.html`));
  expect(t.ok).toBe(true);
  if (t.ok) {
    expect(await t.value.page.locator("#ready").textContent()).toContain("public content");
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("exact context options (viewport, screen, device scale, mobile, touch, user agent, locale, time zone) are applied", async () => {
  const device: DeviceProfile = {
    name: "custom",
    viewport: { width: 800, height: 600 },
    screen: { width: 900, height: 700 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (TestPhone)",
  };
  const t = await run.acquireCase(
    auditCase(device, `${server.url}/index.html`, { locale: "fr-FR", timezoneId: "America/New_York" }),
  );
  expect(t.ok).toBe(true);
  if (t.ok) {
    const vp = await probeViewport(t.value.page);
    expect(vp.width).toBe(800);
    expect(vp.height).toBe(600);
    const info = await observeDevice(t.value.page);
    expect(info.devicePixelRatio).toBe(2);
    expect(info.screenWidth).toBe(900);
    expect(info.screenHeight).toBe(700);
    expect(info.touch).toBe(true);
    expect(info.userAgent).toBe("Mozilla/5.0 (TestPhone)");
    expect(info.language).toBe("fr-FR");
    expect(info.timezone).toBe("America/New_York");
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("public and authenticated pages are isolated across separate contexts on the same browser", async () => {
  const pub = await run.acquireCase(target(`${server.url}/auth-gated`));
  const auth = await run.acquireCase(
    target(`${server.url}/auth-gated`, { browserState: join(STATE_FIXTURES, "valid.json") }),
  );
  expect(pub.ok && auth.ok).toBe(true);
  if (pub.ok && auth.ok) {
    expect(await pub.value.page.locator("#principal").textContent()).toBe("ANONYMOUS");
    expect(await auth.value.page.locator("#principal").textContent()).toBe("AUTHENTICATED");
    // The authenticated context's cookie must not leak into the public context.
    expect(await pub.value.page.locator("#principal").textContent()).toBe("ANONYMOUS");
    await auth.value.close();
    await pub.value.close();
  }
});

test("MacBook Air 13\" applies desktop viewport 1470x956, screen 1470x956, DPR 2, no touch, and the default Chromium user agent", async () => {
  const t = await run.acquireCase(auditCase(MACBOOK, `${server.url}/index.html`));
  expect(t.ok).toBe(true);
  if (t.ok) {
    const vp = await probeViewport(t.value.page);
    expect(vp.width).toBe(1470);
    expect(vp.height).toBe(956);
    const info = await observeDevice(t.value.page);
    expect(info.devicePixelRatio).toBe(2);
    expect(info.screenWidth).toBe(1470);
    expect(info.screenHeight).toBe(956);
    expect(info.touch).toBe(false);
    expect(info.userAgent).toContain("Chrome");
    expect(info.userAgent).not.toContain("iPhone");
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("iPhone 17 applies viewport 402x681, screen 402x874, DPR 3, mobile, touch, and the iPhone user agent", async () => {
  // Canonical values fixed by the Product Contract (R4) and pinned at init time.
  expect(IPHONE.viewport).toEqual({ width: 402, height: 681 });
  expect(IPHONE.screen).toEqual({ width: 402, height: 874 });
  expect(IPHONE.deviceScaleFactor).toBe(3);
  expect(IPHONE.isMobile).toBe(true);
  expect(IPHONE.hasTouch).toBe(true);
  const iphoneUa = IPHONE.userAgent;
  if (typeof iphoneUa !== "string") throw new Error("iPhone 17 descriptor has no user agent");
  expect(iphoneUa).toMatch(/iPhone/);

  const t = await run.acquireCase(auditCase(IPHONE, `${server.url}/index.html`));
  expect(t.ok).toBe(true);
  if (t.ok) {
    const vp = await probeViewport(t.value.page);
    expect(vp.width).toBe(402);
    expect(vp.height).toBe(681);
    const info = await observeDevice(t.value.page);
    expect(info.devicePixelRatio).toBe(3);
    expect(info.screenWidth).toBe(402);
    expect(info.screenHeight).toBe(874);
    expect(info.touch).toBe(true);
    expect(info.userAgent).toBe(iphoneUa);
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("stateful and stateless acquisitions apply the same device options", async () => {
  const plain = await run.acquireCase(auditCase(IPHONE, `${server.url}/index.html`));
  const authed = await run.acquireCase(
    auditCase(IPHONE, `${server.url}/index.html`, { browserState: join(STATE_FIXTURES, "valid.json") }),
  );
  expect(plain.ok && authed.ok).toBe(true);
  if (plain.ok && authed.ok) {
    // Device emulation is identical regardless of the state path taken.
    const a = await observeDevice(plain.value.page);
    const b = await observeDevice(authed.value.page);
    expect(b).toEqual(a);
    // The authenticated context carried the session cookie; the plain one did not.
    const authedCookies = await authed.value.page.context().cookies();
    const plainCookies = await plain.value.page.context().cookies();
    expect(authedCookies.some((c) => c.name === "session" && c.value === "authenticated")).toBe(true);
    expect(plainCookies.some((c) => c.name === "session")).toBe(false);
    await authed.value.close();
    await plain.value.close();
  }
});

test("two device contexts coexist on the shared browser without sharing cookies or emulation", async () => {
  const mac = await run.acquireCase(auditCase(MACBOOK, `${server.url}/auth-gated`));
  const phone = await run.acquireCase(
    auditCase(IPHONE, `${server.url}/auth-gated`, { browserState: join(STATE_FIXTURES, "valid.json") }),
  );
  expect(mac.ok && phone.ok).toBe(true);
  if (mac.ok && phone.ok) {
    // Both contexts are alive simultaneously on the shared browser, fully isolated.
    expect(await mac.value.page.locator("#principal").textContent()).toBe("ANONYMOUS");
    expect(await phone.value.page.locator("#principal").textContent()).toBe("AUTHENTICATED");
    const macVp = await probeViewport(mac.value.page);
    const phoneVp = await probeViewport(phone.value.page);
    expect(macVp.width).toBe(1470);
    expect(phoneVp.width).toBe(402);
    const macInfo = await observeDevice(mac.value.page);
    const phoneInfo = await observeDevice(phone.value.page);
    expect(macInfo.userAgent).not.toBe(phoneInfo.userAgent);
    await phone.value.close();
    await mac.value.close();
  }
});

test("acquireCase failures keep the case and device identity and do not break the shared browser", async () => {
  const nav = await run.acquireCase(
    auditCase(IPHONE, `${server.url}/status?code=500`, { name: "broken-case" }),
  );
  expect(nav.ok).toBe(false);
  if (!nav.ok) {
    expect(nav.failure.code).toBe("navigation-http-status");
    expect(nav.failure.target).toBe("broken-case");
    expect(nav.failure.device).toBe(IPHONE.name);
  }
  // A close failure surfaces both target and device identity via makeTargetScope.
  const throwingPage = { close: async () => {
    throw new Error("page close boom");
  } } as unknown as Page;
  const throwingContext = { close: async () => {
    throw new Error("context close boom");
  } } as unknown as BrowserContext;
  const scope = makeTargetScope(throwingPage, throwingContext, "t", "iphone-17");
  const closeFail = await scope.close();
  expect(closeFail.ok).toBe(false);
  if (!closeFail.ok) {
    expect(closeFail.failure.code).toBe("browser-cleanup-failed");
    expect(closeFail.failure.target).toBe("t");
    expect(closeFail.failure.device).toBe("iphone-17");
  }
  const next = await run.acquireCase(auditCase(MACBOOK, `${server.url}/index.html`));
  expect(next.ok).toBe(true);
  if (next.ok) await next.value.close();
});

test("readBrowserState classifies missing, truncated, invalid-shape, empty, too-large, FIFO, symlink and read-error", async () => {
  expect(!((await readBrowserState(join(tmp, "nope.json"))).ok)).toBe(true);
  const missing = await readBrowserState(join(tmp, "nope.json"));
  if (!missing.ok) expect(missing.failure.code).toBe("state-missing");

  const truncated = await readBrowserState(join(STATE_FIXTURES, "truncated.json"));
  if (!truncated.ok) expect(truncated.failure.code).toBe("state-invalid");

  const invalidShape = await readBrowserState(join(STATE_FIXTURES, "invalid-shape.json"));
  if (!invalidShape.ok) expect(invalidShape.failure.code).toBe("state-invalid");

  expect((await readBrowserState(join(STATE_FIXTURES, "empty.json"))).ok).toBe(true);

  const tooLargePath = join(tmp, "too-large.json");
  await writeFile(tooLargePath, "0".repeat(8 * 1024 * 1024 + 1));
  const tooLarge = await readBrowserState(tooLargePath);
  if (!tooLarge.ok) expect(tooLarge.failure.code).toBe("state-too-large");

  const fifoPath = join(tmp, "fifo");
  spawnSync("mkfifo", [fifoPath]);
  const fifo = await readBrowserState(fifoPath);
  if (!fifo.ok) expect(fifo.failure.code).toBe("state-not-regular");

  const linkValid = join(tmp, "link-valid.json");
  await symlink(join(STATE_FIXTURES, "valid.json"), linkValid);
  expect((await readBrowserState(linkValid)).ok).toBe(true);

  const linkDangling = join(tmp, "link-dangling.json");
  await symlink(join(tmp, "does-not-exist.json"), linkDangling);
  const dangling = await readBrowserState(linkDangling);
  if (!dangling.ok) expect(dangling.failure.code).toBe("state-missing");

  const unreadable = join(tmp, "unreadable.json");
  await writeFile(unreadable, '{"cookies":[]}');
  await chmod(unreadable, 0o000);
  const readFailed = await readBrowserState(unreadable);
  await chmod(unreadable, 0o600);
  if (!readFailed.ok) expect(readFailed.failure.code).toBe("state-read-failed");
});

test("state failures never leak parsed credential sentinels into the failure message", async () => {
  const truncated = await readBrowserState(join(STATE_FIXTURES, "truncated.json"));
  if (!truncated.ok) {
    expect(truncated.failure.message).not.toContain("SECRET");
    expect(truncated.failure.message).not.toContain("session");
  }
});

test("navigation maps HTTP 404 and 500 to navigation-http-status", async () => {
  for (const code of [404, 500]) {
    const t = await run.acquireCase(target(`${server.url}/status?code=${code}`));
    if (!t.ok) expect(t.failure.code).toBe("navigation-http-status");
  }
});

test("navigation maps a refused/unsafe port to navigation-network", async () => {
  // Port 1 deterministically yields a network-layer error (ERR_UNSAFE_PORT); no listening server needed.
  const t = await run.acquireCase(target("http://127.0.0.1:1/nope"));
  if (!t.ok) expect(t.failure.code).toBe("navigation-network");
});

test("a failed target does not break the shared browser for the next target (cleanup)", async () => {
  const failed = await run.acquireCase(target(`${server.url}/status?code=500`));
  expect(failed.ok).toBe(false);
  const next = await run.acquireCase(target(`${server.url}/index.html`));
  expect(next.ok).toBe(true);
  if (next.ok) await next.value.close();
});

// Integration boundary: asserts real Playwright timeout/deadline behavior on the platform clock.
// Fake timers cannot reproduce the browser-side wait semantics under test.
test("remaining budget flows across stages: a slow navigation leaves only the remainder for ready", async () => {
  const start = Date.now();
  const t = await run.acquireCase(
    target(`${server.url}/slow?delay=900`, {
      timeoutMs: 1500,
      readyCondition: { selector: "#ready", state: "visible" },
    }),
  );
  const elapsed = Date.now() - start;
  if (!t.ok) expect(t.failure.code).toBe("ready-timeout");
  // Navigation consumed ~900ms; ready got only the remainder (~600ms), so total stays near the
  // 1500ms deadline rather than receiving a fresh full timeout (~2400ms).
  expect(elapsed).toBeGreaterThanOrEqual(1300);
  expect(elapsed).toBeLessThan(2200);
});

test("createDeadline exposes a monotonic remaining budget", () => {
  const deadline = createDeadline(100);
  expect(deadline.totalMs).toBe(100);
  expect(deadline.remainingMs()).toBeLessThanOrEqual(100);
  expect(deadline.remainingMs()).toBeGreaterThanOrEqual(95);
  expect(deadline.elapsedMs()).toBeLessThanOrEqual(6);
});

test("a throwing launch maps to browser-launch-failed", async () => {
  const scope = await createBrowserRunScope({
    versionProbe: matchingProbe(),
    launch: async () => {
      throw new Error("launch boom");
    },
  });
  if (!scope.ok) expect(scope.failure.code).toBe("browser-launch-failed");
});

test("a throwing context creation maps to browser-context-failed", async () => {
  const fakeBrowser = {
    newContext: async () => {
      throw new Error("ctx boom");
    },
  } as unknown as Browser;
  const r = await createBrowserContext(
    fakeBrowser,
    {
      viewport: { width: 1, height: 1 },
      screen: { width: 1, height: 1 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      userAgent: null,
      locale: "en",
      timezoneId: "UTC",
    },
    null,
  );
  if (!r.ok) expect(r.failure.code).toBe("browser-context-failed");
});

test("a throwing page creation maps to browser-page-failed", async () => {
  const fakeContext = {
    newPage: async () => {
      throw new Error("page boom");
    },
  } as unknown as BrowserContext;
  const r = await createBrowserPage(fakeContext);
  if (!r.ok) expect(r.failure.code).toBe("browser-page-failed");
});

test("target scope close surfaces a target-attributed cleanup failure and is idempotent", async () => {
  const throwingPage = { close: async () => {
    throw new Error("page close boom");
  } } as unknown as Page;
  const throwingContext = { close: async () => {
    throw new Error("context close boom");
  } } as unknown as BrowserContext;
  const scope = makeTargetScope(throwingPage, throwingContext, "my-target");
  const first = await scope.close();
  if (!first.ok) {
    expect(first.failure.code).toBe("browser-cleanup-failed");
    expect(first.failure.target).toBe("my-target");
  }
  expect((await scope.close()).ok).toBe(true);
});

test("run scope close surfaces a target-null cleanup failure and is idempotent", async () => {
  const throwingBrowser = {
    version: () => "1.0.0",
    close: async () => {
      throw new Error("browser close boom");
    },
  } as unknown as Browser;
  const scope = await createBrowserRunScope({ versionProbe: matchingProbe(), launch: async () => throwingBrowser });
  expect(scope.ok).toBe(true);
  if (scope.ok) {
    const first = await scope.value.close();
    if (!first.ok) {
      expect(first.failure.code).toBe("browser-cleanup-failed");
      expect(first.failure.target).toBe(null);
    }
    expect((await scope.value.close()).ok).toBe(true);
  }
});

test("an aborted run-scope signal before launch returns signal-interrupt", async () => {
  const controller = new AbortController();
  controller.abort();
  const scope = await createBrowserRunScope({ versionProbe: matchingProbe(), signal: controller.signal });
  if (!scope.ok) expect(scope.failure.code).toBe("signal-interrupt");
});

test("an aborted run-scope signal during launch returns signal-interrupt and reaps the late browser", async () => {
  const { promise: launchPromise, resolve: resolveLaunch } = Promise.withResolvers<Browser>();
  let reaped = false;
  const lateBrowser = {
    version: () => "1.0.0",
    close: async () => {
      reaped = true;
    },
  } as unknown as Browser;
  const controller = new AbortController();
  const scopePromise = createBrowserRunScope({ versionProbe: matchingProbe(), signal: controller.signal, launch: () => launchPromise });
  controller.abort();
  const scope = await scopePromise;
  if (!scope.ok) expect(scope.failure.code).toBe("signal-interrupt");
  resolveLaunch(lateBrowser);
  // Flush microtasks so the late-settling launch's reap callback runs (no real timer).
  await launchPromise;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(reaped).toBe(true);
});

test("an aborted target-scope signal before acquisition returns a target-attributed interrupt", async () => {
  const controller = new AbortController();
  controller.abort();
  const t = await run.acquireCase(target(`${server.url}/index.html`), controller.signal);
  if (!t.ok) {
    expect(t.failure.code).toBe("signal-interrupt");
    expect(t.failure.target).toBe("t");
  }
});

test("navigateToTarget requires a 200..399 main response", async () => {
  const ctx = await run.acquireCase(target(`${server.url}/index.html`));
  expect(ctx.ok).toBe(true);
  if (ctx.ok) {
    const ok = await navigateToTarget(ctx.value.page, `${server.url}/index.html`, createDeadline(5000));
    expect(ok.ok).toBe(true);
    const bad = await navigateToTarget(ctx.value.page, `${server.url}/status?code=404`, createDeadline(5000));
    if (!bad.ok) expect(bad.failure.code).toBe("navigation-http-status");
    await ctx.value.close();
  }
});
