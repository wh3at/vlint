import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { EffectivePageHorizontalOverflowRule } from "../../src/contracts/config";
import { evaluatePageHorizontalOverflow } from "../../src/rules/page-horizontal-overflow";

const RULE: EffectivePageHorizontalOverflowRule = {
  name: "page-horizontal-overflow",
  type: "page-horizontal-overflow",
  enabled: true,
  tolerancePx: 1,
};

let browser: Browser;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
  await browser.close().catch(() => undefined);
});

async function pageWith(html: string, width = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 600 }, deviceScaleFactor: 1 });
  contexts.push(context);
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0}</style></head><body>${html}</body></html>`,
    { waitUntil: "load" },
  );
  return page;
}

describe("page-horizontal-overflow browser evaluation", () => {
  test("exact fit and vertical-only growth take the zero-inspection fast path", async () => {
    const page = await pageWith('<div style="width:800px;height:1400px"></div>');
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "fit");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts).toEqual({ elementsInspected: 0, violations: [] });
  });

  test("reports a wide element with numeric breach, geometry, locator, and fixed CSS evidence", async () => {
    const page = await pageWith('<main data-testid="wide" style="width:920px;white-space:nowrap">wide</main>');
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "wide");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBeGreaterThan(0);
    expect(outcome.facts.violations).toHaveLength(1);
    expect(outcome.facts.violations[0]).toMatchObject({
      type: "page-horizontal-overflow",
      overflowPx: 120,
      locator: '[data-testid="wide"]',
      geometry: { x: 0, width: 920 },
      computedStyle: { display: "block", width: "920px", whiteSpace: "nowrap" },
    });
    expect(Object.keys(outcome.facts.violations[0]!.computedStyle)).toEqual([
      "display",
      "position",
      "boxSizing",
      "width",
      "minWidth",
      "maxWidth",
      "whiteSpace",
      "overflowX",
      "flex",
      "flexBasis",
      "flexGrow",
      "flexShrink",
      "gridTemplateColumns",
      "gridAutoColumns",
    ]);
  });

  test("collapses a parent-child chain and preserves unrelated causes in document order", async () => {
    const page = await pageWith(`
      <section data-testid="outer" style="width:900px"><div data-testid="inner" style="width:1000px;height:20px"></div></section>
      <aside data-testid="sibling" style="width:850px;height:20px"></aside>
    `);
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "chains");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.violations.map((violation) => violation.locator)).toEqual([
      '[data-testid="outer"]',
      '[data-testid="sibling"]',
    ]);
  });

  test("suppresses a contained local scroller while retaining an unrelated root cause", async () => {
    const page = await pageWith(`
      <div data-testid="scroller" style="width:240px;overflow-x:auto">
        <div data-testid="contained-child" style="width:900px;height:20px"></div>
      </div>
      <div data-testid="root-cause" style="width:820px;height:20px"></div>
    `);
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "contained");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.violations.map((violation) => violation.locator)).toEqual([
      '[data-testid="root-cause"]',
    ]);
    expect(outcome.facts.elementsInspected).toBeGreaterThan(0);
  });

  test("retains a local scroller when its own boundary escapes the root viewport", async () => {
    const page = await pageWith(`
      <div data-testid="escaping" style="margin-left:700px;width:300px;overflow-x:auto">
        <div style="width:600px;height:20px"></div>
      </div>
    `);
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "escaping");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.violations[0]).toMatchObject({ locator: '[data-testid="escaping"]', overflowPx: 200 });
  });

  test("the same responsive element is desktop-clean and mobile-violating", async () => {
    const html = '<div data-testid="responsive" style="width:700px;height:20px"></div>';
    const desktop = await pageWith(html, 800);
    const mobile = await pageWith(html, 402);
    const desktopOutcome = await evaluatePageHorizontalOverflow(desktop, RULE, "responsive");
    const mobileOutcome = await evaluatePageHorizontalOverflow(mobile, RULE, "responsive");
    expect(desktopOutcome.facts.violations).toEqual([]);
    expect(mobileOutcome.facts.violations[0]).toMatchObject({
      locator: '[data-testid="responsive"]',
      overflowPx: 298,
    });
  });

  test("strict tolerance treats exact tolerance as clean and just-over as a violation", async () => {
    const exact = await pageWith('<div style="width:801px;height:20px"></div>');
    const over = await pageWith('<div style="width:802px;height:20px"></div>');
    const exactOutcome = await evaluatePageHorizontalOverflow(exact, RULE, "exact");
    const overOutcome = await evaluatePageHorizontalOverflow(over, RULE, "over");
    expect(exactOutcome.facts.violations).toEqual([]);
    expect(overOutcome.facts.violations[0]?.overflowPx).toBe(2);
  });
  test("falls back to the scrolling element when generated content creates root overflow", async () => {
    const page = await pageWith("<style>body::after{content:'';position:absolute;left:0;width:900px;height:1px}</style>");
    const outcome = await evaluatePageHorizontalOverflow(page, RULE, "generated");
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.violations).toHaveLength(1);
    expect(outcome.facts.violations[0]).toMatchObject({
      type: "page-horizontal-overflow",
      overflowPx: 100,
      locator: "html:nth-of-type(1)",
    });
  });
});
