import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowserRunScope, type BrowserRunScope } from "../../src/browser/lifecycle";
import { findManagedBrowser } from "../../src/browser/install";
import { allowedArrival, measureRule } from "../../src/browser/measurement";
import { boundarySuccess } from "../../src/contracts/failure";
import type { EffectiveAuditCase, EffectiveRule } from "../../src/contracts/config";
import { runResolvedCheck, exitCodeForResult } from "../../src/run/orchestrator";
import { evaluateTabLabelSingleLine } from "../../src/rules/tab-label-single-line";
import { evaluatePageHorizontalOverflow } from "../../src/rules/page-horizontal-overflow";
import { evaluateLocalRule } from "../../src/plugins/evaluate";
import { loadPluginContract } from "../../src/plugins/load";
import { startFixtureServer, type FixtureServer } from "../fixtures/app/server";

let server: FixtureServer;
let browser: BrowserRunScope;

const rule: EffectiveRule = { name: "coverage", type: "page-horizontal-overflow", enabled: true, tolerancePx: 1 };

function auditCase(url: string, options: { allowedUrls?: readonly string[]; ready?: string; minimum?: number } = {}): EffectiveAuditCase {
  return {
    name: "page", url, ...(options.allowedUrls === undefined ? {} : { allowedUrls: options.allowedUrls }),
    deviceName: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 },
    deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: null,
    locale: "en-US", timezoneId: "UTC", timeoutMs: 5000, browserState: null,
    readyCondition: options.ready === undefined ? null : { selector: options.ready, state: "visible" },
    rules: [{ ...rule, ...(options.minimum === undefined ? {} : { minimumInspected: options.minimum }) }],
  };
}

