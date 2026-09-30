import { chromium, type Browser } from "playwright";
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
let nativeBrowser: Browser;
let pages: PageServer;
let sameUrlDocumentRequests = 0;

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

interface PageServer {
  readonly url: string;
  close(): Promise<void>;
}

const PAGE_DOCUMENTS: Record<string, string> = {
  "/hover-noise.html": "<!doctype html><html><head><style>button:hover{color:red}</style></head><body><main data-ready>Ready</main><span id='noise'>Other content</span></body></html>",
  "/inputs.html": "<!doctype html><html><body><input id=\"save\" type=\"submit\" value=\"Save\"></body></html>",
  "/text-in-noncontent.html": "<!doctype html><html><head><title>public content</title><style>body{--message:'public content'}</style><script>void 'public content'</script><noscript>public content</noscript></head><body><main id='ready'>public content</main></body></html>",
  "/text-mutation.html": "<!doctype html><html><body><main id='ready'>ready</main><aside id='other'>clock</aside></body></html>",
  "/text-ancestor.html": "<!doctype html><html><body><main id='ready'><span>hello </span><span>ready</span></main><aside>clock</aside></body></html>",
  "/multi-ready.html": "<!doctype html><html><body><main class=\"ready\">one</main><main class=\"ready\">two</main></body></html>",
  "/attribute-ready.html": "<!doctype html><html><body><main id=\"ready\" data-ready>public content</main></body></html>",
  "/visibility.html": "<!doctype html><html><head><style>.hiding{display:none}</style></head><body><main id=\"ready\">public content</main></body></html>",
  "/hidden-override.html": "<!doctype html><html><head><style>[hidden]{display:block !important}</style></head><body><main id=\"ready\">public content</main></body></html>",
  "/xpath-sibling.html": "<!doctype html><html><body><aside id=\"enabled\">gate</aside><main id=\"ready\">public content</main></body></html>",
  "/xpath-child.html": "<!doctype html><html><body><main id=\"ready\">public content<aside id=\"enabled\">gate</aside></main></body></html>",
  "/same-url-history.html": "<!doctype html><html><body><main id='ready' hidden>ready</main><script>window.initialDocument = document; setTimeout(() => history.replaceState({}, '', location.href), 30); setTimeout(() => document.querySelector('#ready').hidden = false, 160)</script></body></html>",
};

