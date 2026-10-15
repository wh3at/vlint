import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import type { EffectiveSvgTextClippingRule } from "../../src/contracts/config";
import { evaluateSvgTextClipping } from "../../src/rules/svg-text-clipping";
import { svgTextClippingScene } from "../fixtures/svg-text-clipping";

let browser: Browser;
let page: Page;
const rule: EffectiveSvgTextClippingRule = {
  name: "svg-text-clipping", type: "svg-text-clipping", enabled: true, tolerancePx: 1, excludeSelectors: [],
};

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => { await browser.close(); });

test("translating text and all clipping ancestors preserves counts, directions and overflow", async () => {
  const content = `<div id="outer" style="overflow:hidden;width:100px;height:60px">
    <svg id="viewport" width="80" height="40" style="overflow:hidden"><text id="label" x="70" y="25">MMMM</text></svg>
  </div>`;
  await page.setContent(svgTextClippingScene(content));
  const baseline = await evaluateSvgTextClipping(page, rule);
  expect(baseline.failure).toBeNull();
  expect(baseline.facts.elementsInspected).toBe(1);
  expect(baseline.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual([
    ["#label", "#viewport", ["right"]], ["#label", "#outer", ["right"]],
  ]);
  for (const offset of [{ x: 37, y: 23 }, { x: -19, y: 41 }]) {
    await page.setContent(svgTextClippingScene(content, offset));
    const translated = await evaluateSvgTextClipping(page, rule);
    expect(translated.failure).toBeNull();
    expect(translated.facts.elementsInspected).toBe(1);
    expect(translated.facts.violations).toEqual(baseline.facts.violations.map((v) => ({
      ...v,
      geometry: { ...v.geometry, x: v.geometry.x + offset.x, y: v.geometry.y + offset.y },
      clipGeometry: { ...v.clipGeometry, x: v.clipGeometry.x + offset.x, y: v.clipGeometry.y + offset.y },
    })));
  }
});

test.each([
  { direction: "left", placements: [{ x: -90, y: 0, clipped: false }, { x: -100, y: 0, clipped: true }, { x: -110, y: 0, clipped: true }] },
  { direction: "right", placements: [{ x: 90, y: 0, clipped: false }, { x: 100, y: 0, clipped: true }, { x: 110, y: 0, clipped: true }] },
  { direction: "top", placements: [{ x: 0, y: -50, clipped: false }, { x: 0, y: -60, clipped: true }, { x: 0, y: -70, clipped: true }] },
  { direction: "bottom", placements: [{ x: 0, y: 50, clipped: false }, { x: 0, y: 60, clipped: true }, { x: 0, y: 70, clipped: true }] },
])("$direction scrollport: positive overlap is reachable, touching and separation are not", async ({ direction, placements }) => {
  for (const offset of [{ x: 0, y: 0 }, { x: 17, y: 29 }]) {
    for (const placement of placements) {
      const content = `<div id="outer" style="overflow:clip;width:100px;height:60px;display:flow-root">
        <div style="overflow:auto;width:100px;height:60px;margin-left:${placement.x}px;margin-top:${placement.y}px">
          <svg width="400" height="240" style="overflow:visible"><text id="label" x="200" y="100">M</text></svg>
        </div>
      </div>`;
      await page.setContent(svgTextClippingScene(content, offset));
      const result = await evaluateSvgTextClipping(page, rule);
      expect(result.failure).toBeNull();
      expect(result.facts.elementsInspected).toBe(1);
      expect(result.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual(
        placement.clipped ? [["#label", "#outer", [direction]]] : [],
      );
    }
  }
});

test("equal numeric components in px and percent do not imply equal supported viewport geometry", async () => {
  const scene = (unit: "px" | "%") => `<svg width="200" height="60" style="overflow:hidden">
    <svg id="viewport" x="50" width="40" height="40" style="x:50${unit};overflow:hidden">
      <text id="label" x="35" y="25">MMMM</text>
    </svg>
  </svg>`;
  await page.setContent(svgTextClippingScene(scene("px")));
  const pixels = await evaluateSvgTextClipping(page, rule);
  expect(pixels.failure).toBeNull();
  expect(pixels.facts.elementsInspected).toBe(1);
  expect(pixels.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual([
    ["#label", "#viewport", ["right"]],
  ]);
  await page.setContent(svgTextClippingScene(scene("%")));
  expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
});

test.each([
  "clip-path:inset(0px)",
  "mask-image:linear-gradient(black,black)",
  "overflow:auto;border-radius:12px",
  "filter:blur(0px)",
])("adding unsupported %s excludes the entire otherwise clipped text", async (unsupportedStyle) => {
  const scene = (extraStyle: string) => `<div id="outer" style="overflow:hidden;width:100px;height:60px;${extraStyle}">
    <svg id="viewport" width="100" height="40" style="overflow:hidden"><text id="label" x="90" y="25">MMMM</text></svg>
  </div>`;
  await page.setContent(svgTextClippingScene(scene("")));
  const supported = await evaluateSvgTextClipping(page, rule);
  expect(supported.failure).toBeNull();
  expect(supported.facts.elementsInspected).toBe(1);
  expect(supported.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual([
    ["#label", "#viewport", ["right"]], ["#label", "#outer", ["right"]],
  ]);
  await page.setContent(svgTextClippingScene(scene(unsupportedStyle)));
  expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
});
