/**
 * Integration tests for the tab-label-single-line rule (U4, AE1-AE5/AE12/AE13).
 *
 * These drive a real headless Chromium, hand a ready Page to
 * `evaluateTabLabelSingleLine`, and assert the observed facts/failures. They do
 * no run-disposition or global-finalization work — that is U5's responsibility.
 *
 * Integration boundary: every page is settled via `document.fonts.ready` (an
 * observable event) before measurement, so there are no blind wall-clock sleeps.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {chromium, type Browser, type Page} from "playwright";
import { evaluateTabLabelSingleLine } from "../../src/rules/tab-label-single-line";
import type { EffectiveTabLabelSingleLineRule } from "../../src/contracts/config";
import type { RuleEvaluationOutcome, TabLabelSingleLineViolation } from "../../src/contracts/evaluation";
import { startFixtureServer } from "../fixtures/app/server";

const RULE: EffectiveTabLabelSingleLineRule = {
  name: "tab-label-single-line",
  type: "tab-label-single-line",
  enabled: true,
  additionalCandidateSelectors: [],
  excludeSelectors: [],
  labelSelector: null,
  minimumLabels: 0,
  allowZeroLabels: false,
};

function ruleWith(over: Partial<EffectiveTabLabelSingleLineRule>): EffectiveTabLabelSingleLineRule {
  return { ...RULE, ...over };
}

let browser: Browser;
let fixtureUrl: string;
let fixtureClose: () => Promise<void>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const server = await startFixtureServer();
  fixtureUrl = server.url;
  fixtureClose = server.close;
});

afterAll(async () => {
  await browser.close().catch(() => undefined);
  await fixtureClose().catch(() => undefined);
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  return context.newPage();
}

/** Set HTML, settle fonts, then measure. Integration boundary: fonts.ready. */
async function measureHtml(
  html: string,
  rule: EffectiveTabLabelSingleLineRule = RULE,
): Promise<RuleEvaluationOutcome<TabLabelSingleLineViolation>> {
  const page = await newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const outcome = await evaluateTabLabelSingleLine(page, rule, "target");
  await page.close();
  return outcome;
}