function startPageServer(): PageServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/same-url-history.html") sameUrlDocumentRequests++;
      if (path === "/redirect-back") return Response.redirect(new URL("/undeclared", request.url), 302);
      if (path === "/undeclared") return new Response(
        "<!doctype html><html><head><script>history.replaceState({}, '', '/redirect-back' + location.hash)</script></head><body>destination</body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
      const document = PAGE_DOCUMENTS[path];
      if (document === undefined) return new Response("not found", { status: 404 });
      return new Response(document, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("page server did not bind a port");
  return { url: `http://${server.hostname}:${port}`, close: () => server.stop(true) };
}

beforeAll(async () => {
  server = startFixtureServer();
  pages = startPageServer();
  const version = findManagedBrowser().browserVersion;
  const launched = await createBrowserRunScope({
    versionProbe: () => ({ exitCode: 0, timedOut: false, stdout: `Google Chrome for Testing ${version}` }),
    launch: async () => {
      nativeBrowser = await chromium.launch({ headless: true, executablePath: findManagedBrowser().executablePath });
      return nativeBrowser;
    },
  });
  if (!launched.ok) throw new Error(launched.failure.code);
  browser = launched.value;
});

afterAll(async () => {
  await browser.close();
  await pages.close();
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
  const fragmentUrl = `${server.url}/redirect?to=${encodeURIComponent("/#frag")}`;
  const fragmentDenied = await browser.acquireCase(auditCase(fragmentUrl));
  expect(fragmentDenied.ok).toBe(false);
  if (!fragmentDenied.ok) {
    expect(fragmentDenied.failure.code).toBe("url-mismatch");
    expect(fragmentDenied.failure.actualUrl).toBe(`${server.url}/#frag`);
  }
  const fragmentAllowed = await browser.acquireCase(auditCase(fragmentUrl, { allowedUrls: [`${server.url}/#frag`] }));
  expect(fragmentAllowed.ok).toBe(true);
  if (fragmentAllowed.ok) {
    expect(fragmentAllowed.value.page.url()).toBe(`${server.url}/#frag`);
    await fragmentAllowed.value.close();
  }
});

test("a redirect to an undeclared document cannot hide behind pre-DOMContentLoaded replaceState", async () => {
  const url = `${pages.url}/redirect-back#anchor`;
  const destination = `${pages.url}/undeclared#anchor`;
  const denied = await browser.acquireCase(auditCase(url));
  expect(denied.ok).toBe(false);
  if (!denied.ok) {
    expect(denied.failure.code).toBe("url-mismatch");
    expect(denied.failure.actualUrl).toBe(destination);
  }
  const wrongHash = await browser.acquireCase(auditCase(url, { allowedUrls: [`${pages.url}/undeclared#other`] }));
  expect(wrongHash.ok).toBe(false);
  if (!wrongHash.ok) {
    expect(wrongHash.failure.code).toBe("url-mismatch");
    expect(wrongHash.failure.actualUrl).toBe(destination);
  }
  const allowed = await browser.acquireCase(auditCase(url, { allowedUrls: [destination] }));
  expect(allowed.ok).toBe(true);
  if (allowed.ok) {
    expect(allowed.value.page.url()).toBe(url);
    await allowed.value.close();
  }
});

test("same-URL history replacement during ready wait does not lose the target page", async () => {
  const url = `${pages.url}/same-url-history.html`;
  const before = sameUrlDocumentRequests;
  const opened = await browser.acquireCase(auditCase(url, { ready: "#ready" }));
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect(opened.value.actualUrl).toBe(url);
  expect(await opened.value.page.evaluate(() => (globalThis as any).initialDocument === document)).toBe(true);
  expect(sameUrlDocumentRequests - before).toBe(1);
  await opened.value.close();
});

test("restored ready state and URL changes inside asynchronous evaluation are allowed", async () => {
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
  expect(changed.failure).toBeNull();
  const moved = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(async () => {
      (globalThis as any).history.pushState({}, "", "/other?token=abc#part");
      await new Promise((resolve) => setTimeout(resolve, 20));
      (globalThis as any).history.replaceState({}, "", "/");
    });
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(moved.failure).toBeNull();
  await opened.value.close();
});

test("same-URL history replacement during a rule does not lose the target page", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => { (globalThis as any).originalDocument = document; });
  let documentResponses = 0;
  page.on("response", (response) => { if (response.request().resourceType() === "document") documentResponses++; });
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => { history.replaceState({}, "", location.href); return 1; }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(1);
  expect(page.url()).toBe(audit.url);
  expect(await page.evaluate(() => (globalThis as any).originalDocument === document)).toBe(true);
  expect(documentResponses).toBe(0);
  await opened.value.close();
});

test("same-URL document reload is allowed when the final boundary is ready", async () => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (page) => {
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(1);
  await opened.value.close();
});

test("ready state restored between browser evaluations is allowed", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(() => {
      const ready = (globalThis as any).document.querySelector("#ready");
      setTimeout(() => {
        ready.remove();
        setTimeout(() => (globalThis as any).document.body.append(ready), 0);
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null };
  });
  expect(outcome.failure).toBeNull();
  const next = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(next.failure).toBeNull();
  await opened.value.close();
});

