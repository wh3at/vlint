import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import type { EffectiveTableHeaderSingleLineRule } from "../../src/contracts/config";
import { evaluateTableHeaderSingleLine } from "../../src/rules/table-header-single-line";
import { startFixtureServer } from "../fixtures/app/server";

const RULE: EffectiveTableHeaderSingleLineRule = {
  name: "table-header-single-line",
  type: "table-header-single-line",
  enabled: true,
  additionalCandidateSelectors: [],
  excludeSelectors: [],
  lineTopTolerancePx: 1,
  minimumHeaders: 0,
  allowZeroHeaders: true,
};

let browser: Browser;
let fixtureUrl: string;
let fixtureClose: () => Promise<void>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const fixture = await startFixtureServer();
  fixtureUrl = fixture.url;
  fixtureClose = fixture.close;
});

afterAll(async () => {
  await browser.close().catch(() => undefined);
  await fixtureClose().catch(() => undefined);
});

async function measure(
  html: string,
  overrides: Partial<EffectiveTableHeaderSingleLineRule> = {},
  width = 1280,
) {
  const context = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const outcome = await evaluateTableHeaderSingleLine(page, { ...RULE, ...overrides }, "target");
  await context.close();
  return outcome;
}

describe("table-header-single-line semantic measurement", () => {
  test("measures native and ARIA column headers and reports wrapped text evidence", async () => {
    const outcome = await measure(`
      <table><thead><tr>
        <th scope="col" style="width:60px">Review score</th>
        <th scope="col">Status</th>
      </tr></thead></table>
      <div role="columnheader" style="width:55px">Account owner</div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(3);
    expect(outcome.facts.violations.map((item) => item.candidateSource)).toEqual([
      "native",
      "aria",
    ]);
    for (const violation of outcome.facts.violations) {
      expect(violation.lineCount).toBeGreaterThanOrEqual(2);
      expect(violation.lineTops).toHaveLength(violation.lineCount);
      expect(violation.lineTopTolerancePx).toBe(1);
      expect(violation.locator.length).toBeGreaterThan(0);
    }
  });

  test("excludes row headers and records configured exclusions", async () => {
    const outcome = await measure(
      `<table><thead><tr>
        <th scope="row">Native row</th>
        <th scope="rowgroup">Native rowgroup</th>
        <th class="skip" data-wrap scope="col">Skipped header</th>
        <th scope="col">Kept</th>
      </tr></thead></table>
      <div role="rowheader">ARIA row</div>`,
      { excludeSelectors: [".skip", "[data-wrap]"] },
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.candidateDiagnostics).toEqual([
      expect.objectContaining({ kind: "excluded", excludeSelector: ".skip" }),
    ]);
  });

  test("deduplicates additional selectors and preserves semantic source precedence", async () => {
    const outcome = await measure(
      `<div id="extra" class="header" style="width:55px">Additional header</div>
       <div id="semantic" role="columnheader" class="header" style="width:55px">Semantic header</div>`,
      { additionalCandidateSelectors: [".header", "#semantic"] },
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(2);
    expect(outcome.facts.violations.map((item) => item.candidateSource)).toEqual([
      "additional",
      "aria",
    ]);
  });

  test("uses only DOM text rectangles, not decorative element boxes", async () => {
    const outcome = await measure(
      `<div role="columnheader" style="position:relative;width:200px">
        Plain text <span aria-hidden="true" style="position:absolute;top:50px;width:16px;height:16px"></span>
      </div>`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("ignores hidden descendant text when counting lines", async () => {
    const outcome = await measure(
      `<div role="columnheader" style="position:relative;width:200px">
        Visible header
        <span style="position:absolute;top:40px;left:0;visibility:hidden">hidden hint</span>
      </div>`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("treats superscript fragments as part of the header's visual line", async () => {
    const outcome = await measure(
      `<div role="columnheader" style="width:300px">Price<sup>*</sup></div>`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("diagnoses generated content and continues to a measurable violation", async () => {
    const outcome = await measure(`
      <style>.generated::after { content: "★"; }</style>
      <div id="generated" class="generated" role="columnheader">Price</div>
      <div id="wrapped" role="columnheader" style="width:50px">Review score</div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.candidateDiagnostics).toEqual([
      { kind: "generated-content-unmeasured", locator: "#generated" },
    ]);
    expect(outcome.facts.violations[0]!.locator).toBe("#wrapped");
  });

  test("skips hidden, whitespace-only, and icon-only candidates", async () => {
    const outcome = await measure(`
      <div role="columnheader" style="display:none">Hidden</div>
      <div role="columnheader">   </div>
      <div role="columnheader"><svg width="16" height="16"><circle cx="8" cy="8" r="6" /></svg></div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(0);
  });

  test("fails candidate and exclusion selector validation distinctly", async () => {
    const candidate = await measure(`<th scope="col">Header</th>`, {
      additionalCandidateSelectors: ["th[scope="],
    });
    expect(candidate.failure?.code).toBe("candidate-selector-invalid");
    const exclusion = await measure(`<th scope="col">Header</th>`, {
      excludeSelectors: ["###bad"],
    });
    expect(exclusion.failure?.code).toBe("exclude-selector-invalid");
  });

  test("enforces minimumHeaders after measurement", async () => {
    const outcome = await measure(
      `<table><thead><tr><th scope="col">Only</th></tr></thead></table>`,
      { minimumHeaders: 2 },
    );
    expect(outcome.failure?.code).toBe("minimum-headers-unmet");
    expect(outcome.facts.elementsInspected).toBe(1);
  });

  test("preserves prior facts when a later candidate cannot be measured", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div id="first" role="columnheader">First</div>
      <div id="broken" role="columnheader">Broken</div>
    </body></html>`);
    await page.evaluate(() => {
      const broken = document.querySelector("#broken");
      if (broken !== null) broken.getBoundingClientRect = () => { throw new Error("synthetic"); };
    });
    const outcome = await evaluateTableHeaderSingleLine(page, RULE, "target");
    await context.close();
    expect(outcome.failure?.code).toBe("geometry-evaluation-failed");
    expect(outcome.facts.elementsInspected).toBe(1);
  });

  test("wraps the served responsive header only at iPhone width", async () => {
    async function atWidth(width: number) {
      const context = await browser.newContext({ viewport: { width, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${fixtureUrl}/table-headers.html`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      const outcome = await evaluateTableHeaderSingleLine(page, RULE, "fixture");
      await context.close();
      return outcome;
    }
    const desktop = await atWidth(1280);
    const iphone = await atWidth(390);
    expect(desktop.facts.violations).toHaveLength(0);
    expect(iphone.facts.violations.map((item) => item.locator)).toEqual(["#responsive-header"]);
  });
});
