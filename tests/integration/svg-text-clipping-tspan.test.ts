import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { evaluateSvgTextClipping } from "../../src/rules/svg-text-clipping";
import type { EffectiveSvgTextClippingRule } from "../../src/contracts/config";

let browser: Browser;
let page: Page;
const rule: EffectiveSvgTextClippingRule = {
  name: "svg-text-clipping", type: "svg-text-clipping", enabled: true, tolerancePx: 1, excludeSelectors: [],
};
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

test("a single leaf tspan counts its parent once and reports ink clipping", async () => {
  await page.setContent(`<style>body{margin:0}svg{font:20px monospace;overflow:hidden}</style>
    <svg width="100" height="400">
      <text id="fits" x="76" y="364" text-anchor="middle">
        <tspan x="76" dy="0.71em">8/3</tspan>
      </text>
      <text id="clipped" x="95" y="25"><tspan>MMMM</tspan></text>
    </svg>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.elementsInspected).toBe(2);
  expect(result.facts.violations.map((v) => [v.locator, v.directions])).toEqual([["#clipped", ["right"]]]);
});

test("unsupported tspan structures and positioning exclude the entire parent", async () => {
  const cases = [
    `<text><tspan>M</tspan><tspan>M</tspan></text>`,
    `<text><tspan><tspan>M</tspan></tspan></text>`,
    `<text>M<tspan>M</tspan></text>`,
    `<text><tspan>M</tspan>M</text>`,
    `<text><textPath>M</textPath></text>`,
    ...["x=\"90 100\"", "y=\"25 30\"", "dx=\"0 10\"", "dy=\"0 10\"", "rotate=\"0\"", "textLength=\"30\"",
      "dominant-baseline=\"hanging\"", "baseline-shift=\"10px\"", "style=\"filter:blur(0px)\"",
      "style=\"clip-path:inset(0px)\"", "style=\"display:none\"", "style=\"text-decoration:underline\""].flatMap((attribute) => [
      `<text ${attribute}><tspan>M</tspan></text>`,
      `<text><tspan ${attribute}>M</tspan></text>`,
    ]),
    `<text><tspan>M<tspan style="font-size:30px">M</tspan></tspan></text>`,
  ];
  for (const content of cases) {
    await page.setContent(`<svg width="100" height="40" style="font:20px monospace;overflow:hidden">${content}</svg>`);
    expect(await evaluateSvgTextClipping(page, rule), content).toEqual({
      facts: { elementsInspected: 0, violations: [] }, failure: null,
    });
  }
});

test("single tspan ink detects every edge and fully hidden text with parent diagnostics", async () => {
  for (const [x, y, direction] of [[-10, 25, "left"], [95, 25, "right"], [20, 5, "top"],
    [20, 50, "bottom"], [150, 25, "right"]] as const) {
    await page.setContent(`<svg id="viewport" width="100" height="40" style="font:20px monospace;overflow:hidden">
      <text id="label" x="${x}" y="${y}"><tspan>MMMM</tspan></text></svg>`);
    const result = await evaluateSvgTextClipping(page, rule);
    expect(result.failure).toBeNull();
    expect(result.facts.elementsInspected).toBe(1);
    expect(result.facts.violations).toHaveLength(1);
    expect(result.facts.violations[0]).toMatchObject({ locator: "#label", clipLocator: "#viewport", text: "MMMM", directions: [direction] });
    const overflow = result.facts.violations[0]!.overflowPx[direction];
    expect((await evaluateSvgTextClipping(page, { ...rule, tolerancePx: overflow })).facts.violations).toEqual([]);
  }
});

test("parent and leaf scalar positions and anchors share browser layout", async () => {
  for (const anchor of ["start", "middle", "end"]) {
    for (const positions of [
      `x="95" y="25" dx="0.5em" dy="-0.25em"`,
      `x="50" y="10"`,
    ]) {
      const leafPositions = positions.includes("dx") ? "" : `x="95" y="25" dx="0.5em" dy="-0.25em"`;
      await page.setContent(`<svg width="100" height="40" style="font:20px monospace;overflow:hidden">
        <text id="label" ${positions} text-anchor="${anchor}"><tspan ${leafPositions}>MMMM</tspan></text></svg>`);
      const nested = await evaluateSvgTextClipping(page, rule);
      expect(nested.failure).toBeNull();
      expect(nested.facts.elementsInspected).toBe(1);
      await page.setContent(`<svg width="100" height="40" style="font:20px monospace;overflow:hidden">
        <text id="label" x="105" y="20" text-anchor="${anchor}">MMMM</text></svg>`);
      expect(nested).toEqual(await evaluateSvgTextClipping(page, rule));
    }
  }
});

test("tspan transforms, outer clips, scroll reachability and exclusions keep existing contracts", async () => {
  for (const separated of [false, true]) {
    await page.setContent(`<style>body{margin:0}svg{display:block;font:20px monospace;overflow:visible}</style>
      <div id="outer" style="overflow:clip;width:100px;height:50px">
        <div style="overflow:auto;width:100px;height:50px;margin-left:${separated ? 150 : 0}px">
          <svg width="400" height="40" viewBox="0 0 200 20">
            <g transform="translate(5 0)"><text id="label" x="140" y="15" transform="scale(1.1)"><tspan>M</tspan></text></g>
          </svg>
        </div>
      </div>`);
    const result = await evaluateSvgTextClipping(page, rule);
    expect(result.failure).toBeNull();
    expect(result.facts.elementsInspected).toBe(1);
    expect(result.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual(
      separated ? [["#label", "#outer", ["right"]]] : [],
    );
    expect(await evaluateSvgTextClipping(page, { ...rule, excludeSelectors: ["#label"] })).toEqual({
      facts: { elementsInspected: 0, violations: [] }, failure: null,
    });
  }
});