test("temporary history changes restored before the final boundary are allowed", async () => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(() => {
      setTimeout(() => {
        (globalThis as any).history.pushState({}, "", "/other");
        setTimeout(() => (globalThis as any).history.replaceState({}, "", "/"), 0);
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null };
  });
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test.each(["pushState", "replaceState"] as const)("measurement preserves an app-installed %s wrapper", async (method) => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const global = globalThis as any;
    global.originalHistoryMethods = { pushState: history.pushState, replaceState: history.replaceState };
  });
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate((method) => {
      const global = globalThis as any;
      const previous = history[method];
      const appWrapper = function (this: History, ...args: Parameters<History[typeof method]>) {
        global.appHistoryCalls = (global.appHistoryCalls ?? 0) + 1;
        return previous.apply(this, args);
      };
      history[method] = appWrapper;
      global.appHistoryWrapper = appWrapper;
      return 1;
    }, method), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(await page.evaluate((method) => {
    const global = globalThis as any;
    return {
      wrapperSurvived: history[method] === global.appHistoryWrapper,
      otherRestored: history[method === "pushState" ? "replaceState" : "pushState"] === global.originalHistoryMethods[method === "pushState" ? "replaceState" : "pushState"],
      guardReleased: (globalThis as any)[Symbol.for("vlint.ruleGuard")] === undefined,
    };
  }, method)).toEqual({ wrapperSurvived: true, otherRestored: true, guardReleased: true });
  const moved = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate((method) => {
      history[method]({}, "", "/other");
      history[method]({}, "", "/");
      return 1;
    }, method), violations: [] }, failure: null,
  }));
  expect(moved.failure).toBeNull();
  expect(await page.evaluate(() => (globalThis as any).appHistoryCalls)).toBe(2);
  await opened.value.close();
});

test("an application-owned window.__vlintRuleGuard value survives measurement", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const global = globalThis as any;
    global.appRuleGuardCalls = 0;
    global.appRuleGuard = {
      evaluate: () => { global.appRuleGuardCalls += 1; return null; },
      finish: () => { global.appRuleGuardCalls += 1; return null; },
    };
    global.__vlintRuleGuard = global.appRuleGuard;
  });
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(1);
  expect(await page.evaluate(() => {
    const global = globalThis as any;
    return {
      survives: global.__vlintRuleGuard === global.appRuleGuard,
      appRuleGuardCalls: global.appRuleGuardCalls,
    };
  })).toEqual({ survives: true, appRuleGuardCalls: 0 });
  await opened.value.close();
});

test("an application replacement of window.__vlintRuleGuard during measurement is preserved", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => {
    await guarded.evaluate(() => {
      const global = globalThis as any;
      global.appReplacement = { owner: "application" };
      global.__vlintRuleGuard = global.appReplacement;
      return 1;
    });
    return { facts: { elementsInspected: await guarded.evaluate(() => 2), violations: [] }, failure: null };
  });
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(2);
  expect(await page.evaluate(() => (globalThis as any).__vlintRuleGuard === (globalThis as any).appReplacement)).toBe(true);
  await opened.value.close();
});

test("measurement does not create window.__vlintRuleGuard when the application owns none", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(globalThis, "__vlintRuleGuard"))).toBe(false);
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(1);
  expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(globalThis, "__vlintRuleGuard"))).toBe(false);
  await opened.value.close();
});

test("application-owned rule guard slots survive repeated measurement", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const global = globalThis as any;
    global.appRuleGuardCalls = 0;
    global.appRuleGuard = {
      evaluate: () => { global.appRuleGuardCalls += 1; return null; },
      finish: () => { global.appRuleGuardCalls += 1; return null; },
    };
    global.__vlintRuleGuard = global.appRuleGuard;
    global[Symbol.for("vlint.ruleGuard")] = global.appRuleGuard;
  });
  const appOwnedSlots = () => page.evaluate(() => {
    const global = globalThis as any;
    return {
      windowSlot: global.__vlintRuleGuard === global.appRuleGuard,
      symbolSlot: global[Symbol.for("vlint.ruleGuard")] === global.appRuleGuard,
      appRuleGuardCalls: global.appRuleGuardCalls,
    };
  });
  const measure = () => measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  const first = await measure();
  expect(first.failure).toBeNull();
  expect(first.facts.elementsInspected).toBe(1);
  expect(await appOwnedSlots()).toEqual({ windowSlot: true, symbolSlot: true, appRuleGuardCalls: 0 });
  const globalsAfterFirst = await page.evaluate(() => Object.getOwnPropertyNames(globalThis).sort());
  const second = await measure();
  expect(second.failure).toBeNull();
  expect(second.facts.elementsInspected).toBe(1);
  expect(await appOwnedSlots()).toEqual({ windowSlot: true, symbolSlot: true, appRuleGuardCalls: 0 });
  expect(await page.evaluate(() => Object.getOwnPropertyNames(globalThis).sort())).toEqual(globalsAfterFirst);
  await opened.value.close();
});