async function measureFixture(
  rule: EffectiveTabLabelSingleLineRule = RULE,
  path = "/tabs.html",
): Promise<{ page: Page; outcome: RuleEvaluationOutcome<TabLabelSingleLineViolation> }> {
  const page = await newPage();
  await page.goto(`${fixtureUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  const outcome = await evaluateTabLabelSingleLine(page, rule, "fixture");
  return { page, outcome };
}

// Style-only fragments: callers add their own `class`/`id` as separate attributes
// so no element ever ends up with a duplicate `class` or `style` attribute.
const TAB_STYLE = 'style="display:inline-block;max-width:76px;white-space:normal;"';
const WIDE_TAB_STYLE = 'style="display:inline-block;white-space:normal;"';

// ---------------------------------------------------------------------------
// AE1 — clean single-line tabs; multi-line wraps collected in DOM order.
// ---------------------------------------------------------------------------

describe("AE1 clean and wrapped tabs", () => {
  test("selected, unselected and disabled single-line tabs are clean", async () => {
    const outcome = await measureHtml(`
      <div role="tablist">
        <button role="tab" ${WIDE_TAB_STYLE} aria-selected="true">Overview</button>
        <button role="tab" ${WIDE_TAB_STYLE} aria-selected="false">Details</button>
        <button role="tab" ${WIDE_TAB_STYLE} aria-disabled="true">Archived</button>
      </div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(3);
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("wrapped tabs are collected as violations in document order", async () => {
    const outcome = await measureHtml(`
      <div role="tablist">
        <button role="tab" ${TAB_STYLE} data-testid="wrap-a">Account Settings</button>
        <button role="tab" ${WIDE_TAB_STYLE}>Short</button>
        <button role="tab" ${TAB_STYLE} data-testid="wrap-b">Notification Preferences</button>
      </div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(3);
    expect(outcome.facts.violations).toHaveLength(2);
    expect(outcome.facts.violations.map((v) => v.lineCount)).toEqual([2, 2]);
    expect(outcome.facts.violations.map((v) => v.text)).toEqual([
      "Account Settings",
      "Notification Preferences",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AE2 — exclusion selector removes intentional multi-line tabs only.
// ---------------------------------------------------------------------------

describe("AE2 exclusion", () => {
  test("only tabs matching the exclude selector are dropped from candidates and count", async () => {
    const html = `
      <div role="tablist">
        <button role="tab" ${TAB_STYLE} class="intentional">Deliberately Wrapped Long Label</button>
        <button role="tab" ${TAB_STYLE} data-testid="real-wrap">Also Wraps Here</button>
        <button role="tab" ${WIDE_TAB_STYLE}>Clean</button>
      </div>`;
    const excluded = await measureHtml(html, ruleWith({ excludeSelectors: [".intentional"] }));
    expect(excluded.failure).toBeNull();
    expect(excluded.facts.elementsInspected).toBe(2);
    expect(excluded.facts.violations).toHaveLength(1);
    expect(excluded.facts.violations[0]!.text).toBe("Also Wraps Here");
  });
});

// ---------------------------------------------------------------------------
// AE3 — relative label selector cardinality and rendered-state.
// ---------------------------------------------------------------------------

describe("AE3 label selector resolution", () => {
  test("zero matches yields label-selector-cardinality, preserving prior facts", async () => {
    const outcome = await measureHtml(
      `<div role="tablist">
        <div role="tab" data-testid="good"><span class="label">Good Label</span></div>
        <div role="tab" data-testid="no-label"><span class="other">no label here</span></div>
      </div>`,
      ruleWith({ labelSelector: ".label" }),
    );
    expect(outcome.facts.elementsInspected).toBe(1); // prior candidate fact preserved
    expect(outcome.failure?.code).toBe("label-selector-cardinality");
  });

  test("more than one match yields label-selector-cardinality", async () => {
    const outcome = await measureHtml(
      `<div role="tab"><span class="label">One</span><span class="label">Two</span></div>`,
      ruleWith({ labelSelector: ".label" }),
    );
    expect(outcome.failure?.code).toBe("label-selector-cardinality");
    expect(outcome.facts.elementsInspected).toBe(0);
  });

  test("exactly one but non-rendered yields label-selector-not-rendered", async () => {
    const outcome = await measureHtml(
      `<div role="tab" ${WIDE_TAB_STYLE} data-testid="host">
        <span class="label" style="display:none;">Hidden Label</span>
      </div>`,
      ruleWith({ labelSelector: ".label" }),
    );
    expect(outcome.failure?.code).toBe("label-selector-not-rendered");
  });

  test("exactly one rendered label is measured normally", async () => {
    const outcome = await measureHtml(
      `<div role="tab" ${WIDE_TAB_STYLE} data-testid="host"><span class="label">Just One</span></div>`,
      ruleWith({ labelSelector: ".label" }),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AE4 — zero candidates is a valid fact, no global verdict from the rule.
// ---------------------------------------------------------------------------

describe("AE4 zero candidates", () => {
  test("a page with no role=tab returns a clean empty fact", async () => {
    const outcome = await measureHtml(`<div><button type="button">not a tab</button></div>`);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(outcome.facts.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AE5 — minimum labels unmet is a rule-evaluation failure.
// ---------------------------------------------------------------------------

describe("AE5 minimum labels", () => {
  test("fewer inspectable labels than minimum yields minimum-labels-unmet", async () => {
    const outcome = await measureHtml(
      `<div role="tablist"><button role="tab" ${WIDE_TAB_STYLE}>Solo</button></div>`,
      ruleWith({ minimumLabels: 2 }),
    );
    expect(outcome.failure?.code).toBe("minimum-labels-unmet");
    expect(outcome.facts.elementsInspected).toBe(1);
  });

  test("meeting the minimum stays clean", async () => {
    const outcome = await measureHtml(
      `<div role="tablist">
        <button role="tab" ${WIDE_TAB_STYLE}>One</button>
        <button role="tab" ${WIDE_TAB_STYLE}>Two</button>
      </div>`,
      ruleWith({ minimumLabels: 2 }),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Geometry edge cases: superscript, badge, tall bridge, transform, wrap.
// ---------------------------------------------------------------------------

describe("geometry edge cases", () => {
  test("superscript on the same line stays clean", async () => {
    const outcome = await measureHtml(
      `<button role="tab" ${WIDE_TAB_STYLE}>Items<sup>2</sup></button>`,
    );
    expect(outcome.facts.elementsInspected).toBe(1);
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("inline badge on the same line stays clean", async () => {
    const outcome = await measureHtml(
      `<button role="tab" ${WIDE_TAB_STYLE}>Inbox <span class="badge">3</span></button>`,
    );
    expect(outcome.facts.violations).toHaveLength(0);
  });

  test("a tall badge spanning two wrapped lines does not bridge them", async () => {
    const outcome = await measureHtml(
      `<span role="tab" style="display:inline-block;max-width:76px;white-space:normal;position:relative;">
        Bridge Label
        <span style="position:absolute; left:84px; top:0; line-height:46px;">NEW</span>
      </span>`,
    );
    expect(outcome.facts.violations).toHaveLength(1);
    expect(outcome.facts.violations[0]!.lineCount).toBe(2);
  });

  test("fractional transform geometry is rounded to three decimals", async () => {
    const outcome = await measureHtml(
      `<button role="tab" style="display:inline-block;max-width:76px;white-space:normal;transform:translateY(7.5px);">Shifted Wrap Label</button>`,
    );
    expect(outcome.facts.violations).toHaveLength(1);
    const geom = outcome.facts.violations[0]!.geometry;
    for (const value of [geom.x, geom.y, geom.width, geom.height]) {
      const decimals = (String(value).split(".")[1] ?? "").length;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Hidden / non-measurable states: excluded from label count.
// ---------------------------------------------------------------------------

describe("hidden and non-measurable states", () => {
  const states = [
    ["display:none", `<button role="tab" style="display:none;">Hidden One</button>`],
    ["visibility:hidden", `<button role="tab" style="visibility:hidden;">Invisible</button>`],
    ["visibility:collapse", `<button role="tab" style="visibility:collapse;">Collapsed</button>`],
    ["content-visibility:hidden", `<button role="tab" style="content-visibility:hidden;">CV</button>`],
    ["opacity:0", `<button role="tab" style="opacity:0;">Transparent</button>`],
    [
      "icon-only",
      `<button role="tab" ${WIDE_TAB_STYLE}><svg width="16" height="16"><circle cx="8" cy="8" r="6"></circle></svg></button>`,
    ],
    ["aria-label-only", `<button role="tab" ${WIDE_TAB_STYLE} aria-label="Settings"></button>`],
    ["whitespace-only", `<button role="tab" ${WIDE_TAB_STYLE}>   </button>`],
  ] as const;

  for (const [name, html] of states) {
    test(`${name} tab is not counted`, async () => {
      const outcome = await measureHtml(`<div role="tablist">${html}</div>`);
      expect(outcome.failure).toBeNull();
      expect(outcome.facts.elementsInspected).toBe(0);
    });
  }

  test("a hidden ancestor hides its tab descendant from the count", async () => {
    const outcome = await measureHtml(
      `<div style="display:none;"><button role="tab" ${WIDE_TAB_STYLE}>Buried</button></div>`,
    );
    expect(outcome.facts.elementsInspected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Generated content (KTD8).
// ---------------------------------------------------------------------------

describe("generated content", () => {
  test("rendered ::after with content yields generated-content-unsupported", async () => {
    const outcome = await measureHtml(
      `<style>.gen::after{content:"★";}</style>
       <button role="tab" ${WIDE_TAB_STYLE} class="gen">Pricing</button>`,
    );
    expect(outcome.failure?.code).toBe("generated-content-unsupported");
  });

  test("empty quoted generated content is allowed", async () => {
    const outcome = await measureHtml(
      `<style>.empty::after{content:"";}</style>
       <button role="tab" ${WIDE_TAB_STYLE} class="empty">Reports</button>`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(1);
  });

  test("generated content on a non-rendered owner is not a failure", async () => {
    const outcome = await measureHtml(
      `<style>.gen::after{content:"★";}</style>
       <button role="tab" class="gen" style="display:none;">Hidden Gen</button>`,
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error preservation (KTD8 / plan): mid-measurement exception and page close.
// ---------------------------------------------------------------------------

describe("error preservation", () => {
  test("a mid-measurement exception preserves prior facts as rule-script-failed", async () => {
    const page = await newPage();
    await page.setContent(
      `<!doctype html><html><body>
        <button role="tab" ${WIDE_TAB_STYLE} data-testid="first">First</button>
        <button role="tab" ${WIDE_TAB_STYLE} data-testid="boom">Boom</button>
      </body></html>`,
      { waitUntil: "load" },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const boom = document.querySelector('[data-testid="boom"]');
      if (boom) boom.getBoundingClientRect = () => {
        throw new Error("synthetic measurement failure");
      };
    });
    const outcome = await evaluateTabLabelSingleLine(page, RULE, "target");
    await page.close();
    expect(outcome.failure?.code).toBe("rule-script-failed");
    expect(outcome.facts.elementsInspected).toBe(1); // prior candidate preserved
  });

  test("a closed page yields empty facts and rule-script-failed", async () => {
    const page = await newPage();
    await page.setContent(
      `<!doctype html><html><body><button role="tab" ${WIDE_TAB_STYLE}>X</button></body></html>`,
      { waitUntil: "load" },
    );
    await page.close();
    const outcome = await evaluateTabLabelSingleLine(page, RULE, "target");
    expect(outcome.failure?.code).toBe("rule-script-failed");
    expect(outcome.facts.elementsInspected).toBe(0);
    expect(outcome.facts.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Locator preference and uniqueness (KTD9).
// ---------------------------------------------------------------------------

describe("locator preference and uniqueness", () => {
  test("a unique id is used as the locator", async () => {
    const outcome = await measureHtml(
      `<button role="tab" ${TAB_STYLE} id="save">Wrap Me Now Please</button>`,
    );
    expect(outcome.facts.violations[0]!.locator).toBe("#save");
  });

  test("a stable data attribute is used when id is shared", async () => {
    const outcome = await measureHtml(
      `<button role="tab" ${TAB_STYLE} id="dup">Wrap Label A</button>
       <button role="tab" ${TAB_STYLE} id="dup" data-testid="only-uniq">Wrap Label B</button>`,
    );
    const locators = outcome.facts.violations.map((v) => v.locator);
    expect(locators).toContain('[data-testid="only-uniq"]');
  });

  test("a semantic attribute is used when no id or data attribute is unique", async () => {
    const outcome = await measureHtml(
      `<button role="tab" ${TAB_STYLE} aria-label="settings">Settings Wrap Label</button>`,
    );
    expect(outcome.facts.violations[0]!.locator).toBe('[aria-label="settings"]');
  });

  test("the positional path is used when nothing shorter is unique", async () => {
    const outcome = await measureHtml(
      `<div role="tablist">
        <button role="tab" ${TAB_STYLE} id="dup" data-testid="dup">Wrap Label One</button>
        <button role="tab" ${TAB_STYLE} id="dup" data-testid="dup">Wrap Label Two</button>
      </div>`,
    );
    for (const violation of outcome.facts.violations) {
      expect(violation.locator).toContain(":nth-of-type(");
      expect(violation.locator).toContain(" > ");
    }
  });
});

// ---------------------------------------------------------------------------
// AE12 — determinism: repeated measurement of a fixed fixture is stable.
// AE13 — a violation locator re-resolves to exactly one element on the page.
// These run the served fixture (tabs.html).
// ---------------------------------------------------------------------------

describe("served fixture: determinism and locator re-resolution", () => {
  test("AE12 measuring the fixture twice yields identical facts", async () => {
    const a = await measureFixture();
    const b = await measureFixture();
    try {
      expect(b.outcome.facts.elementsInspected).toBe(a.outcome.facts.elementsInspected);
      expect(b.outcome.facts.violations.length).toBe(a.outcome.facts.violations.length);
      expect(b.outcome.facts.violations.map((v) => v.text)).toEqual(a.outcome.facts.violations.map((v) => v.text));
      expect(b.outcome.facts.violations.map((v) => v.lineCount)).toEqual(a.outcome.facts.violations.map((v) => v.lineCount));
      expect(b.outcome.facts.violations.map((v) => v.locator)).toEqual(a.outcome.facts.violations.map((v) => v.locator));
      expect(a.outcome.failure).toBeNull();
    } finally {
      await a.page.close();
      await b.page.close();
    }
  });

  test("AE13 every violation locator resolves to exactly one element with matching text", async () => {
    const { page, outcome } = await measureFixture();
    try {
      for (const violation of outcome.facts.violations) {
        const resolved = await page.evaluate((selector: string) => {
          const list = document.querySelectorAll(selector);
          if (list.length !== 1) return { count: list.length, text: null };
          const el = list[0] as HTMLElement;
          return { count: 1, text: (el.innerText ?? "").replace(/\s+/g, " ").trim() };
        }, violation.locator);
        expect(resolved.count, `locator "${violation.locator}"`).toBe(1);
        expect(resolved.text).toBe(violation.text);
      }
    } finally {
      await page.close();
    }
  });

  test("fixture excludes only intentional multi-line tabs when configured", async () => {
    const a = await measureFixture();
    const b = await measureFixture(ruleWith({ excludeSelectors: [".intentional-multiline"] }));
    try {
      expect(b.outcome.facts.elementsInspected).toBe(a.outcome.facts.elementsInspected - 1);
      expect(a.outcome.facts.violations.map((v) => v.text)).toContain("Deliberately Wrapped Long Label");
      expect(b.outcome.facts.violations.map((v) => v.text)).not.toContain("Deliberately Wrapped Long Label");
    } finally {
      await a.page.close();
      await b.page.close();
    }
  });
});
