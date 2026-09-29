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

test("same-URL document reload during a rule still invalidates the result", async () => {
  const audit = auditCase(`${server.url}/`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => {
    await guarded.evaluate(() => { setTimeout(() => location.reload(), 30); return 1; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { facts: { elementsInspected: 1, violations: [] }, failure: null };
  });
  expect(outcome.failure?.code).toBe("navigation-during-measurement");
  expect(outcome.failure?.actualUrl).toBe(audit.url);
  await opened.value.close();
});

test("ready loss between browser evaluations cannot be hidden by restoration", async () => {
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
  expect(outcome.failure?.code).toBe("ready-lost");
  const next = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(next.failure).toBeNull();
  await opened.value.close();
});

test("temporary history changes between browser evaluations invalidate the rule", async () => {
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
  expect(outcome.failure?.code).toBe("url-mismatch");
  expect(outcome.failure?.actualUrl).toBe(`${server.url}/other`);
  await opened.value.close();
});

test.each(["pushState", "replaceState"] as const)("an app-installed %s wrapper survives guard release", async (method) => {
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
  expect(moved.failure?.code).toBe("url-mismatch");
  expect(moved.failure?.actualUrl).toBe(`${server.url}/other`);
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

test("an evaluator error releases the rule guard", async () => {
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

test.each(["remove", "host-id", "visibility", "stylesheet"] as const)(
  "shadow-piercing CSS readiness detects same-task %s loss rather than trusting the acquired match",
  async (mutation) => {
    const audit = auditCase(`${server.url}/shadow-ready`, { ready: "#host #ready" });
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    try {
      const page = opened.value.page;
      const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((mutation) => {
          const global = globalThis as any;
          global.shadowMeasurementRan = true;
          const host = global.document.querySelector("#host");
          const ready = host.shadowRoot.querySelector("#ready");
          if (mutation === "remove") {
            ready.remove();
            host.shadowRoot.append(ready);
          } else if (mutation === "host-id") {
            host.id = "other";
            host.id = "host";
          } else if (mutation === "visibility") {
            ready.hidden = true;
            ready.hidden = false;
          } else {
            const style = global.document.createElement("style");
            style.textContent = "#ready { display:none }";
            host.shadowRoot.append(style);
            style.remove();
          }
          return 1;
        }, mutation), violations: [] }, failure: null,
      }));
      expect(await page.evaluate(() => (globalThis as any).shadowMeasurementRan)).toBe(true);
      expect(outcome.failure?.code).toBe("ready-lost");
      expect(outcome.facts.elementsInspected).toBe(0);
      expect(await page.locator("#host #ready").isVisible()).toBe(true);
    } finally {
      await opened.value.close();
    }
  },
);

test("shadow-piercing CSS hidden readiness detects visibility loss during measurement", async () => {
  const opened = await browser.acquireCase(auditCase(`${server.url}/shadow-ready`));
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    await page.locator("#host #ready").evaluate((ready) => { (ready as HTMLElement).hidden = true; });
    const audit = { ...auditCase(page.url()), readyCondition: { selector: "#host #ready", state: "hidden" as const } };
    const steady = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
    }));
    expect(steady.failure).toBeNull();
    const lost = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async () => {
        const ready = (globalThis as any).document.querySelector("#host").shadowRoot.querySelector("#ready");
        ready.hidden = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
        ready.hidden = true;
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(lost.failure?.code).toBe("ready-lost");
    expect(lost.facts.elementsInspected).toBe(0);
  } finally {
    await opened.value.close();
  }
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

test("a transient hidden match in an existing shadow root invalidates measurement", async () => {
  const audit = { ...auditCase(`${server.url}/shadow-ready`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      doc.querySelector("#host").shadowRoot.append(spinner);
      await new Promise((resolve) => setTimeout(resolve, 20));
      spinner.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a transient hidden match in a newly added shadow root invalidates measurement", async () => {
  const audit = { ...auditCase(`${server.url}/shadow-ready`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      const host = doc.createElement("section");
      const shadow = host.attachShadow({ mode: "open" });
      doc.querySelector("#host").shadowRoot.append(host);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      shadow.append(spinner);
      await new Promise((resolve) => setTimeout(resolve, 20));
      spinner.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a hidden ready selector detects a match inside newly added shadow content", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const host = doc.createElement("section");
        const shadow = host.attachShadow({ mode: "open" });
        const spinner = doc.createElement("div");
        spinner.id = "spinner";
        spinner.textContent = "loading";
        shadow.append(spinner);
        doc.body.append(host);
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally {
    await opened.value.close();
  }
});

test("a hidden ready selector detects a same-task shadow match that disappears before observation", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const host = doc.createElement("section");
        const shadow = host.attachShadow({ mode: "open" });
        doc.body.append(host);
        const spinner = doc.createElement("div");
        spinner.id = "spinner";
        spinner.textContent = "loading";
        shadow.append(spinner);
        spinner.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#spinner").count()).toBe(0);
  } finally {
    await opened.value.close();
  }
});

test("an unrelated open-shadow custom element does not mask loss of a shadow ready descendant", async () => {
  const audit = auditCase(`${server.url}/shadow-ready`, { ready: "#host #ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const widget = doc.createElement("section");
        widget.attachShadow({ mode: "open" }).innerHTML = "<span>widget</span>";
        doc.body.append(widget);
        doc.querySelector("#host").shadowRoot.querySelector("#ready").remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally {
    await opened.value.close();
  }
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

test.each([
  ["[role=main]", "role", "button"],
  ["role=main", "role", "button"],
  ["xpath=//main[@id='ready']", "id", "other"],
])(
  "ready selector %s is re-evaluated with Playwright semantics during an async rule",
  async (selector, attribute, replacement) => {
    const audit = auditCase(`${server.url}/role-ready.html`, { ready: selector });
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async ({ attribute, replacement }) => {
        const element = (globalThis as any).document.querySelector("#ready");
        const original = element.getAttribute(attribute);
        element.setAttribute(attribute, replacement);
        await new Promise((resolve) => setTimeout(resolve, 20));
        element.setAttribute(attribute, original);
        return 1;
      }, { attribute, replacement }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    await opened.value.close();
  },
);

test("a chained ready selector is re-evaluated with Playwright semantics during an async rule", async () => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: "main >> text=public content" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const ready = (globalThis as any).document.querySelector("#ready");
      ready.textContent = "other";
      await new Promise((resolve) => setTimeout(resolve, 20));
      ready.textContent = "public content";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("an attribute update on an opaque ready match is conservatively incomplete", async () => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: "role=main" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const ready = (globalThis as any).document.querySelector("#ready");
      ready.dataset.tick = "1";
      await new Promise((resolve) => setTimeout(resolve, 10));
      ready.dataset.tick = "2";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a newly visible opaque match invalidates hidden readiness during an async rule", async () => {
  const audit = { ...auditCase(`${server.url}/role-hidden.html`), readyCondition: { selector: "role=main", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const main = (globalThis as any).document.createElement("main");
      main.setAttribute("role", "main");
      main.textContent = "ready";
      (globalThis as any).document.body.append(main);
      await new Promise((resolve) => setTimeout(resolve, 20));
      main.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test.each([
  ["role=main", "role", "status"],
  ["xpath=//main[@id='ready']", "id", "toast"],
] as const)("an unrelated %s attribute change does not fail a visible opaque ready condition", async (selector, attribute, value) => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: selector });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async ({ attribute, value }) => {
        const toast = (globalThis as any).document.createElement("div");
        (globalThis as any).document.body.append(toast);
        toast.setAttribute(attribute, value);
        await new Promise((resolve) => setTimeout(resolve, 10));
        toast.setAttribute(attribute, `${value}-next`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        toast.remove();
        return 1;
      }, { attribute, value }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(await page.locator("#ready").getAttribute("role")).toBe("main");
  } finally {
    await opened.value.close();
  }
});

test("a transient attribute match for a hidden opaque selector is incomplete", async () => {
  const audit = { ...auditCase(`${server.url}/role-hidden.html`), readyCondition: { selector: "role=main", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const app = (globalThis as any).document.querySelector("#app");
        app.setAttribute("role", "main");
        app.removeAttribute("role");
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#app").getAttribute("role")).toBeNull();
  } finally {
    await opened.value.close();
  }
});

test("a transient loss of an opaque sibling dependency is incomplete", async () => {
  const audit = auditCase(`${pages.url}/xpath-sibling.html`, { ready: 'xpath=//main[../aside/@id="enabled"]' });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const aside = (globalThis as any).document.querySelector("aside");
        aside.id = "disabled";
        aside.id = "enabled";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("aside").getAttribute("id")).toBe("enabled");
  } finally {
    await opened.value.close();
  }
});

test("a transient loss of a nested opaque child dependency is incomplete", async () => {
  const audit = auditCase(`${pages.url}/xpath-child.html`, { ready: 'xpath=//main[aside[@id="enabled"]]' });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const aside = (globalThis as any).document.querySelector("aside");
        aside.id = "disabled";
        aside.id = "enabled";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("aside").getAttribute("id")).toBe("enabled");
  } finally {
    await opened.value.close();
  }
});

test("a transient unrelated role match does not fail a visible opaque ready condition", async () => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: "role=main" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const toast = (globalThis as any).document.createElement("div");
        toast.setAttribute("role", "main");
        (globalThis as any).document.body.append(toast);
        toast.removeAttribute("role");
        toast.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(await page.locator("#ready").getAttribute("role")).toBe("main");
  } finally {
    await opened.value.close();
  }
});

test("an unrelated clock update does not fail a hidden ready condition", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      const clock = doc.createElement("div");
      clock.id = "clock";
      doc.body.append(clock);
      for (let tick = 0; tick < 3; tick += 1) {
        clock.textContent = `tick ${tick}`;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("an attribute change on the ready element is incomplete when visibility is uncertain", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const ready = (globalThis as any).document.querySelector("#ready");
      ready.dataset.tick = "1";
      await new Promise((resolve) => setTimeout(resolve, 10));
      ready.dataset.tick = "2";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("an unrelated child update inside the ready element does not fail the rule", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      const clock = doc.createElement("span");
      doc.querySelector("#ready").append(clock);
      for (let tick = 0; tick < 3; tick += 1) {
        clock.textContent = `tick ${tick}`;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test.each([
  ["main #ready", null],
  ["main:has(#ready)", null],
  ["main:has(.gate) #ready", "gate"],
  [".gate + #ready", "sibling"],
  ["body:has(.gate) #ready", "body-gate"],
] as const)("complex CSS readiness %s distinguishes unrelated footer changes from transient loss", async (selector, gate) => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate((gate) => {
    const doc = (globalThis as any).document;
    const main = doc.querySelector("main");
    main.removeAttribute("id");
    main.innerHTML = "<div id='ready'>public content</div>";
    const footer = doc.createElement("footer");
    footer.id = "footer";
    doc.body.append(footer);
    if (gate !== null) {
      const element = doc.createElement("span");
      element.className = "gate";
      if (gate === "sibling") doc.querySelector("#ready").before(element);
      else if (gate === "body-gate") footer.append(element);
      else doc.querySelector("main").append(element);
    }
  }, gate);
  const audit = { ...auditCase(url), readyCondition: { selector, state: "visible" as const } };
  const steady = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const footer = doc.querySelector("footer");
      const clock = doc.createElement("span");
      clock.textContent = "tick";
      footer.append(clock);
      clock.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(steady.failure).toBeNull();
  if (gate !== null) {
    const lost = await measureRule(page, audit, url, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const element = doc.querySelector(".gate");
        const parent = element.parentNode;
        const next = element.nextSibling;
        element.remove();
        parent.insertBefore(element, next);
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(lost.failure?.code).toBe("ready-lost");
    if (gate === "sibling") {
      const interrupted = await measureRule(page, audit, url, async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate(() => {
          const doc = (globalThis as any).document;
          const blocker = doc.createElement("span");
          doc.querySelector("#ready").before(blocker);
          blocker.remove();
          return 1;
        }), violations: [] }, failure: null,
      }));
      expect(interrupted.failure?.code).toBe("ready-lost");
    }
  }
  if (gate === null) {
    const lost = await measureRule(page, audit, url, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const ready = (globalThis as any).document.querySelector("#ready");
        const parent = ready.parentNode;
        ready.remove();
        parent.append(ready);
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(lost.failure?.code).toBe("ready-lost");
  }
  await opened.value.close();
});

test("a direct body child unrelated to a descendant ready match does not interrupt measurement", async () => {
  const url = `${server.url}/`;
  const audit = { ...auditCase(url), readyCondition: { selector: "body #ready", state: "visible" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const clock = doc.createElement("footer");
      doc.body.append(clock);
      clock.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("complex CSS readiness detects a transient global stylesheet inside an unrelated subtree", async () => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    doc.body.append(doc.createElement("footer"));
  });
  const audit = { ...auditCase(url), readyCondition: { selector: "body #ready", state: "visible" as const } };
  const outcome = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const style = doc.createElement("style");
      style.textContent = "#ready { display: none }";
      doc.querySelector("footer").append(style);
      style.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a simple visible selector detects a transient stylesheet that hides the ready match", async () => {
  const url = `${server.url}/`;
  const audit = auditCase(url, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const style = doc.createElement("style");
        style.textContent = "#ready { display: none }";
        doc.body.append(style);
        style.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#ready").isVisible()).toBe(true);
  } finally {
    await opened.value.close();
  }
});

test("a simple hidden selector detects a transient stylesheet that reveals the ready match", async () => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => { (globalThis as any).document.querySelector("#ready").style.display = "none"; });
  const audit = { ...auditCase(url), readyCondition: { selector: "#ready", state: "hidden" as const } };
  try {
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const style = doc.createElement("style");
        style.textContent = "#ready { display: block !important }";
        doc.body.append(style);
        style.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#ready").isVisible()).toBe(false);
  } finally {
    await opened.value.close();
  }
});

test.each(["transient", "persistent"] as const)(
  "an attached simple selector ignores a %s stylesheet that hides the ready match",
  async (lifetime) => {
    const url = `${server.url}/`;
    const audit = { ...auditCase(url), readyCondition: { selector: "#ready", state: "attached" as const } };
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    try {
      const page = opened.value.page;
      const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((lifetime) => {
          const doc = (globalThis as any).document;
          const style = doc.createElement("style");
          style.textContent = "#ready { display: none }";
          doc.body.append(style);
          if (lifetime === "transient") style.remove();
          return 1;
        }, lifetime), violations: [] }, failure: null,
      }));
      expect(outcome.failure).toBeNull();
      expect(outcome.facts.elementsInspected).toBe(1);
      expect(await page.locator("#ready").count()).toBe(1);
      expect(await page.locator("#ready").isVisible()).toBe(lifetime === "transient");
    } finally {
      await opened.value.close();
    }
  },
);

test("an attached visibility-sensitive selector detects a persistent stylesheet that hides the ready match", async () => {
  const url = `${server.url}/`;
  const audit = { ...auditCase(url), readyCondition: { selector: "#ready:visible", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const style = doc.createElement("style");
        style.textContent = "#ready { display: none }";
        doc.body.append(style);
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#ready").isVisible()).toBe(false);
  } finally {
    await opened.value.close();
  }
});

test("an attached complex selector ignores a transient stylesheet inside an unrelated subtree", async () => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    doc.body.append(doc.createElement("footer"));
  });
  const audit = { ...auditCase(url), readyCondition: { selector: "body #ready", state: "attached" as const } };
  const outcome = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const style = doc.createElement("style");
      style.textContent = "#ready { display: none }";
      doc.querySelector("footer").append(style);
      style.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(outcome.facts.elementsInspected).toBe(1);
  expect(await page.locator("#ready").isVisible()).toBe(true);
  await opened.value.close();
});