beforeAll(async () => {
  server = startFixtureServer();
  const version = findManagedBrowser().browserVersion;
  const launched = await createBrowserRunScope({ versionProbe: () => ({ exitCode: 0, timedOut: false, stdout: `Google Chrome for Testing ${version}` }) });
  if (!launched.ok) throw new Error(launched.failure.code);
  browser = launched.value;
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

test("HTTP redirect requires an exact allowed URL and records the arrival", async () => {
  const url = `${server.url}/redirect?to=%2F`;
  const denied = await browser.acquireCase(auditCase(url));
  expect(denied.ok).toBe(false);
  if (!denied.ok) {
    expect(denied.failure.code).toBe("url-mismatch");
    expect(denied.failure.actualUrl).toBe(`${server.url}/`);
  }
  const allowed = await browser.acquireCase(auditCase(url, { allowedUrls: [`${server.url}/`] }));
  expect(allowed.ok).toBe(true);
  if (allowed.ok) {
    expect(allowed.value.page.url()).toBe(`${server.url}/`);
    await allowed.value.close();
  }
});

test("URL and ready state are checked inside asynchronous browser evaluation", async () => {
  const url = `${server.url}/`;
  const audit = auditCase(url, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const page = opened.value.page;
  const changed = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      doc.querySelector("#ready").remove();
      await new Promise((resolve) => setTimeout(resolve, 20));
      doc.body.insertAdjacentHTML("beforeend", "<main id='ready'>restored</main>");
      return 1;
    });
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(changed.failure?.code).toBe("ready-lost");
  const moved = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(async () => {
      (globalThis as any).history.pushState({}, "", "/other?token=abc#part");
      await new Promise((resolve) => setTimeout(resolve, 20));
      (globalThis as any).history.replaceState({}, "", "/");
    });
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(moved.failure?.code).toBe("url-mismatch");
  expect(moved.failure?.actualUrl).toContain("/other?token=abc#part");
  await opened.value.close();
});

test("live browser counts below a per-case minimum produce incomplete exit 2", async () => {
  const audit = { ...auditCase(`${server.url}/`), rules: [{ name: "tabs", type: "tab-label-single-line" as const, enabled: true, additionalCandidateSelectors: [], excludeSelectors: [], labelSelector: null, minimumInspected: 2 }] };
  const result = await runResolvedCheck(
    { targets: [{ ...audit, viewport: audit.viewport, deviceScaleFactor: 1 }], cases: [audit], rules: audit.rules },
    {
      launch: async () => boundarySuccess({
        browserVersion: browser.browserVersion,
        openCase: async (item) => {
          const opened = await browser.acquireCase(item);
          if (!opened.ok) return opened;
          return boundarySuccess({ ...opened.value, actualUrl: opened.value.page.url() });
        },
        close: async () => boundarySuccess(undefined),
      }),
      evaluate: async (page) => measureRule(page, audit, page.url(), (guarded) => evaluateTabLabelSingleLine(guarded, audit.rules[0]!, audit.name)),
    },
    { toolVersion: "test" },
  );
  expect(exitCodeForResult(result)).toBe(2);
  expect(result.cases[0]?.rules[0]?.failure?.code).toBe("minimum-inspected-unmet");
  expect(result.cases[0]?.actualUrl).toBe(`${server.url}/`);
});

test("built-in and local evaluators use the guarded browser boundary", async () => {
  const audit = auditCase(`${server.url}/tabs.html`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const builtin = await measureRule(opened.value.page, audit, opened.value.page.url(), (guarded) => evaluatePageHorizontalOverflow(guarded, rule, audit.name));
  expect(builtin.failure).toBeNull();
  await opened.value.close();
  const localCase = auditCase(`${server.url}/spacing-clean.html`);
  const local = await browser.acquireCase(localCase);
  if (!local.ok) throw new Error(local.failure.code);
  const contract = await loadPluginContract({ configDirectory: `${import.meta.dir}/../fixtures/plugins`, relativePath: "duplicate-spacing-rule.ts", ruleName: "duplicate-spacing" });
  if (!contract.ok) throw new Error(contract.failure.code);
  const localRule = { name: "duplicate-spacing", type: "local" as const, enabled: true, path: "duplicate-spacing-rule.ts", settings: { shellSelector: "#app-shell", contentSelector: "#content" } };
  const measured = await measureRule(local.value.page, localCase, local.value.page.url(), (guarded) => evaluateLocalRule(guarded, localRule, contract.value, localCase));
  expect(measured.failure).toBeNull();
  expect(measured.facts.elementsInspected).toBe(2);
  await local.value.close();
});

test("origin, path, query, and hash are exact after standard URL normalization", () => {
  const audit = auditCase("https://example.com:443/a/../page?x=1#top");
  expect(allowedArrival(audit, "https://EXAMPLE.com/page?x=1#top")).toBe(true);
  for (const url of ["http://example.com/page?x=1#top", "https://example.com/other?x=1#top", "https://example.com/page?x=2#top", "https://example.com/page?x=1#other"]) {
    expect(allowedArrival(audit, url)).toBe(false);
  }
});

test("a second allowed URL, or a missing ready selector between rules, fails on the next measurement", async () => {
  const url = `${server.url}/`;
  const audit = auditCase(url, { ready: "#ready", allowedUrls: [`${server.url}/tabs.html`] });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const first = await measureRule(page, audit, url, async (guarded) => ({ facts: { elementsInspected: await guarded.evaluate(() => 0), violations: [] }, failure: null }));
  expect(first.failure).toBeNull();
  await page.goto(`${server.url}/tabs.html`);
  const second = await measureRule(page, audit, url, async () => ({ facts: { elementsInspected: 0, violations: [] }, failure: null }));
  expect(second.failure?.code).toBe("url-mismatch");
  await page.goto(url);
  await page.evaluate(() => (globalThis as any).document.querySelector("#ready").remove());
  const third = await measureRule(page, audit, url, async () => ({ facts: { elementsInspected: 0, violations: [] }, failure: null }));
  expect(third.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a loading page without its ready condition stays incomplete with its observed URL", async () => {
  const url = `${server.url}/slow?delay=50`;
  const audit = { ...auditCase(url, { ready: "#never" }), timeoutMs: 200 };
  const opened = await browser.acquireCase(audit);
  expect(opened.ok).toBe(false);
  if (!opened.ok) {
    expect(opened.failure.code).toBe("ready-timeout");
    expect(opened.failure.actualUrl).toBe(url);
  }
});

test("HTTP errors retain the observed browser URL", async () => {
  const url = `${server.url}/status?code=500`;
  const opened = await browser.acquireCase(auditCase(url));
  expect(opened.ok).toBe(false);
  if (!opened.ok) {
    expect(opened.failure.code).toBe("navigation-http-status");
    expect(opened.failure.actualUrl).toBe(url);
  }
});

test("built-in measurement works when page CSP forbids eval", async () => {
  const audit = auditCase(`${server.url}/csp`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, (guarded) => evaluatePageHorizontalOverflow(guarded, rule, audit.name));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("main-frame navigation during an async evaluation fails instead of escaping as a clean result", async () => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => {
    await guarded.evaluate(async () => {
      (globalThis as any).location.href = "/tabs.html";
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(outcome.failure?.code).toBe("url-mismatch");
  expect(outcome.failure?.actualUrl).toBe(`${server.url}/tabs.html`);
  await opened.value.close();
});

test.each([
  ["/", "text=public content"],
  ["/shadow-ready", "#ready"],
])("a ready selector in %s retains Playwright semantics at measurement", async (path, ready) => {
  const audit = auditCase(`${server.url}${path}`, { ready });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("display:contents remains visible by Playwright's ready semantics", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.evaluate(() => {
    const main = (globalThis as any).document.querySelector("#ready");
    main.style.display = "contents";
    main.innerHTML = "<span>public content</span>";
  });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("a newly matching hidden ready selector is rejected during evaluation", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#new", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const main = (globalThis as any).document.querySelector("main");
      main.id = "new";
      main.id = "ready";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("shadow-host visibility loss cannot be hidden by same-task restoration", async () => {
  const audit = auditCase(`${server.url}/shadow-ready`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const host = (globalThis as any).document.querySelector("#host");
      host.style.display = "none";
      host.style.display = "block";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("synchronous removal and restoration of ready does not erase the loss", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const ready = doc.querySelector("#ready");
      ready.remove();
      doc.body.append(ready);
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test.each([
  ["#ready", "id", "other"],
  ["text=public content", "textContent", "other"],
])("ready %s cannot be dropped by changing %s during an async rule", async (selector, property, replacement) => {
  const audit = auditCase(`${server.url}/`, { ready: selector });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async ({ property, replacement }) => {
      const element = (globalThis as any).document.querySelector("main");
      const original = element[property];
      element[property] = replacement;
      await new Promise((resolve) => setTimeout(resolve, 20));
      element[property] = original;
      return 1;
    }, { property, replacement }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});
