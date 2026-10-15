import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { evaluateSvgTextClipping } from "../../src/rules/svg-text-clipping";
import type { EffectiveSvgTextClippingRule } from "../../src/contracts/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/app/server";
import { runCheckCommand } from "../../src/commands/check";
import { renderTerminal } from "../../src/output/terminal";

let server: FixtureServer;

let browser: Browser;
let page: Page;
const rule: EffectiveSvgTextClippingRule = {
  name: "svg-text-clipping", type: "svg-text-clipping", enabled: true, tolerancePx: 1, excludeSelectors: [],
};
beforeAll(async () => { server = startFixtureServer(); browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); await server?.close(); });

test("measures ink clipped by each SVG viewport edge including fully hidden text", async () => {
  await page.setContent(`<style>body{margin:0}svg{display:block;font:20px monospace;overflow:hidden}</style>
    <svg id="viewport" width="100" height="40">
      <text id="left" x="-10" y="25">MMMM</text>
      <text id="right" x="90" y="25">MMMM</text>
      <text id="top" x="20" y="5">MMMM</text>
      <text id="bottom" x="20" y="50">MMMM</text>
      <text id="fully" x="200" y="25">MMMM</text>
      <text id="fits" x="20" y="25">MMMM</text>
    </svg>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.elementsInspected).toBe(6);
  expect(result.facts.violations.map((v) => [v.locator, v.clipLocator, v.directions])).toEqual([
    ["#left", "#viewport", ["left"]], ["#right", "#viewport", ["right"]],
    ["#top", "#viewport", ["top"]], ["#bottom", "#viewport", ["bottom"]],
    ["#fully", "#viewport", ["right"]],
  ]);
  expect(result.facts.violations[0]).toMatchObject({
    text: "MMMM", tolerancePx: 1, clipGeometry: { x: 0, y: 0, width: 100, height: 40 },
    overflowPx: { left: expect.any(Number), right: 0, top: 0, bottom: 0 },
  });
});

test("maps viewBox and scaled text to multiple HTML padding-box clips", async () => {
  await page.setContent(`<style>body{margin:0}svg{display:block;font:20px monospace;overflow:visible}</style>
    <div id="outer" style="width:130px;height:100px;overflow:hidden;border:5px solid;padding:10px">
      <div id="inner" style="width:100px;height:70px;overflow:clip;padding:5px;border:3px solid;transform:scale(1.5);transform-origin:0 0">
        <svg width="100" height="60" viewBox="0 0 50 30"><text id="scaled" x="45" y="15">MMMM</text></svg>
      </div>
    </div>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.elementsInspected).toBe(1);
  expect(result.facts.violations.map((v) => v.clipLocator)).toEqual(["#inner", "#outer"]);
  expect(result.facts.violations[0]?.clipGeometry).toEqual({ x: 19.5, y: 19.5, width: 165, height: 120 });
  expect(result.facts.violations[1]?.clipGeometry).toEqual({ x: 5, y: 5, width: 150, height: 120 });
  expect(result.facts.violations[0]?.geometry.x).toBeGreaterThan(150);
  expect(result.facts.violations[0]?.geometry.width).toBeGreaterThan(130);
});

test("unsupported layouts and mixed clip mechanisms are silent and not inspected", async () => {
  const cases = [
    `<text x="90 120" y="25">MMMM</text>`,
    `<text x="90" y="25" dx="0 30">MMMM</text>`,
    `<text x="90" y="25" textLength="100">MMMM</text>`,
    `<text x="90" y="25"><tspan>MMMM</tspan></text>`,
    `<text x="90" y="25" stroke="black">MMMM</text>`,
    `<text x="90" y="25" dominant-baseline="middle">MMMM</text>`,
    `<text x="90" y="25" transform="rotate(5)">MMMM</text>`,
    `<text x="90" y="25" transform="skewX(10)">MMMM</text>`,
    `<text x="90" y="25" transform="scale(-1 1)">MMMM</text>`,
    `<g clip-path="url(#clip)"><text x="90" y="25">MMMM</text></g>`,
    `<g mask="url(#mask)"><text x="90" y="25">MMMM</text></g>`,
    `<g style="clip-path:inset(1px)"><text x="90" y="25">MMMM</text></g>`,
    `<g style="filter:blur(1px)"><text x="90" y="25">MMMM</text></g>`,
  ];
  for (const content of cases) {
    await page.setContent(`<svg style="font:20px monospace;overflow:hidden" width="100" height="40">${content}</svg>`);
    const result = await evaluateSvgTextClipping(page, rule);
    expect(result).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
  }
});