test("a visible simple selector detects a persistent stylesheet that hides the ready match", async () => {
  const url = `${server.url}/`;
  const audit = auditCase(url, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const style = doc.createElement("style");
        style.textContent = "#ready { display: none }";
        doc.body.append(style);
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("#ready").isVisible()).toBe(false);
  } finally {
    await opened.value.close();
  }
});

test("a simple visible selector ignores unrelated DOM updates without stylesheet nodes", async () => {
  const url = `${server.url}/`;
  const audit = auditCase(url, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const doc = (globalThis as any).document;
        const clock = doc.createElement("footer");
        clock.id = "clock";
        clock.textContent = "tick";
        doc.body.append(clock);
        const ticker = doc.createElement("span");
        clock.append(ticker);
        ticker.textContent = "tock";
        ticker.remove();
        clock.id = "clock-next";
        clock.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
  } finally {
    await opened.value.close();
  }
});

test("hidden :has readiness ignores unrelated footer updates and detects a transient descendant match", async () => {
  const url = `${server.url}/`;
  const audit = { ...auditCase(url), readyCondition: { selector: "main:has(.loading)", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const steady = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const footer = doc.createElement("footer");
      doc.body.append(footer);
      const clock = doc.createElement("span");
      clock.textContent = "tick";
      footer.append(clock);
      clock.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(steady.failure).toBeNull();
  const lost = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const loading = doc.createElement("span");
      loading.className = "loading";
      doc.querySelector("main").append(loading);
      loading.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(lost.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a hidden :has selector catches a same-task match inside a shadow root", async () => {
  const url = `${server.url}/shadow-ready`;
  const audit = { ...auditCase(url), readyCondition: { selector: "main:has(.loading)", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const lost = await measureRule(opened.value.page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const loading = doc.createElement("span");
      loading.className = "loading";
      doc.querySelector("#host").shadowRoot.querySelector("main").append(loading);
      loading.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(lost.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a combinator selector that transiently stops matching during an async rule fails", async () => {
  const url = `${server.url}/`;
  const acquired = await browser.acquireCase(auditCase(url, { ready: "#ready" }));
  if (!acquired.ok) throw new Error(acquired.failure.code);
  const page = acquired.value.page;
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const gate = doc.createElement("aside");
    gate.className = "on";
    doc.querySelector("#ready").before(gate);
  });
  const audit = { ...auditCase(url), readyCondition: { selector: ".on + #ready", state: "visible" as const } };
  const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const gate = (globalThis as any).document.querySelector(".on");
      gate.classList.remove("on");
      await new Promise((resolve) => setTimeout(resolve, 30));
      gate.classList.add("on");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await acquired.value.close();
});

test.each(["hidden attribute", "display none"])("a matching element inserted with %s preserves hidden readiness", async (style) => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate((style) => {
      const doc = (globalThis as any).document;
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      if (style === "hidden attribute") spinner.hidden = true;
      else spinner.style.display = "none";
      doc.body.append(spinner);
      return 1;
    }, style), violations: [] }, failure: null,
  }));
  expect(await page.locator("#spinner").isVisible()).toBe(false);
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("a visible matching node inserted and removed in one task loses hidden readiness", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      doc.body.append(spinner);
      spinner.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a newly appearing visible element violates a hidden ready condition during an async rule", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const doc = (globalThis as any).document;
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      doc.body.append(spinner);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a ready element hidden then restored asynchronously still fails", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const ready = (globalThis as any).document.querySelector("#ready");
      ready.style.display = "none";
      await new Promise((resolve) => setTimeout(resolve, 20));
      ready.style.display = "";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("an unrelated id change does not invalidate a hidden ready condition", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const clock = (globalThis as any).document.querySelector("#ready");
      clock.id = "clock";
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test.each(["visible", "attached"])("a style change is conservatively classified for %s readiness", async (state) => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#ready", state: state as "visible" | "attached" } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      (globalThis as any).document.querySelector("#ready").style.color = "red";
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code ?? null).toBe(state === "visible" ? "ready-lost" : null);
  await opened.value.close();
});

test("a same-task sibling selector loss is not hidden by restoration", async () => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  await page.evaluate(() => {
    const gate = (globalThis as any).document.createElement("aside");
    gate.className = "on";
    (globalThis as any).document.querySelector("#ready").before(gate);
  });
  const audit = { ...auditCase(url), readyCondition: { selector: ".on + #ready", state: "visible" as const } };
  const outcome = await measureRule(page, audit, url, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const gate = (globalThis as any).document.querySelector(".on");
      gate.classList.remove("on");
      gate.classList.add("on");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a Playwright css= selector fails when its element is absent before measurement", async () => {
  const url = `${server.url}/`;
  const opened = await browser.acquireCase(auditCase(url));
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.evaluate(() => (globalThis as any).document.querySelector("#ready").remove());
  const audit = { ...auditCase(url), readyCondition: { selector: "css=#ready", state: "visible" as const } };
  const outcome = await measureRule(opened.value.page, audit, url, async () => ({
    facts: { elementsInspected: 1, violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a quoted Playwright text selector remains ready", async () => {
  const audit = auditCase(`${server.url}/`, { ready: 'text="public content"' });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("a Playwright regex text selector detects an asynchronous ready loss", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "text=/public content/" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const ready = (globalThis as any).document.querySelector("#ready");
      ready.textContent = "other";
      await new Promise((resolve) => setTimeout(resolve, 10));
      ready.textContent = "public content";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a newly visible Playwright text match invalidates hidden readiness", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "text=loading indicator", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(async () => {
      const indicator = (globalThis as any).document.createElement("div");
      indicator.textContent = "loading indicator";
      (globalThis as any).document.body.append(indicator);
      await new Promise((resolve) => setTimeout(resolve, 10));
      indicator.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test.each([
  ["visible", null, null, null],
  ["attached", null, null, null],
  ["hidden", null, null, null],
  ["visible", "other", null, "ready-lost"],
  ["attached", "other", "ready", "ready-lost"],
  ["visible", "other", "ready", "ready-lost"],
  ["hidden", "ready", null, "ready-lost"],
  ["hidden", "ready", "public content", "ready-lost"],
] as const)("text %s readiness ignores unrelated characterData and detects a changed ready branch", async (state, changed, restored, expected) => {
  const audit = { ...auditCase(state === "hidden" ? `${server.url}/` : `${pages.url}/text-mutation.html`), readyCondition: { selector: "text=ready", state } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  if (state === "hidden") await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const aside = doc.createElement("aside");
    aside.id = "other";
    aside.textContent = "clock";
    doc.body.append(aside);
  });
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(({ changed, restored }) => {
      const doc = (globalThis as any).document;
      doc.querySelector("#other").firstChild.data = "tick";
      if (changed !== null) doc.querySelector("#ready").firstChild.data = changed;
      if (restored !== null) doc.querySelector("#ready").firstChild.data = restored;
      return 1;
    }, { changed, restored }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code ?? null).toBe(expected);
  await opened.value.close();
});

test.each(["visible", "attached"] as const)("text %s readiness survives unrelated child-list text replacements", async (state) => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "text=ready", state } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async () => {
        const clock = (globalThis as any).document.querySelector("#other");
        clock.textContent = "next";
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock.textContent = "later";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(await page.locator("text=ready").isVisible()).toBe(true);
  } finally {
    await opened.value.close();
  }
});

test.each([
  ["visible", "/text-mutation.html", "text=ready", "#ready", "replace"],
  ["attached", "/text-mutation.html", "text=ready", "#ready", "replace"],
  ["visible", "/text-mutation.html", "text=ready", "#ready", "remove"],
  ["attached", "/text-mutation.html", "text=ready", "#ready", "remove"],
  ["visible", "/text-ancestor.html", "text=hello ready", "#ready span", "replace"],
  ["attached", "/text-ancestor.html", "text=hello ready", "#ready span", "remove"],
] as const)("text %s readiness detects same-task contributing child-list loss in %s (%s, %s, %s)", async (state, path, selector, target, mutation) => {
  const audit = { ...auditCase(`${pages.url}${path}`), readyCondition: { selector, state } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(({ target, mutation }) => {
        const doc = (globalThis as any).document;
        doc.querySelector("aside").textContent = "next";
        const element = doc.querySelector(target);
        if (mutation === "replace") {
          const original = element.textContent;
          element.textContent = "loading";
          element.textContent = original;
        } else {
          const text = element.firstChild;
          text.remove();
          element.prepend(text);
        }
        return 1;
      }, { target, mutation }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator(selector).isVisible()).toBe(true);
  } finally {
    await opened.value.close();
  }
});

test("a hidden text ready selector detects an appended match whose text is mutated away in the same task", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "text=ready", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  try {
    const page = opened.value.page;
    const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const span = (globalThis as any).document.createElement("span");
        span.textContent = "ready";
        (globalThis as any).document.body.append(span);
        span.firstChild.data = "idle";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(await page.locator("body > span").textContent()).toBe("idle");
  } finally {
    await opened.value.close();
  }
});

test("an ancestor text ready match survives unrelated text mutations but not same-task text loss", async () => {
  const audit = { ...auditCase(`${pages.url}/text-ancestor.html`), readyCondition: { selector: "text=hello ready", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const unchanged = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      (globalThis as any).document.querySelector("aside").firstChild.data = "tick";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(unchanged.failure).toBeNull();
  const lost = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const text = (globalThis as any).document.querySelector("#ready span").firstChild;
      text.data = "goodbye ";
      text.data = "hello ";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(lost.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("text readiness ignores head, script, style and noscript after the body match disappears", async () => {
  const audit = { ...auditCase(`${pages.url}/text-in-noncontent.html`), readyCondition: { selector: "text=public content", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  expect(await page.locator("text=public content").count()).toBe(1);
  const steady = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(steady.failure).toBeNull();
  await page.locator("#ready").evaluate((element) => { element.textContent = "other"; });
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(await page.locator("text=public content").count()).toBe(0);
  expect(outcome.failure?.code).toBe("ready-lost");
  await page.locator("#ready").evaluate((element) => { element.textContent = "public content"; });
  const transient = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const text = (globalThis as any).document.querySelector("#ready").firstChild;
      text.data = "other";
      text.data = "public content";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(transient.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a text ready selector finds matches in an open shadow root", async () => {
  const audit = { ...auditCase(`${server.url}/shadow-ready`), readyCondition: { selector: "text=ready", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  expect(await page.locator("text=ready").count()).toBe(1);
  const outcome = await measureRule(page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("a ready text selector satisfied by a submit input value stays ready", async () => {
  const audit = auditCase(`${pages.url}/inputs.html`, { ready: "text=Save" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("losing a submit input value fails an input-value ready selector", async () => {
  const audit = auditCase(`${pages.url}/inputs.html`, { ready: "text=Save" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      (globalThis as any).document.querySelector("#save").value = "Discard";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a newly matching submit input value invalidates hidden readiness", async () => {
  const audit = { ...auditCase(`${pages.url}/inputs.html`), readyCondition: { selector: "text=Discard", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      (globalThis as any).document.querySelector("#save").value = "Discard";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test.each(["visible", "attached"])("an atomic ready replacement keeps %s readiness", async (state) => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#ready", state: state as "visible" | "attached" } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const replacement = doc.createElement("main");
      replacement.id = "ready";
      replacement.textContent = "public content";
      doc.querySelector("#ready").replaceWith(replacement);
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("removing and restoring every ready match fails multi-match readiness", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const nodes = Array.from(doc.querySelectorAll(".ready")) as any[];
      for (const node of nodes) node.remove();
      for (const node of nodes) doc.body.append(node);
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a continuously remaining ready match keeps multi-match readiness", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      doc.querySelector(".ready")!.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("overlapping replacements of ready matches keep readiness", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      for (const node of Array.from(doc.querySelectorAll(".ready")) as any[]) {
        const replacement = doc.createElement("main");
        replacement.className = "ready";
        replacement.textContent = "ready";
        node.replaceWith(replacement);
      }
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test.each([
  ["[data-ready]"],
  ["main[data-ready]"],
  ["body > [data-ready]"],
])("removing and restoring a matching attribute fails %s readiness", async (ready) => {
  const audit = auditCase(`${pages.url}/attribute-ready.html`, { ready });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.removeAttribute("data-ready");
      readyElement.setAttribute("data-ready", "");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("an attribute change on the ready element is incomplete even when the selector still matches", async () => {
  const audit = auditCase(`${pages.url}/attribute-ready.html`, { ready: "[data-ready]" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.dataset.tick = "1";
      readyElement.dataset.tick = "2";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a same-task hidden attribute toggle on the ready element fails visible readiness", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.hidden = true;
      readyElement.hidden = false;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a same-task hiding class toggle on the ready element fails visible readiness", async () => {
  const audit = auditCase(`${pages.url}/visibility.html`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.classList.add("hiding");
      readyElement.classList.remove("hiding");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a class toggle with uncertain visibility is incomplete without changing the page", async () => {
  const audit = auditCase(`${pages.url}/visibility.html`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.classList.add("marker");
      readyElement.classList.remove("marker");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("an overridden hidden toggle is incomplete when intermediate visibility cannot be proved", async () => {
  const audit = auditCase(`${pages.url}/hidden-override.html`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.hidden = true;
      readyElement.hidden = false;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a hidden toggle on one ready match keeps readiness through another visible match", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const first = (globalThis as any).document.querySelector(".ready");
      first.hidden = true;
      first.hidden = false;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("attached readiness ignores a same-task hidden toggle on the ready element", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#ready", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const readyElement = (globalThis as any).document.querySelector("#ready");
      readyElement.hidden = true;
      readyElement.hidden = false;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  await opened.value.close();
});

test("same-task text node changes cannot conceal a temporary ready loss", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "text=public content" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const text = (globalThis as any).document.querySelector("#ready").firstChild;
      text.data = "loading";
      text.data = "public content";
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  expect(await opened.value.page.locator("#ready").textContent()).toBe("public content");
  await opened.value.close();
});

test("overlapping ready matches do not fail when visibility moves between elements", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.locator(".ready").nth(1).evaluate((element) => { (element as HTMLElement).hidden = true; });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const [first, second] = (globalThis as any).document.querySelectorAll(".ready");
      second.hidden = false;
      first.hidden = true;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(await opened.value.page.locator(".ready").nth(0).isVisible()).toBe(false);
  expect(await opened.value.page.locator(".ready").nth(1).isVisible()).toBe(true);
  await opened.value.close();
});

test("a gap between visible ready matches is not hidden by later restoration", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.locator(".ready").nth(1).evaluate((element) => { (element as HTMLElement).hidden = true; });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const [first, second] = (globalThis as any).document.querySelectorAll(".ready");
      first.hidden = true;
      second.hidden = false;
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a hidden ready selector catches a same-task insertion and removal", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const spinner = doc.createElement("div");
      spinner.id = "spinner";
      spinner.textContent = "loading";
      doc.body.append(spinner);
      spinner.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  expect(await opened.value.page.locator("#spinner").count()).toBe(0);
  await opened.value.close();
});

test("ready verification does not create mutations visible to application observers", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.evaluate(() => {
    const global = globalThis as any;
    global.auditMutations = 0;
    new MutationObserver((records) => { global.auditMutations += records.length; }).observe(global.document.body, { childList: true, subtree: true });
  });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      doc.querySelector("#ready").append(doc.createElement("span"));
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure).toBeNull();
  expect(await opened.value.page.evaluate(() => (globalThis as any).auditMutations)).toBe(1);
  await opened.value.close();
});

test("attribute inspection does not create mutations visible to application observers", async () => {
  const audit = auditCase(`${server.url}/`, { ready: "#ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.evaluate(() => {
    const global = globalThis as any;
    global.auditMutations = 0;
    new MutationObserver((records) => { global.auditMutations += records.length; }).observe(global.document.body, { attributes: true, attributeOldValue: true, subtree: true });
  });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      (globalThis as any).document.querySelector("#ready").classList.add("marker");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  expect(await opened.value.page.evaluate(() => (globalThis as any).auditMutations)).toBe(1);
  await opened.value.close();
});

test("a same-task opaque selector change is incomplete", async () => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: "role=main" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const element = (globalThis as any).document.querySelector("#ready");
      element.setAttribute("role", "button");
      element.setAttribute("role", "main");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a transient match for a relational hidden selector is incomplete", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "main:has(.loading)", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const doc = (globalThis as any).document;
      const child = doc.createElement("span");
      child.className = "loading";
      doc.querySelector("main").append(child);
      child.remove();
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("losing two attribute-ready matches in one task is incomplete", async () => {
  const audit = auditCase(`${pages.url}/multi-ready.html`, { ready: ".ready" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const nodes = (globalThis as any).document.querySelectorAll(".ready");
      for (const node of nodes) node.classList.remove("ready");
      for (const node of nodes) node.classList.add("ready");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test("a transient relational match caused by a class toggle is incomplete", async () => {
  const audit = { ...auditCase(`${server.url}/`), readyCondition: { selector: "main:has(.loading)", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  await opened.value.page.evaluate(() => {
    const child = (globalThis as any).document.createElement("span");
    child.id = "child";
    (globalThis as any).document.querySelector("main").append(child);
  });
  const outcome = await measureRule(opened.value.page, audit, opened.value.actualUrl!, async (guarded) => ({
    facts: { elementsInspected: await guarded.evaluate(() => {
      const child = (globalThis as any).document.querySelector("#child");
      child.classList.add("loading");
      child.classList.remove("loading");
      return 1;
    }), violations: [] }, failure: null,
  }));
  expect(outcome.failure?.code).toBe("ready-lost");
  await opened.value.close();
});

test.each(["same-task", "pending", "empty", "unrelated", "closed"] as const)("late attachShadow on a connected host: %s", async (scenario) => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => {
      const global = globalThis as any;
      global.originalAttachShadow = global.Element.prototype.attachShadow;
      global.document.body.insertAdjacentHTML("beforeend", "<div id='host'></div>");
    });
    const measurement = measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async (scenario) => {
        const global = globalThis as any;
        const root = global.document.querySelector("#host").attachShadow({ mode: scenario === "closed" ? "closed" : "open" });
        if (scenario !== "empty") root.innerHTML = `<div id='${scenario === "unrelated" ? "clock" : "spinner"}' style='width:20px;height:20px'>loading</div>`;
        if (scenario === "pending") await new Promise<void>((resolve) => { global.releaseSpinner = resolve; });
        root.replaceChildren();
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    if (scenario === "pending") {
      await page.waitForFunction(() => typeof (globalThis as any).releaseSpinner === "function");
      expect(await page.locator("#spinner").isVisible()).toBe(true);
      await page.evaluate(() => (globalThis as any).releaseSpinner());
    }
    const outcome = await measurement;
    const lost = scenario === "same-task" || scenario === "pending";
    expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
    expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
    expect(await page.evaluate(() => (globalThis as any).Element.prototype.attachShadow === (globalThis as any).originalAttachShadow)).toBe(true);
  } finally { await opened.value.close(); }
});

test("attachShadow release preserves and deactivates an application wrapper", async () => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const global = globalThis as any;
        const previous = global.Element.prototype.attachShadow;
        global.appAttachShadow = function (this: any, ...args: any[]) { return previous.apply(this, args); };
        global.Element.prototype.attachShadow = global.appAttachShadow;
        const host = global.document.createElement("div");
        global.document.body.append(host);
        const options = { get mode() { global.modeReads = (global.modeReads ?? 0) + 1; return "open"; } };
        const root = host.attachShadow(options);
        global.rootReturned = root === host.shadowRoot;
        try { host.attachShadow({ mode: "open" }); } catch (error) { global.shadowError = (error as Error).name; }
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(await page.evaluate(() => {
      const global = globalThis as any;
      const preserved = global.Element.prototype.attachShadow === global.appAttachShadow;
      const host = global.document.createElement("div");
      global.document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML = "<div id='spinner'>loading</div>";
      return { preserved, reads: global.modeReads, returned: global.rootReturned, error: global.shadowError };
    })).toEqual({ preserved: true, reads: 1, returned: true, error: "NotSupportedError" });
  } finally { await opened.value.close(); }
});

for (const state of ["visible", "attached"] as const) {
  test.each(["overlap", "gap", "hidden-replacement"] as const)(`attribute membership handoff (${state}): %s`, async (scenario) => {
    const audit = { ...auditCase(`${pages.url}/multi-ready.html`), readyCondition: { selector: ".ready", state } };
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    const page = opened.value.page;
    try {
      await page.evaluate((scenario) => {
        const second = (globalThis as any).document.querySelectorAll("main")[1];
        second.className = "";
        second.hidden = scenario === "hidden-replacement";
      }, scenario);
      const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((scenario) => {
          const [first, second] = (globalThis as any).document.querySelectorAll("main");
          if (scenario === "gap") first.classList.remove("ready");
          second.classList.add("ready");
          if (scenario !== "gap") first.classList.remove("ready");
          second.hidden = false;
          return 1;
        }, scenario), violations: [] }, failure: null,
      }));
      const lost = scenario === "gap" || (state === "visible" && scenario === "hidden-replacement");
      expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
      expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
      expect(await page.locator(".ready").isVisible()).toBe(true);
    } finally { await opened.value.close(); }
  });
}

test.each(["unrelated", "sibling", "has", "stylesheet"] as const)("complex CSS attribute dependency: %s", async (scenario) => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate((scenario) => {
      const doc = (globalThis as any).document;
      doc.body.innerHTML = "<main><aside class='gate'>gate</aside><div id='ready'>content</div></main><footer>clock</footer>";
      if (scenario === "stylesheet") doc.head.insertAdjacentHTML("beforeend", "<style>.gate + #ready{display:none}</style>");
      if (scenario === "stylesheet") doc.querySelector("aside").className = "";
    }, scenario);
    const selector = scenario === "sibling" ? ".gate + #ready" : scenario === "has" ? "main:has(.gate) #ready" : "main #ready";
    const audit = auditCase(page.url(), { ready: selector });
    expect(await page.locator(selector).isVisible()).toBe(true);
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const doc = (globalThis as any).document;
        const target = doc.querySelector(scenario === "unrelated" ? "footer" : "aside");
        const original = target.className;
        target.className = scenario === "stylesheet" ? "gate" : "tick";
        target.className = scenario === "unrelated" ? "tock" : original;
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code ?? null).toBe(scenario === "unrelated" ? null : "ready-lost");
    expect(outcome.facts.elementsInspected).toBe(scenario === "unrelated" ? 1 : 0);
    expect(await page.locator(selector).isVisible()).toBe(true);
  } finally { await opened.value.close(); }
});

for (const writable of [true, false]) {
  test.each(["stable", "transient", "missing"] as const)(`application-owned ready recheck binding (writable=${writable}): %s`, async (scenario) => {
    const audit = auditCase(`${server.url}/role-ready.html`, { ready: "role=main" });
    const opened = await browser.acquireCase(audit);
    if (!opened.ok) throw new Error(opened.failure.code);
    const page = opened.value.page;
    try {
      await page.evaluate(({ writable, scenario }) => {
        const global = globalThis as any;
        global.appRecheckCalls = 0;
        global.appRecheck = () => { global.appRecheckCalls += 1; return scenario === "missing"; };
        Object.defineProperty(global, "__vlintReadyRecheck", { value: global.appRecheck, writable, configurable: false });
        if (scenario === "missing") global.document.querySelector("#ready").remove();
      }, { writable, scenario });
      const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((scenario) => {
          const doc = (globalThis as any).document;
          if (scenario === "transient") {
            doc.querySelector("#ready").setAttribute("role", "button");
            doc.querySelector("#ready").setAttribute("role", "main");
          } else {
            const footer = doc.createElement("footer");
            doc.body.append(footer);
            footer.textContent = "tick";
            footer.remove();
          }
          return 1;
        }, scenario), violations: [] }, failure: null,
      }));
      expect(outcome.failure?.code ?? null).toBe(scenario === "stable" ? null : "ready-lost");
      expect(outcome.facts.elementsInspected).toBe(scenario === "stable" ? 1 : 0);
      expect(await page.evaluate(() => {
        const global = globalThis as any;
        return { preserved: global.__vlintReadyRecheck === global.appRecheck, calls: global.appRecheckCalls };
      })).toEqual({ preserved: true, calls: 0 });
    } finally { await opened.value.close(); }
  });
}

test.each(["clock", "explicit", "implicit", "shadow", "aria-hidden"] as const)("hidden bare role mutation history: %s", async (scenario) => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "role=progressbar", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    if (scenario === "aria-hidden") await page.evaluate(() => {
      (globalThis as any).document.body.insertAdjacentHTML("beforeend", "<progress aria-hidden='true'></progress>");
    });
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const doc = (globalThis as any).document;
        if (scenario === "aria-hidden") {
          const progress = doc.querySelector("progress");
          progress.removeAttribute("aria-hidden");
          progress.setAttribute("aria-hidden", "true");
        } else {
          const element = doc.createElement(scenario === "implicit" ? "progress" : scenario === "clock" ? "footer" : "div");
          if (scenario === "explicit") element.setAttribute("role", "progressbar");
          if (scenario === "shadow") element.attachShadow({ mode: "open" }).innerHTML = "<progress></progress>";
          element.style.cssText = "width:20px;height:20px";
          doc.body.append(element);
          element.append("tick");
          element.firstChild.data = "tock";
          element.textContent = "next";
          element.remove();
        }
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code ?? null).toBe(scenario === "clock" ? null : "ready-lost");
    expect(outcome.facts.elementsInspected).toBe(scenario === "clock" ? 1 : 0);
    expect(await page.locator("role=progressbar").count()).toBe(0);
  } finally { await opened.value.close(); }
});

for (const state of ["visible", "attached"] as const) {
  test.each(["loss", "case-change", "substring", "clock", "aria-label", "labelledby-stable", "labelledby-loss", "second-match", "both-matches", "explicit-role"] as const)(`role button accessible-name history (${state}): %s`, async (scenario) => {
    const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
    if (!opened.ok) throw new Error(opened.failure.code);
    const page = opened.value.page;
    try {
      await page.evaluate((scenario) => {
        const doc = (globalThis as any).document;
        doc.body.innerHTML = "<button id='ready'>Ready</button><aside id='clock'>tick</aside><span id='label'>Ready</span>";
        if (scenario === "aria-label") doc.querySelector("button").setAttribute("aria-label", "Ready");
        if (scenario.startsWith("labelledby")) doc.querySelector("button").setAttribute("aria-labelledby", "label");
        if (scenario === "second-match" || scenario === "both-matches") doc.body.insertAdjacentHTML("beforeend", "<button id='second'>Ready</button>");
        if (scenario === "explicit-role") doc.querySelector("button").outerHTML = "<div role='button' id='ready'>Ready</div>";
      }, scenario);
      const audit = { ...auditCase(page.url()), readyCondition: { selector: 'role=button[name="Ready"]', state } };
      expect(await page.locator(audit.readyCondition.selector).count()).toBeGreaterThan(0);
      const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((scenario) => {
          const doc = (globalThis as any).document;
          const text = doc.querySelector(scenario === "clock" ? "#clock" : scenario === "labelledby-loss" ? "#label" : "#ready").firstChild;
          const original = text.data;
          text.data = scenario === "case-change" ? "ready" : scenario === "substring" ? "Not Ready" : "Busy";
          if (scenario === "both-matches") doc.querySelector("#second").firstChild.data = "Busy";
          text.data = original;
          if (scenario === "both-matches") doc.querySelector("#second").firstChild.data = "Ready";
          return 1;
        }, scenario), violations: [] }, failure: null,
      }));
      const lost = ["loss", "case-change", "substring", "labelledby-loss", "both-matches", "explicit-role"].includes(scenario);
      expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
      expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
      expect(await page.locator(audit.readyCondition.selector).first().isVisible()).toBe(true);
    } finally { await opened.value.close(); }
  });
}

test.each(["installation", "invocation"] as const)("an unavailable readiness recheck is incomplete: %s", async (scenario) => {
  const audit = auditCase(`${server.url}/role-ready.html`, { ready: "role=main" });
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  const context = page.context();
  const exposeBinding = context.exposeBinding;
  try {
    if (scenario === "installation") context.exposeBinding = async () => { throw new Error("binding unavailable"); };
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const global = globalThis as any;
        for (const name of Object.getOwnPropertyNames(global)) if (name.startsWith("__vlintReadyRecheck_")) global[name] = undefined;
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally { context.exposeBinding = exposeBinding; await opened.value.close(); }
});

test("attribute history uses inert copies without constructing application custom elements", async () => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/multi-ready.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => {
      const global = globalThis as any;
      global.constructed = 0;
      global.customElements.define("ready-view", class extends global.HTMLElement {
        constructor() { super(); global.constructed += 1; }
      });
      global.document.body.innerHTML = "<ready-view class='ready' style='display:block'>one</ready-view><ready-view style='display:block'>two</ready-view>";
    });
    const audit = auditCase(page.url(), { ready: ".ready" });
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const [first, second] = (globalThis as any).document.querySelectorAll("ready-view");
        second.className = "ready";
        first.className = "";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(await page.evaluate(() => (globalThis as any).constructed)).toBe(2);
  } finally { await opened.value.close(); }
});

test.each(["empty-role", "invalid-role", "initially-hidden"] as const)("hidden progressbar candidates excluded by initial snapshot: %s", async (scenario) => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "role=progressbar", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    if (scenario === "initially-hidden") await page.evaluate(() => {
      (globalThis as any).document.body.insertAdjacentHTML("beforeend", "<progress hidden></progress>");
    });
    expect(await page.locator("role=progressbar").count()).toBe(0);
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const doc = (globalThis as any).document;
        if (scenario === "initially-hidden") {
          const progress = doc.querySelector("progress");
          progress.hidden = false;
          progress.hidden = true;
        } else {
          const progress = doc.createElement("progress");
          progress.setAttribute("role", scenario === "empty-role" ? "" : "invalid-role");
          doc.body.append(progress);
          progress.remove();
        }
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally { await opened.value.close(); }
});

test.each(["detached-match", "detached-ancestor", "connected-overlap"] as const)("attached attribute membership tracks historical attachment: %s", async (scenario) => {
  const audit = { ...auditCase(`${pages.url}/multi-ready.html`), readyCondition: { selector: ".ready", state: "attached" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      doc.body.innerHTML = "<main class='ready'>one</main><section><main>two</main></section>";
    });
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const [first, second] = (globalThis as any).document.querySelectorAll("main");
        const removed = scenario === "detached-ancestor" ? second.parentNode : second;
        if (scenario !== "connected-overlap") removed.remove();
        second.className = "ready";
        first.className = "";
        first.className = "ready";
        if (scenario === "connected-overlap") removed.remove();
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    const lost = scenario !== "connected-overlap";
    expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
    expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
    expect(await page.locator(".ready").count()).toBe(1);
  } finally { await opened.value.close(); }
});

test("hidden bare role detects structural stylesheet visibility changes", async () => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "role=progressbar", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      doc.head.insertAdjacentHTML("beforeend", "<style>progress{display:none} body:has(footer .tick) progress{display:block}</style>");
      doc.body.innerHTML = "<progress></progress><footer></footer>";
    });
    expect(await page.locator("progress").isVisible()).toBe(false);
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const global = globalThis as any;
        const tick = global.document.createElement("span");
        tick.className = "tick";
        global.document.querySelector("footer").append(tick);
        const progress = global.document.querySelector("progress");
        global.progressWasVisible = progress.checkVisibility() && progress.getBoundingClientRect().width > 0 && progress.getBoundingClientRect().height > 0;
        tick.remove();
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(await page.evaluate(() => (globalThis as any).progressWasVisible)).toBe(true);
    expect(await page.locator("progress").isVisible()).toBe(false);
    expect(outcome.failure?.code).toBe("ready-lost");
    expect(outcome.facts.elementsInspected).toBe(0);
  } finally { await opened.value.close(); }
});

test.each(["never-connected", "connected-transient"] as const)("hidden readiness distinguishes detached shadow construction: %s", async (scenario) => {
  const audit = { ...auditCase(`${pages.url}/text-mutation.html`), readyCondition: { selector: "#spinner", state: "hidden" as const } };
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const doc = (globalThis as any).document;
        const host = doc.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<div id='spinner'>loading</div>";
        if (scenario === "connected-transient") {
          doc.body.append(host);
          root.replaceChildren();
          host.remove();
        }
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    const lost = scenario === "connected-transient";
    expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
    expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
  } finally { await opened.value.close(); }
});

for (const state of ["visible", "attached"] as const) {
  test.each(["overlap", "gap"] as const)(`role button newly matching accessible-name handoff (${state}): %s`, async (scenario) => {
    const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
    if (!opened.ok) throw new Error(opened.failure.code);
    const page = opened.value.page;
    try {
      await page.evaluate(() => {
        (globalThis as any).document.body.innerHTML = "<button id='first'>Ready</button><button id='second'>Busy</button>";
      });
      const audit = { ...auditCase(page.url()), readyCondition: { selector: 'role=button[name="Ready"]', state } };
      const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
        facts: { elementsInspected: await guarded.evaluate((scenario) => {
          const doc = (globalThis as any).document;
          if (scenario === "gap") doc.querySelector("#first").firstChild.data = "Busy";
          doc.querySelector("#second").firstChild.data = "Ready";
          if (scenario === "overlap") doc.querySelector("#first").firstChild.data = "Busy";
          return 1;
        }, scenario), violations: [] }, failure: null,
      }));
      const lost = scenario === "gap";
      expect(outcome.failure?.code ?? null).toBe(lost ? "ready-lost" : null);
      expect(outcome.facts.elementsInspected).toBe(lost ? 0 : 1);
      expect(await page.locator(audit.readyCondition.selector).isVisible()).toBe(true);
    } finally { await opened.value.close(); }
  });
}

test("font loading between rules invalidates selector-free readiness", async () => {
  const audit = auditCase(`${pages.url}/text-mutation.html`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    const first = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => 1), violations: [] }, failure: null,
    }));
    expect(first.failure).toBeNull();
    await page.evaluate(() => Object.defineProperty(document.fonts, "status", { configurable: true, value: "loading" }));
    let evaluated = false;
    const second = await measureRule(page, audit, page.url(), async () => {
      evaluated = true;
      return { facts: { elementsInspected: 1, violations: [] }, failure: null };
    });
    expect(evaluated).toBe(false);
    expect(second.failure?.code).toBe("ready-lost");
  } finally { await opened.value.close(); }
});

test("transient font loading during a rule invalidates selector-free readiness", async () => {
  const audit = auditCase(`${pages.url}/text-mutation.html`);
  const opened = await browser.acquireCase(audit);
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(async () => {
        Object.defineProperty(document.fonts, "status", { configurable: true, value: "loading" });
        document.fonts.dispatchEvent(new Event("loading"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        Object.defineProperty(document.fonts, "status", { configurable: true, value: "loaded" });
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
  } finally { await opened.value.close(); }
});

test.each(["clock", "heading"] as const)("named heading readiness ignores unrelated text but detects %s changes", async (scenario) => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => { document.body.innerHTML = "<h1 id='ready'>Ready</h1><aside id='clock'>tick</aside>"; });
    const audit = auditCase(page.url(), { ready: 'role=heading[name="Ready"]' });
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        const target = document.querySelector(scenario === "clock" ? "#clock" : "#ready")!.firstChild!;
        target.textContent = "Busy";
        target.textContent = scenario === "clock" ? "tick" : "Ready";
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code ?? null).toBe(scenario === "clock" ? null : "ready-lost");
  } finally { await opened.value.close(); }
});

test("named heading text replacement and restoration cannot conceal ready loss", async () => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    await page.evaluate(() => { document.body.innerHTML = "<h1 id='ready'>Ready</h1>"; });
    const audit = auditCase(page.url(), { ready: 'role=heading[name="Ready"]' });
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate(() => {
        const heading = document.querySelector("#ready")!;
        heading.textContent = "Busy";
        heading.textContent = "Ready";
        return 1;
      }), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code).toBe("ready-lost");
  } finally { await opened.value.close(); }
});

test.each(["footer", "clock", "heading"] as const)("hidden named heading readiness filters %s mutations", async (scenario) => {
  const opened = await browser.acquireCase(auditCase(`${pages.url}/text-mutation.html`));
  if (!opened.ok) throw new Error(opened.failure.code);
  const page = opened.value.page;
  try {
    const audit = { ...auditCase(page.url()), readyCondition: { selector: 'role=heading[name="Ready"]', state: "hidden" as const } };
    const outcome = await measureRule(page, audit, page.url(), async (guarded) => ({
      facts: { elementsInspected: await guarded.evaluate((scenario) => {
        if (scenario === "clock") document.querySelector("#other")!.textContent = "tock";
        else {
          const element = document.createElement(scenario === "footer" ? "footer" : "h1");
          element.textContent = scenario === "footer" ? "unrelated" : "Ready";
          document.body.append(element);
          element.remove();
        }
        return 1;
      }, scenario), violations: [] }, failure: null,
    }));
    expect(outcome.failure?.code ?? null).toBe(scenario === "heading" ? "ready-lost" : null);
  } finally { await opened.value.close(); }
});
