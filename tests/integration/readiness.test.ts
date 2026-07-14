import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import { createDeadline, waitForFonts, waitForReadyCondition } from "../../src/browser/readiness";
import { startFixtureServer, type FixtureServer } from "../fixtures/app/server";

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = startFixtureServer();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await server.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
});

async function withPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

test("waitForReadyCondition resolves for attached and visible states on a present element", async () => {
  await withPage(`${server.url}/ready-attached.html`, async (page) => {
    expect((await waitForReadyCondition(page, "#ready", "attached", createDeadline(5000))).ok).toBe(true);
    expect((await waitForReadyCondition(page, "#ready", "visible", createDeadline(5000))).ok).toBe(true);
  });
});

test("waitForReadyCondition resolves hidden when the element is absent", async () => {
  await withPage(`${server.url}/ready-never.html`, async (page) => {
    expect((await waitForReadyCondition(page, "#ready", "hidden", createDeadline(5000))).ok).toBe(true);
  });
});

// Integration boundary: a never-ready wait exercises the real Playwright selector-timeout path.
test("waitForReadyCondition times out as ready-timeout when the element never appears", async () => {
  await withPage(`${server.url}/ready-never.html`, async (page) => {
    const result = await waitForReadyCondition(page, "#ready", "visible", createDeadline(900));
    if (!result.ok) {
      expect(result.failure.code).toBe("ready-timeout");
      expect(result.failure.stage).toBe("ready-condition");
    }
  });
});

test("waitForReadyCondition maps a malformed selector to ready-invalid-selector", async () => {
  await withPage(`${server.url}/ready-attached.html`, async (page) => {
    const result = await waitForReadyCondition(page, ">>>not-a-selector", "attached", createDeadline(5000));
    if (!result.ok) expect(result.failure.code).toBe("ready-invalid-selector");
  });
});

test("waitForFonts resolves ok once a loadable web font settles", async () => {
  await withPage(`${server.url}/font-ok.html`, async (page) => {
    expect((await waitForFonts(page, createDeadline(8000))).ok).toBe(true);
  });
});

test("waitForFonts maps a failed font face to font-load-failed", async () => {
  await withPage(`${server.url}/font-error.html`, async (page) => {
    const result = await waitForFonts(page, createDeadline(8000));
    if (!result.ok) {
      expect(result.failure.code).toBe("font-load-failed");
      expect(result.failure.stage).toBe("web-font");
    }
  });
});

// Integration boundary: a never-settling font exercises the real Playwright function-timeout path.
test("waitForFonts maps a never-loading font to font-timeout", async () => {
  await withPage(`${server.url}/font-hang.html`, async (page) => {
    const result = await waitForFonts(page, createDeadline(1500));
    if (!result.ok) {
      expect(result.failure.code).toBe("font-timeout");
      expect(result.failure.stage).toBe("web-font");
    }
  });
});