test("ignores non-painted text, visible overflow and normally scrollable regions", async () => {
  await page.setContent(`<style>body{margin:0}svg{font:20px monospace;overflow:visible;display:block}</style>
    <svg width="100" height="40">
      <text id="visible" x="90" y="25">MMMM</text>
      <text x="90" y="25" display="none">MMMM</text>
      <text x="90" y="25" visibility="hidden">MMMM</text>
      <g opacity="0"><text x="90" y="25">MMMM</text></g>
      <text x="90" y="25" fill="none">MMMM</text>
      <text x="90" y="25"> </text>
      <defs><text x="90" y="25">MMMM</text></defs>
      <symbol><text x="90" y="25">MMMM</text></symbol>
    </svg>
    <div style="overflow:hidden;width:110px"><div id="scroll" style="overflow:auto;width:100px;height:50px">
      <svg width="400" height="40"><text id="reachable" x="300" y="25">MMMM</text></svg>
    </div></div>`);
  for (const scrollLeft of [0, 200]) {
    await page.evaluate((value) => { document.getElementById("scroll")!.scrollLeft = value; }, scrollLeft);
    const result = await evaluateSvgTextClipping(page, rule);
    expect(result.failure).toBeNull();
    expect(result.facts.violations).toEqual([]);
    expect(result.facts.elementsInspected).toBe(2);
  }
});

test("exclusions remove candidates and invalid selectors fail even on an empty page", async () => {
  await page.setContent(`<svg width="100" height="40" style="font:20px monospace;overflow:hidden">
    <text id="exclude" x="90" y="25">MMMM</text><text id="keep" x="90" y="25">MMMM</text></svg>`);
  const result = await evaluateSvgTextClipping(page, { ...rule, excludeSelectors: ["#exclude"] });
  expect(result.failure).toBeNull();
  expect(result.facts.elementsInspected).toBe(1);
  expect(result.facts.violations.map((v) => v.locator)).toEqual(["#keep"]);
  await page.setContent("<main></main>");
  expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
  expect((await evaluateSvgTextClipping(page, { ...rule, excludeSelectors: ["["] })).failure?.code).toBe("exclude-selector-invalid");
});

test("measurement failure does not fall back to SVG character cells", async () => {
  await page.setContent(`<svg width="100" height="40" style="font:20px monospace;overflow:hidden"><text x="90" y="25">MMMM</text></svg>`);
  await page.evaluate(() => {
    CanvasRenderingContext2D.prototype.measureText = () => { throw new Error("measurement unavailable"); };
  });
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure?.code).toBe("geometry-evaluation-failed");
  expect(result.facts.violations).toEqual([]);
  await page.close();
  page = await browser.newPage();
});