test("an evaluator error is rethrown when the final boundary is satisfied", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => { (globalThis as any).originalPushState = (globalThis as any).history.pushState; });
  await expect(measureRule(page, audit, page.url(), async () => {
    throw new Error("evaluation failed");
  })).rejects.toThrow("evaluation failed");
  expect(await page.evaluate(() => (globalThis as any).history.pushState === (globalThis as any).originalPushState)).toBe(true);
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

test("an interrupt after browser arrival reports the observed URL and one run-level signal", async () => {
  const { promise: arrived, resolve: resolveArrived } = Promise.withResolvers<void>();
  const arrivalServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/arrived") {
        resolveArrived();
        return new Response("ok");
      }
      return new Response(
        "<!doctype html><html><body><p>no ready element</p><script>addEventListener('load', () => fetch('/arrived'))</script></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const arrivalPort = arrivalServer.port;
  if (arrivalPort === undefined) throw new Error("arrival fixture server did not bind a port");
  const url = `http://127.0.0.1:${arrivalPort}/never-ready`;
  const audit = { ...auditCase(url, { ready: "#never" }), timeoutMs: 10_000 };
  const controller = new AbortController();
  try {
    const runP = runResolvedCheck(
      { targets: [audit], cases: [audit], rules: audit.rules },
      {
        launch: async () => boundarySuccess({
          browserVersion: browser.browserVersion,
          openCase: async (item, signal) => browser.acquireCase(item, signal),
          close: async () => boundarySuccess(undefined),
        }),
        evaluate: async (page) => measureRule(page, audit, page.url(), (guarded) => evaluatePageHorizontalOverflow(guarded, rule, audit.name)),
      },
      { toolVersion: "test", signal: controller.signal },
    );
    await arrived;
    const deadline = Date.now() + 2000;
    while (!nativeBrowser.contexts().some((context) => context.pages().some((page) => page.url() === url))) {
      if (Date.now() >= deadline) throw new Error("Playwright did not observe the target page");
      await Bun.sleep(5);
    }
    controller.abort();
    const result = await runP;
    expect(result.cases[0]?.actualUrl).toBe(url);
    expect(result.cases[0]?.status).toBe("failed");
    expect(result.cases[0]?.failures).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("signal-interrupt");
    expect(exitCodeForResult(result)).toBe(2);
  } finally {
    controller.abort();
    await arrivalServer.stop(true);
  }
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

test("a cross-URL navigation while the ready wait is pending fails with url-mismatch before the deadline", async () => {
  const url = `${server.url}/navigate-away.html?to=%2Ftabs.html`;
  const audit = { ...auditCase(url, { ready: "#never" }), timeoutMs: 10_000 };
  const start = Date.now();
  const opened = await browser.acquireCase(audit);
  const elapsed = Date.now() - start;
  expect(opened.ok).toBe(false);
  if (!opened.ok) {
    expect(opened.failure.code).toBe("url-mismatch");
    expect(opened.failure.actualUrl).toBe(`${server.url}/tabs.html`);
    expect(opened.failure.target).toBe("page");
    expect(opened.failure.device).toBe("desktop");
  }
  expect(elapsed).toBeLessThan(5000);
  const next = await browser.acquireCase(auditCase(`${server.url}/index.html`));
  expect(next.ok).toBe(true);
  if (next.ok) await next.value.close();
});

test("a same-URL navigation while the ready wait is pending fails with navigation-during-measurement before the deadline", async () => {
  const url = `${server.url}/navigate-away.html`;
  const audit = { ...auditCase(url, { ready: "#never" }), timeoutMs: 10_000 };
  const start = Date.now();
  const opened = await browser.acquireCase(audit);
  const elapsed = Date.now() - start;
  expect(opened.ok).toBe(false);
  if (!opened.ok) {
    expect(opened.failure.code).toBe("navigation-during-measurement");
    expect(opened.failure.actualUrl).toBe(url);
  }
  expect(elapsed).toBeLessThan(5000);
});

test("a navigation while the font wait is pending fails before the deadline", async () => {
  const url = `${server.url}/navigate-during-fonts.html`;
  const audit = { ...auditCase(url, { ready: "#ready" }), timeoutMs: 10_000 };
  const start = Date.now();
  const opened = await browser.acquireCase(audit);
  const elapsed = Date.now() - start;
  expect(opened.ok).toBe(false);
  if (!opened.ok) {
    expect(opened.failure.code).toBe("navigation-during-measurement");
    expect(opened.failure.actualUrl).toBe(url);
  }
  expect(elapsed).toBeLessThan(5000);
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
  if (outcome.failure === null) throw new Error("navigation was not detected");
  expect(["url-mismatch", "navigation-during-measurement"]).toContain(outcome.failure.code);
  expect(outcome.failure.actualUrl).toBe(outcome.failure.code === "url-mismatch" ? `${server.url}/tabs.html` : audit.url);
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

test("shadow-piercing CSS readiness does not accept a descendant moved under a different host", async () => {
  const audit = auditCase(`${server.url}/shadow-ready`, { ready: "#host #ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const other = doc.createElement("div");
      doc.body.append(other);
      other.attachShadow({ mode: "open" }).append(doc.querySelector("#host").shadowRoot.querySelector("#ready"));
    });
    expect(await page.locator("#ready").count()).toBe(1);
    expect(await page.locator("#host #ready").count()).toBe(0);
    let evaluated = false;
    const outcome = await measureRule(page, audit, page.url(), async () => {
      evaluated = true;
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(evaluated).toBe(false);
    expect(outcome.failure?.code).toBe("ready-lost");
  } finally {
    await opened.value.close();
  }
});

test.each(["#host #ready", "css=#host #ready", "#host > #ready", "#host:has(#ready)"])(
  "shadow-piercing CSS readiness %s survives steady measurement and unrelated mutations",
  async (selector) => {
    for (const state of ["visible", "attached"] as const) {
      const audit = { ...auditCase(`${server.url}/shadow-ready`), readyCondition: { selector, state } };
      const opened = await browser.acquireCase(audit);
      if (!opened.ok) throw new Error(opened.failure.code);
      try {
        const page = opened.value.page;
        const steady = await measureRule(page, audit, page.url(), async (guarded) => ({
          facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
        }));
        expect(steady.failure).toBeNull();
        expect(steady.facts.elementsInspected).toBe(1);
        const changing = await measureRule(page, audit, page.url(), async (guarded) => ({
          facts: { elementsInspected: await guarded.evaluate(async () => {
            const doc = (globalThis as any).document;
            const footer = doc.createElement("footer");
            doc.body.append(footer);
            footer.textContent = "tick";
            await new Promise((resolve) => setTimeout(resolve, 0));
            footer.remove();
            return 1;
          }), violations: [] }, failure: null,
        }));
        expect(changing.failure).toBeNull();
        expect(changing.facts.elementsInspected).toBe(1);
      } finally {
        await opened.value.close();
      }
    }
  },
);

test("an unrelated open-shadow custom element does not fail a visible ready condition", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async () => {
        const global = globalThis as any;
        global.customElements.define("shadow-widget", class extends global.HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "open" }).innerHTML = "<span>widget</span>";
          }
        });
        const widget = global.document.createElement("shadow-widget");
        global.document.body.append(widget);
        await new Promise((resolve) => setTimeout(resolve, 10));
        widget.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(await page.locator("#ready").isVisible()).toBe(true);
    expect(await page.locator("shadow-widget").count()).toBe(0);
  } finally {
    await opened.value.close();
  }
});

