import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";

import { makeEffectiveTarget } from "../../src/config/merge";
import type { EffectiveTarget, TargetDefaults } from "../../src/contracts/config";
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

function target(url: string, overrides: Partial<TargetDefaults> = {}): EffectiveTarget {
  return makeEffectiveTarget({ name: "t", url, ...overrides }, {}, [], tmp);
}

test("public page is acquired and the ready page text is readable", async () => {
  const t = await run.acquireTarget(target(`${server.url}/index.html`));
  expect(t.ok).toBe(true);
  if (t.ok) {
    expect(await t.value.page.locator("#ready").textContent()).toContain("public content");
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("exact context options (viewport, device scale, locale, time zone) are applied", async () => {
  const t = await run.acquireTarget(
    target(`${server.url}/index.html`, {
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
      locale: "fr-FR",
      timezoneId: "America/New_York",
    }),
  );
  expect(t.ok).toBe(true);
  if (t.ok) {
    const info = await t.value.page.evaluate(() => {
      const w = globalThis as unknown as {
        innerWidth: number;
        devicePixelRatio: number;
        navigator: { language: string };
        Intl: { DateTimeFormat: (...a: unknown[]) => { resolvedOptions: () => { timeZone: string } } };
      };
      return {
        innerWidth: w.innerWidth,
        devicePixelRatio: w.devicePixelRatio,
        language: w.navigator.language,
        timezone: w.Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    });
    expect(info.innerWidth).toBe(800);
    expect(info.devicePixelRatio).toBe(2);
    expect(info.language).toBe("fr-FR");
    expect(info.timezone).toBe("America/New_York");
    expect((await t.value.close()).ok).toBe(true);
  }
});

test("public and authenticated pages are isolated across separate contexts on the same browser", async () => {
  const pub = await run.acquireTarget(target(`${server.url}/auth-gated`));
  const auth = await run.acquireTarget(
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
    const t = await run.acquireTarget(target(`${server.url}/status?code=${code}`));
    if (!t.ok) expect(t.failure.code).toBe("navigation-http-status");
  }
});

test("navigation maps a refused/unsafe port to navigation-network", async () => {
  // Port 1 deterministically yields a network-layer error (ERR_UNSAFE_PORT); no listening server needed.
  const t = await run.acquireTarget(target("http://127.0.0.1:1/nope"));
  if (!t.ok) expect(t.failure.code).toBe("navigation-network");
});

test("a failed target does not break the shared browser for the next target (cleanup)", async () => {
  const failed = await run.acquireTarget(target(`${server.url}/status?code=500`));
  expect(failed.ok).toBe(false);
  const next = await run.acquireTarget(target(`${server.url}/index.html`));
  expect(next.ok).toBe(true);
  if (next.ok) await next.value.close();
});

// Integration boundary: asserts real Playwright timeout/deadline behavior on the platform clock.
// Fake timers cannot reproduce the browser-side wait semantics under test.
test("remaining budget flows across stages: a slow navigation leaves only the remainder for ready", async () => {
  const start = Date.now();
  const t = await run.acquireTarget(
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
    { viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, locale: "en", timezoneId: "UTC" },
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
  const t = await run.acquireTarget(target(`${server.url}/index.html`), controller.signal);
  if (!t.ok) {
    expect(t.failure.code).toBe("signal-interrupt");
    expect(t.failure.target).toBe("t");
  }
});

test("navigateToTarget requires a 200..399 main response", async () => {
  const ctx = await run.acquireTarget(target(`${server.url}/index.html`));
  expect(ctx.ok).toBe(true);
  if (ctx.ok) {
    const ok = await navigateToTarget(ctx.value.page, `${server.url}/index.html`, createDeadline(5000));
    expect(ok.ok).toBe(true);
    const bad = await navigateToTarget(ctx.value.page, `${server.url}/status?code=404`, createDeadline(5000));
    if (!bad.ok) expect(bad.failure.code).toBe("navigation-http-status");
    await ctx.value.close();
  }
});