test("default CLI evaluation reports clipping and target overrides preserve failure contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlint-svg-"));
  const device = { name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 },
    deviceScaleFactor: 1, isMobile: false, hasTouch: false };
  const url = `${server.url}/svg-text-clipping.html`;
  const save = async (extra: object) => Bun.write(join(directory, "vlint.config.json"), JSON.stringify({ devices: [device], ...extra }));
  try {
    await save({});
    const result = await runCheckCommand(directory, url, {}, "test");
    expect(result.status).toBe("violations");
    const svg = result.cases[0]?.rules.find((r) => r.type === "svg-text-clipping");
    expect(svg?.elementsInspected).toBe(2);
    expect(svg?.violations.map((v) => v.locator)).toEqual(["#label"]);
    expect(renderTerminal(result)).toContain("locator=#label clip=#viewport directions=right");
    expect(JSON.stringify(result)).toContain('"clipGeometry"');
    await save({ provider: { type: "static", targets: [
      { name: "off", url, ruleOverrides: { "svg-text-clipping": { enabled: false } } },
      { name: "excluded", url, ruleOverrides: { "svg-text-clipping": { excludeSelectors: ["#label"] } } },
      { name: "minimum", url, ruleOverrides: { "svg-text-clipping": { excludeSelectors: ["svg"], minimumInspected: 1 } } },
      { name: "invalid", url, ruleOverrides: { "svg-text-clipping": { excludeSelectors: ["["] } } },
    ] } });
    const overridden = await runCheckCommand(directory, null, {}, "test");
    expect(overridden.status).toBe("incomplete");
    const rules = overridden.cases.map((c) => c.rules.find((r) => r.type === "svg-text-clipping")!);
    expect(rules[0]?.status).toBe("disabled");
    expect(rules[1]).toMatchObject({ status: "clean", elementsInspected: 1, violations: [] });
    expect(rules[2]).toMatchObject({ status: "failed", elementsInspected: 0, violations: [] });
    expect(rules[3]?.failure?.code).toBe("exclude-selector-invalid");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tolerance is CSS pixels with an exclusive boundary", async () => {
  await page.setContent(`<style>body{margin:0}svg{font:20px monospace;overflow:hidden}</style>
    <svg width="100" height="40"><text x="90" y="25">MMMM</text></svg>`);
  const measured = await evaluateSvgTextClipping(page, { ...rule, tolerancePx: 0 });
  const overflow = measured.facts.violations[0]!.overflowPx.right;
  expect(overflow).toBeGreaterThan(1);
  expect((await evaluateSvgTextClipping(page, { ...rule, tolerancePx: overflow })).facts.violations).toEqual([]);
  expect((await evaluateSvgTextClipping(page, { ...rule, tolerancePx: overflow - 0.01 })).facts.violations).toHaveLength(1);
});