test("unrelated attributes with hover CSS preserve ready state at measurement boundaries", async () => {
  const audit = auditCase(`${pages.url}/hover-noise.html`, { ready: "[data-ready]" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (page) => {
      await page.evaluate(() => { document.querySelector("#noise")!.setAttribute("data-noise", "changed"); });
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
  } finally {
    await opened.value.close();
  }
});

test.each(["#ready", "css=#ready", "body > #ready", "main:has-text('public content')", "text=public content", 'text="public content"', "text=/public content/", "role=main", "xpath=//main[@id='ready']", "main >> text=public content"])(
  "ready selector %s is checked at both boundaries, not between browser evaluations",
  async (selector) => {
    const audit = auditCase(`${server.url}/role-ready.html`, { ready: selector });
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    try {
      const page = opened.value.page;
      const restored = await measureRule(page, audit, page.url(), async (page) => {
        await page.locator("#ready").evaluate((element) => { element.remove(); document.body.append(element); });
        await page.locator("#ready").evaluate((element) => { (element as HTMLElement).hidden = true; });
        expect(await page.evaluate(() => document.querySelector<HTMLElement>("#ready")!.hidden)).toBe(true);
        await page.locator("#ready").evaluate((element) => { (element as HTMLElement).hidden = false; });
        return { facts: { elementsInspected: 1, violations: [] }, failure: null };
      });
      expect(restored.failure).toBeNull();
      expect(restored.facts.elementsInspected).toBe(1);
      const missing = await measureRule(page, audit, page.url(), async (page) => {
        await page.locator("#ready").evaluate((element) => element.remove());
        return { facts: { elementsInspected: 1, violations: [] }, failure: null };
      });
      expect(missing.failure?.code).toBe("ready-lost");
      expect(missing.facts).toEqual({ elementsInspected: 0, violations: [] });
      let evaluated = false;
      const start = await measureRule(page, audit, page.url(), async () => {
        evaluated = true;
        return { facts: { elementsInspected: 1, violations: [] }, failure: null };
      });
      expect(start.failure?.code).toBe("ready-lost");
      expect(evaluated).toBe(false);
    } finally {
      await opened.value.close();
    }
  },
);

test.each(["visible", "attached", "hidden"] as const)("%s readiness uses the final matching set", async (state) => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/multi-ready.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    if (state === "hidden") await page.locator(".ready").evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).hidden = true;
    });
    const audit = { ...auditCase(page.url()), readyCondition: { selector: ".ready", state } };
    const restored = await measureRule(page, audit, page.url(), async (page) => {
      await page.evaluate((state) => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(".ready"));
        for (const element of elements) element.hidden = state !== "hidden";
        for (const element of elements) element.hidden = state === "hidden";
        elements[0]!.replaceWith(elements[0]!.cloneNode(true));
      }, state);
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(restored.failure).toBeNull();
    const lost = await measureRule(page, audit, page.url(), async (page) => {
      await page.locator(".ready").evaluateAll((elements, state) => {
        for (const element of elements) {
          if (state === "attached") element.remove();
          else (element as HTMLElement).hidden = state === "visible";
        }
      }, state);
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(lost.failure?.code).toBe("ready-lost");
    expect(lost.facts.elementsInspected).toBe(0);
  } finally {
    await opened.value.close();
  }
});

test.each(["visible", "attached", "hidden"] as const)("shadow ready %s conditions are checked against live content at the end", async (state) => {
  const opened = await browser.acquireCase(auditCase(`${server.url}/shadow-ready`));
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    if (state === "hidden") await page.locator("#host #ready").evaluate((element) => { (element as HTMLElement).hidden = true; });
    const audit = { ...auditCase(page.url()), readyCondition: { selector: "#host #ready", state } };
    const outcome = await measureRule(page, audit, page.url(), async (page) => {
      await page.locator("#host #ready").evaluate((element) => {
        const parent = element.parentNode!;
        element.remove();
        parent.appendChild(element);
      });
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(outcome.failure).toBeNull();
    const lost = await measureRule(page, audit, page.url(), async (page) => {
      await page.locator("#host #ready").evaluate((element, state) => {
        if (state === "hidden") (element as HTMLElement).hidden = false;
        else element.remove();
      }, state);
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(lost.failure?.code).toBe("ready-lost");
  } finally {
    await opened.value.close();
  }
});

test.each(["transient", "start", "finish"] as const)("selector-free font readiness is checked at boundaries: %s", async (phase) => {
  const audit = auditCase(`${pages.url}/text-mutation.html`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    if (phase === "start") await page.evaluate(() => Object.defineProperty(document.fonts, "status", { configurable: true, value: "loading" }));
    let evaluated = false;
    const outcome = await measureRule(page, audit, page.url(), async (page) => {
      evaluated = true;
      await page.evaluate(() => {
        Object.defineProperty(document.fonts, "status", { configurable: true, value: "loading" });
        document.fonts.dispatchEvent(new Event("loading"));
      });
      expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
      if (phase === "transient") await page.evaluate(() => Object.defineProperty(document.fonts, "status", { configurable: true, value: "loaded" }));
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(evaluated).toBe(phase !== "start");
    expect(outcome.failure?.code ?? null).toBe(phase === "transient" ? null : "ready-lost");
    expect(outcome.facts.elementsInspected).toBe(phase === "transient" ? 1 : 0);
  } finally {
    await opened.value.close();
  }
});

test.each(["transient", "persistent"] as const)("stylesheet visibility is decided at the final boundary: %s", async (lifetime) => {
  const audit = auditCase(`${pages.url}/visibility.html`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, page.url(), async (page) => {
      await page.locator("#ready").evaluate((element) => element.classList.add("hiding"));
      expect(await page.locator("#ready").isVisible()).toBe(false);
      if (lifetime === "transient") await page.locator("#ready").evaluate((element) => element.classList.remove("hiding"));
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(outcome.failure?.code ?? null).toBe(lifetime === "transient" ? null : "ready-lost");
  } finally {
    await opened.value.close();
  }
});

test.each(["start", "finish"] as const)("a URL mismatch at the %s boundary discards rule facts", async (phase) => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    if (phase === "start") await page.evaluate(() => history.pushState({}, "", "/other?token=abc#part"));
    let evaluated = false;
    const outcome = await measureRule(page, audit, audit.url, async (page) => {
      evaluated = true;
      await page.evaluate(() => history.pushState({}, "", "/other?token=abc#part"));
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(evaluated).toBe(phase === "finish");
    expect(outcome.failure?.code).toBe("url-mismatch");
    expect(outcome.failure?.actualUrl).toBe(`${server.url}/other?token=abc#part`);
    expect(outcome.facts).toEqual({ elementsInspected: 0, violations: [] });
  } finally {
    await opened.value.close();
  }
});

test("an evaluator error does not conceal a failing final boundary", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const outcome = await measureRule(opened.value.page, audit, audit.url, async (page) => {
      await page.locator("#ready").evaluate((element) => element.remove());
      throw new Error("evaluation failed");
    });
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally {
    await opened.value.close();
  }
});

test.each([
  ["/inputs.html", "text=Save"],
  ["/text-in-noncontent.html", "text=public content"],
  ["/text-ancestor.html", "text=hello ready"],
  ["/xpath-sibling.html", 'xpath=//main[../aside/@id="enabled"]'],
  ["/xpath-child.html", 'xpath=//main[aside[@id="enabled"]]'],
])("boundary checks retain Playwright selector semantics for %s", async (path, selector) => {
  const audit = auditCase(`${pages.url}${path}`, { ready: selector });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const steady = await measureRule(page, audit, page.url(), async () => ({
      facts: { elementsInspected: 1, violations: [] }, failure: null,
    }));
    expect(steady.failure).toBeNull();
    const changed = await measureRule(page, audit, page.url(), async (page) => {
      await page.evaluate(() => {
        const input = document.querySelector("input");
        if (input !== null) input.value = "Discard";
        else document.querySelector("main")!.textContent = "Busy";
        const gate = document.querySelector("aside");
        if (gate !== null) gate.id = "disabled";
      });
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(changed.failure?.code).toBe("ready-lost");
  } finally {
    await opened.value.close();
  }
});

test("measurement leaves browser hooks and evaluator page identity unchanged", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    await page.evaluate(() => {
      (globalThis as any).originalHooks = { observer: MutationObserver, push: history.pushState, replace: history.replaceState, shadow: Element.prototype.attachShadow };
    });
    const outcome = await measureRule(page, audit, page.url(), async (measured) => {
      expect(measured).toBe(page);
      expect(await measured.evaluate(() => {
        const original = (globalThis as any).originalHooks;
        return MutationObserver === original.observer && history.pushState === original.push && history.replaceState === original.replace && Element.prototype.attachShadow === original.shadow;
      })).toBe(true);
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(outcome.failure).toBeNull();
  } finally {
    await opened.value.close();
  }
});

test("display:contents uses Playwright visibility at both boundaries", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    await page.locator("#ready").evaluate((element) => {
      (element as HTMLElement).style.display = "contents";
      element.innerHTML = "<span>public content</span>";
    });
    const outcome = await measureRule(page, audit, page.url(), async () => ({
      facts: { elementsInspected: 1, violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
  } finally {
    await opened.value.close();
  }
});