test("ink bounds track painted SVG pixels across anchors, viewBox and scale at DPR 1 and 2", async () => {
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ deviceScaleFactor, viewport: { width: 800, height: 600 } });
    const canvasPage = await context.newPage();
    const directory = await mkdtemp(join(tmpdir(), "vlint-svg-image-"));
    try {
      await canvasPage.goto(`${server.url}/svg-text-clipping.html`);
      await canvasPage.evaluate(async () => { await document.fonts.ready; });
      const placements = [
        { x: 20, y: 38, anchor: "start", transform: "", viewBox: "0 0 100 40", clipped: false },
        { x: 90, y: 25, anchor: "start", transform: "", viewBox: "0 0 100 40", clipped: true },
        { x: 10, y: 25, anchor: "end", transform: "", viewBox: "0 0 100 40", clipped: true },
        { x: 30, y: 5, anchor: "middle", transform: "", viewBox: "0 0 100 40", clipped: true },
        { x: 30, y: 48, anchor: "middle", transform: "", viewBox: "0 0 100 40", clipped: true },
        { x: 45, y: 15, anchor: "start", transform: "translate(2 0) scale(1.2)", viewBox: "0 0 50 20", clipped: true },
      ];
      for (const [index, placement] of placements.entries()) {
        await canvasPage.evaluate((value) => {
          const svg = document.querySelector("svg")!;
          svg.innerHTML = `<text id="ink" x="${value.x}" y="${value.y}" text-anchor="${value.anchor}" transform="${value.transform}">M</text>`;
          svg.setAttribute("viewBox", value.viewBox);
          svg.style.margin = "100px";
          svg.style.overflow = "hidden";
        }, placement);
        const result = await evaluateSvgTextClipping(canvasPage, { ...rule, tolerancePx: 0 });
        expect(result.failure).toBeNull();
        expect(result.facts.elementsInspected).toBe(1);
        expect(result.facts.violations.length > 0).toBe(placement.clipped);
        const capture = async (name: string) => {
          const path = join(directory, `${index}-${name}.png`);
          let captured = false;
          for (let attempt = 0; attempt < 2 && !captured; attempt++) {
            captured = await canvasPage.screenshot({ path }).then(() => true, () => false);
          }
          if (!captured) throw new Error("Screenshot capture failed");
          return (await Bun.file(path).bytes()).toBase64();
        };
        const clipped = await capture("clipped");
        const cellBottom = await canvasPage.evaluate(() => {
          const text = document.querySelector("text")!;
          return text.getBoundingClientRect().bottom;
        });
        await canvasPage.evaluate(() => { document.querySelector("svg")!.style.overflow = "visible"; });
        const unclipped = await capture("unclipped");
        const pixels = await canvasPage.evaluate(async ({ clipped, unclipped, dpr }) => {
          const read = async (data: string) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(image, 0, 0);
            return ctx.getImageData(0, 0, image.width, image.height);
          };
          const a = await read(clipped);
          const b = await read(unclipped);
          let changed = 0, left = b.width, right = 0, top = b.height, bottom = 0;
          for (let y = 0; y < b.height; y++) {
            for (let x = 0; x < b.width; x++) {
              const offset = (y * b.width + x) * 4;
              if (a.data[offset] !== b.data[offset]) changed++;
              if (b.data[offset]! < 200) {
                left = Math.min(left, x); right = Math.max(right, x + 1);
                top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
              }
            }
          }
          return { changed, x: left / dpr, y: top / dpr, right: right / dpr, bottom: bottom / dpr };
        }, { clipped, unclipped, dpr: deviceScaleFactor });
        expect(pixels.changed > 0).toBe(placement.clipped);
        if (placement.clipped) {
          const box = result.facts.violations[0]!.geometry;
          const rasterAllowancePx = index === 5 ? 2.5 : 1.5;
          expect(Math.abs(box.x - pixels.x)).toBeLessThanOrEqual(rasterAllowancePx);
          expect(Math.abs(box.y - pixels.y)).toBeLessThanOrEqual(rasterAllowancePx);
          expect(Math.abs(box.x + box.width - pixels.right)).toBeLessThanOrEqual(rasterAllowancePx);
          expect(Math.abs(box.y + box.height - pixels.bottom)).toBeLessThanOrEqual(1.5);
        } else {
          expect(cellBottom).toBeGreaterThan(140);
          expect(pixels.bottom).toBeLessThanOrEqual(140);
        }
      }
    } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
  }
}, 30_000);

test("strict CSP does not prevent SVG locator extraction", async () => {
  const isolated = await browser.newPage();
  try {
    await isolated.setContent(`<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
      <svg width="100" height="40" style="font:20px monospace;overflow:hidden"><text x="90" y="25">MMMM</text></svg>`);
    const result = await evaluateSvgTextClipping(isolated, rule);
    expect(result.failure).toBeNull();
    expect(result.facts.violations).toHaveLength(1);
    expect(await isolated.locator(result.facts.violations[0]!.locator).count()).toBe(1);
  } finally { await isolated.close(); }
});

test("scroll reachability does not hide an outer clip that no scroll position can escape", async () => {
  await page.setContent(`<style>body{margin:0}svg{font:20px monospace;overflow:visible;display:block}</style>
    <div id="outer" style="overflow:clip;width:100px;height:50px">
      <div style="overflow:auto;width:100px;height:50px;margin-left:150px">
        <svg width="400" height="40"><text x="300" y="25">MMMM</text></svg>
      </div>
    </div>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.violations.map((v) => [v.clipLocator, v.directions])).toEqual([["#outer", ["right"]]]);
});

test("SVG viewport clips use content bounds rather than bordered or padded element bounds", async () => {
  await page.setContent(`<style>body{margin:0}svg{display:block;font:20px monospace;overflow:hidden}</style>
    <svg id="root" width="100" height="40" style="border:4px solid;padding:6px">
      <text id="root-text" x="90" y="25">MMMM</text>
      <svg id="nested" x="20" y="0" width="40" height="40" viewBox="0 0 40 40">
        <text id="nested-text" x="35" y="25">M</text>
      </svg>
    </svg>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.violations.map((v) => [v.locator, v.clipLocator, v.clipGeometry])).toEqual([
    ["#root-text", "#root", { x: 10, y: 10, width: 100, height: 40 }],
    ["#nested-text", "#nested", { x: 30, y: 10, width: 40, height: 40 }],
  ]);
});

test("zero-sized SVG viewports and transparent fills are not painted candidates", async () => {
  await page.setContent(`<style>svg{font:20px monospace;overflow:hidden}</style>
    <svg width="0" height="40"><text x="90" y="25">MMMM</text></svg>
    <svg width="100" height="0"><text x="90" y="25">MMMM</text></svg>
    <svg width="100" height="40"><text x="90" y="25" fill="transparent">MMMM</text></svg>`);
  expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
});

test("unmodelled nested viewport transforms, bidi and escaping positioned SVG are excluded as a whole", async () => {
  const contents = [
    `<svg width="100" height="40"><svg x="20" width="40" height="40" transform="scale(2)"><text x="35" y="25">MMMM</text></svg></svg>`,
    `<svg width="100" height="40"><text x="90" y="25">مرحبا</text></svg>`,
    `<div style="width:100px;height:40px;overflow:hidden"><svg style="position:absolute" width="200" height="40"><text x="90" y="25">MMMM</text></svg></div>`,
    `<svg width="100" height="40"><foreignObject width="100" height="40"><div><svg width="100" height="40"><text x="90" y="25">MMMM</text></svg></div></foreignObject></svg>`,
  ];
  for (const content of contents) {
    await page.setContent(`<style>svg{font:20px monospace;overflow:hidden}</style>${content}`);
    expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
  }
});

test("outer clipping cannot be escaped by scrolling ink out of its scrollport", async () => {
  await page.setContent(`<style>body{margin:0}svg{font:20px monospace;overflow:visible;display:block}</style>
    <div id="outer" style="overflow:clip;width:100px;height:50px">
      <div style="overflow:auto;width:100px;height:50px;margin-left:150px">
        <svg width="400" height="40"><text x="20" y="25">MMMM</text></svg>
      </div>
    </div>`);
  const result = await evaluateSvgTextClipping(page, rule);
  expect(result.failure).toBeNull();
  expect(result.facts.violations.map((v) => [v.clipLocator, v.directions])).toEqual([["#outer", ["right"]]]);
});

test("rounded scrollports exclude text even when another rectangular viewport clips it", async () => {
  await page.setContent(`<div style="overflow:auto;border-radius:20px;width:100px;height:40px">
    <svg width="400" height="40" style="font:20px monospace;overflow:hidden"><text x="390" y="25">MMMM</text></svg>
    </div>`);
  expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
});

test("CSS-overridden nested viewport geometry and CSS text stroke are outside the measured subset", async () => {
  for (const content of [
    `<svg width="200" height="40"><svg width="100" height="40" style="x:100px"><text x="20" y="25">MMMM</text></svg></svg>`,
    `<svg width="100" height="40"><text x="90" y="25" style="-webkit-text-stroke:2px black">MMMM</text></svg>`,
  ]) {
    await page.setContent(`<style>svg{font:20px monospace;overflow:hidden}</style>${content}`);
    expect(await evaluateSvgTextClipping(page, rule)).toEqual({ facts: { elementsInspected: 0, violations: [] }, failure: null });
  }
});
