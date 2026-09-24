import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { evaluateTableCellTextOverlap } from "../../src/rules/table-cell-text-overlap";
import { runCheckCommand } from "../../src/commands/check";
import { renderTerminal } from "../../src/output/terminal";
import { startFixtureServer, type FixtureServer } from "../fixtures/app/server";

let server: FixtureServer;
let directory: string;

beforeAll(async () => {
  server = startFixtureServer();
  directory = await mkdtemp(join(tmpdir(), "vlint-cell-"));
  const devices = [800, 390].map((width) => ({
    name: String(width), viewport: { width, height: 720 }, screen: { width, height: 720 },
    deviceScaleFactor: 1, isMobile: false, hasTouch: false,
  }));
  await Bun.write(join(directory, "vlint.config.json"), JSON.stringify({
    devices,
    rules: [{ name: "tab-label-single-line", type: "tab-label-single-line", allowZeroLabels: true }],
  }));
});

afterAll(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

test("default check detects visible cell text overlap without page overflow at narrow viewport", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap.html`, {}, "test");
  expect(result.status).toBe("violations");
  const desktop = result.cases.find((item) => item.device.name === "800")!;
  const phone = result.cases.find((item) => item.device.name === "390")!;
  expect(desktop.status).toBe("complete");
  expect(desktop.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations).toEqual([]);
  expect(phone.status).toBe("complete");
  expect(phone.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  expect(phone.rules.find((rule) => rule.type === "table-header-single-line")?.violations).toEqual([]);
  const overlaps = phone.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  expect(overlaps).toEqual([
    expect.objectContaining({ locator: "#native-row", adjacentLocator: "#native-neighbor", overlapPx: expect.any(Number), geometry: expect.any(Object) }),
    expect.objectContaining({ locator: "#native-body", adjacentLocator: "#body-neighbor", overlapPx: expect.any(Number) }),
    expect.objectContaining({ locator: "#aria-row", adjacentLocator: "#aria-neighbor", overlapPx: expect.any(Number) }),
    expect.objectContaining({ locator: "#aria-body", adjacentLocator: "#aria-body-neighbor", overlapPx: expect.any(Number) }),
  ]);
  expect(overlaps.every((item) => "overlapPx" in item && typeof item.overlapPx === "number" && item.overlapPx > 1)).toBe(true);
  expect(renderTerminal(result)).toContain("locator=#native-row adjacent=#native-neighbor overlap=");
  expect(JSON.stringify(result)).toContain('"adjacentLocator":"#native-neighbor"');
});

test("positioned text escaping cell overflow is measured, while clipped text is ignored", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-edges.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  expect(narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations).toEqual([
    expect.objectContaining({ locator: "#spanning", adjacentLocator: "#second-row-neighbor" }),
    expect.objectContaining({ locator: "#positioned-body", adjacentLocator: "#positioned-neighbor" }),
    expect.objectContaining({ locator: "#positioned-outside", adjacentLocator: "#outside-neighbor" }),
    expect.objectContaining({ locator: "#escapes-overflow", adjacentLocator: "#overflow-neighbor" }),
  ]);
});

test("detects painted glyphs across separated cells without treating blank or clipped ranges as ink", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-review.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  const violations = narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  expect(violations.filter((item) => item.type === "table-cell-text-overlap")
    .map((item) => [item.locator, item.adjacentLocator])).toEqual([
    ["#vertical-down", "#vertical-neighbor"],
    ["#contents", "#contents-neighbor"],
    ["#shadow", "#shadow-neighbor"],
    ["#stroke", "#stroke-neighbor"],
    ["#vertical-up", "#above-neighbor"],
    ["#hidden-ancestor", "#hidden-neighbor"],
    ["#inset-round", "#inset-round-neighbor"],
  ]);
});

test("transformed and shaped clips decide the visible text", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-clipping.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  const violations = narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  expect(violations.filter((item) => item.type === "table-cell-text-overlap")
    .map((item) => [item.locator, item.adjacentLocator])).toEqual([
    ["#rounded-edge", "#rounded-edge-neighbor"],
    ["#scaled-up", "#scaled-up-neighbor"],
    ["#circle-default", "#circle-default-neighbor"],
    ["#ellipse-default", "#ellipse-default-neighbor"],
    ["#round-inflated", "#round-inflated-neighbor"],
    ["#path-visible", "#path-visible-neighbor"],
    ["#url-visible", "#url-visible-neighbor"],
  ]);
});

test("clip-path references and normalised corners decide the visible text", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-clip-shapes.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  const violations = narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  // A negative radius is an SVG error. The circle draws nothing, so the text it hides must stay
  // silent; the ellipse is drawn with the other axis' radius, as the browser renders it, so the
  // sliver of text the shape keeps is still measured. Neither may fail the page evaluation.
  expect(violations.filter((item) => item.type === "table-cell-text-overlap")
    .map((item) => [item.locator, item.adjacentLocator])).toEqual([
    ["#round-inset", "#round-inset-neighbor"],
    ["#path-wide", "#path-wide-neighbor"],
    ["#url-round-rect", "#url-round-rect-neighbor"],
    ["#obb-full", "#obb-full-neighbor"],
    ["#url-negative-rx", "#url-negative-rx-neighbor"],
  ]);
  // Corner radii shrink against the inset rectangle, not the element box, so more of
  // the clipped text stays visible than a 40px radius would allow.
  const rounded = violations.find((item) => item.locator === "#round-inset");
  expect(rounded?.type === "table-cell-text-overlap" && rounded.overlapPx).toBeGreaterThan(25);
});

test("a rounded overflow clip hides the corner it cuts and keeps the straight edge beside it", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-overflow-radius.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  const violations = narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  // `overflow` clips at the padding box and `border-radius` rounds that clip. The first row's
  // text sits only under the r=40 corner the clip cuts away, so nothing reaches the neighbour
  // there and no collision is reported. The second row crosses the straight edge below the
  // corner, and the third repeats the first row's placement under a square clip: both report.
  expect(violations.filter((item) => item.type === "table-cell-text-overlap")
    .map((item) => [item.locator, item.adjacentLocator])).toEqual([
    ["#radius-middle", "#radius-middle-neighbor"],
    ["#square-corner", "#square-corner-neighbor"],
  ]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.goto(`${server.url}/table-cell-text-overlap-overflow-radius.html`);
    const fragments = await page.evaluate((ids: string[]) => ids.map((id) => {
      const text = document.getElementById(`${id}-text`)!;
      const cell = document.getElementById(id)!.getBoundingClientRect();
      const neighbor = document.getElementById(`${id}-neighbor`)!.getBoundingClientRect();
      const clip = text.parentElement!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text.firstChild!);
      const rect = range.getBoundingClientRect();
      return {
        id,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        // Every fragment passes its own cell's edge, so only the clip decides what it paints.
        pastCellEdge: rect.right > cell.right,
        overNeighbor: rect.left >= neighbor.left,
        insideCornerBand: rect.bottom - clip.top <= 40,
      };
    }), ["radius-corner", "radius-middle", "square-corner"]);
    expect(fragments.map(({ id, pastCellEdge, overNeighbor, insideCornerBand }) =>
      ({ id, pastCellEdge, overNeighbor, insideCornerBand }))).toEqual([
      { id: "radius-corner", pastCellEdge: true, overNeighbor: true, insideCornerBand: true },
      { id: "radius-middle", pastCellEdge: true, overNeighbor: true, insideCornerBand: false },
      { id: "square-corner", pastCellEdge: true, overNeighbor: true, insideCornerBand: true },
    ]);
    // Painted pixels rather than layout boxes: the rounded clip leaves the neighbour blank
    // where the square clip inks it. Bun's test runner refuses the first capture of a fresh
    // browser often enough to need one retry.
    const media = await mkdtemp(join(tmpdir(), "vlint-overflow-radius-"));
    const file = join(media, "cells.png");
    let captured = false;
    for (let attempt = 0; attempt < 2 && !captured; attempt++) {
      captured = await page.screenshot({ path: file }).then(() => true, () => false);
      if (!captured) await Bun.sleep(100);
    }
    expect(captured).toBe(true);
    const shot = (await Bun.file(file).bytes()).toBase64();
    await rm(media, { recursive: true, force: true });
    const ink = await page.evaluate(async ({ data, rects }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return rects.map(({ left, top, width, height }) => {
        const pixels = context.getImageData(Math.floor(left) - 2, Math.floor(top) - 2,
          Math.ceil(width) + 4, Math.ceil(height) + 4).data;
        let painted = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 750) painted += 1;
        }
        return painted;
      });
    }, { data: shot, rects: fragments.map((fragment) => fragment.rect) });
    expect(ink[0]).toBe(0);
    expect(ink[1]).toBeGreaterThan(0);
    expect(ink[2]).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test("keeps asymmetric, elliptical and one-axis overflow clips aligned with the painted text", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-overflow-radius-edges.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  const violations = narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations ?? [];
  // `border-top-right-radius` rounds one corner, so text under that arc stays hidden while text
  // below it reaches the neighbour. `4px / 40px` is elliptical: the flat horizontal radius ends
  // at the wrapper's right edge and never reaches the text, which stays measured. And
  // `overflow-x: clip` beside `overflow-y: visible` keeps the y axis open, so text spilling into
  // the next row counts.
  expect(violations.filter((item) => item.type === "table-cell-text-overlap")
    .map((item) => [item.locator, item.adjacentLocator])).toEqual([
    ["#asymmetric-edge", "#asymmetric-edge-neighbor"],
    ["#ellipse-flat", "#ellipse-flat-neighbor"],
    ["#clip-axis", "#clip-axis-next"],
  ]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.goto(`${server.url}/table-cell-text-overlap-overflow-radius-edges.html`);
    const ids = ["asymmetric-corner", "asymmetric-edge", "ellipse-flat", "clip-axis"];
    const fragments = await page.evaluate((names: string[]) => names.map((id) => {
      const text = document.getElementById(`${id}-text`)!;
      const cell = document.getElementById(id)!.getBoundingClientRect();
      const neighbor = document.getElementById(`${id}-neighbor`)!.getBoundingClientRect();
      const clip = text.parentElement!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text.firstChild!);
      const rect = range.getBoundingClientRect();
      return {
        id,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        // Only the one-axis row reaches its neighbour below: it starts below its clip box, where
        // the visible y axis lets it out. The corner rows pass their own cell's edge instead, so
        // only the clip decides what they paint.
        pastCellEdge: rect.right > cell.right,
        overNeighbor: rect.left >= neighbor.left,
        insideCornerBand: rect.top - clip.top < 40,
        belowClip: rect.top >= clip.bottom,
      };
    }), ids);
    expect(fragments.map(({ id, pastCellEdge, overNeighbor, insideCornerBand, belowClip }) =>
      ({ id, pastCellEdge, overNeighbor, insideCornerBand, belowClip }))).toEqual([
      { id: "asymmetric-corner", pastCellEdge: true, overNeighbor: true, insideCornerBand: true, belowClip: false },
      { id: "asymmetric-edge", pastCellEdge: true, overNeighbor: true, insideCornerBand: false, belowClip: false },
      { id: "ellipse-flat", pastCellEdge: true, overNeighbor: true, insideCornerBand: true, belowClip: false },
      { id: "clip-axis", pastCellEdge: false, overNeighbor: false, insideCornerBand: false, belowClip: true },
    ]);
    // Painted pixels rather than layout boxes: the arc leaves the first row blank while the
    // browser inks the other three. Bun's test runner refuses the first capture of a fresh
    // browser often enough to need one retry.
    const media = await mkdtemp(join(tmpdir(), "vlint-overflow-radius-edges-"));
    const file = join(media, "cells.png");
    let captured = false;
    for (let attempt = 0; attempt < 2 && !captured; attempt++) {
      captured = await page.screenshot({ path: file }).then(() => true, () => false);
      if (!captured) await Bun.sleep(100);
    }
    expect(captured).toBe(true);
    const shot = (await Bun.file(file).bytes()).toBase64();
    await rm(media, { recursive: true, force: true });
    const ink = await page.evaluate(async ({ data, rects }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return rects.map(({ left, top, width, height }) => {
        const pixels = context.getImageData(Math.floor(left) - 2, Math.floor(top) - 2,
          Math.ceil(width) + 4, Math.ceil(height) + 4).data;
        let painted = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 750) painted += 1;
        }
        return painted;
      });
    }, { data: shot, rects: fragments.map((fragment) => fragment.rect) });
    expect(ink[0]).toBe(0);
    expect(ink[1]).toBeGreaterThan(0);
    expect(ink[2]).toBeGreaterThan(0);
    expect(ink[3]).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test("measures a table hosted in an overlay while an overlay inside a cell stays silent", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        table { table-layout: fixed; width: 240px; border-collapse: collapse; }
        td { padding: 0; height: 40px; white-space: nowrap; }
        [role="dialog"] { position: fixed; left: 0; top: 0; }
      </style>
      <div role="dialog" aria-label="modal">
        <table>
          <tr><td id="dialog-cell">VeryLongUnbrokenPropertyIdentifier</td><td id="dialog-neighbor">1</td></tr>
          <tr><td id="dialog-tooltip-cell" style="position:relative">Normal <span role="tooltip" style="position:absolute;left:130px;top:0">Tooltip text outside</span></td><td id="dialog-tooltip-neighbor">2</td></tr>
          <tr><td id="dialog-nested-cell" style="position:relative">Normal <span role="dialog" style="position:absolute;left:130px;top:0">Dialog text outside</span></td><td id="dialog-nested-neighbor">3</td></tr>
        </table>
      </div>
      <div popover="manual">
        <table>
          <tr><td id="popover-table-cell">VeryLongUnbrokenPropertyIdentifier</td><td id="popover-table-neighbor">4</td></tr>
        </table>
      </div>`);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[popover]')) (element as HTMLElement).showPopover();
    });
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    // A dialog or popover that hosts the table is chrome around the table, so the cells inside it
    // are still measured. A tooltip or nested dialog opened from a cell is chrome inside the cell,
    // so its text never reads as a collision.
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#dialog-cell", "#dialog-neighbor"],
      ["#popover-table-cell", "#popover-table-neighbor"],
    ]);
  } finally {
    await browser.close();
  }
});

test("keeps text an inline overflow does not clip and drops what a real clipping box hides", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        table { table-layout: fixed; width: 240px; border-collapse: collapse; }
        td { padding: 0; height: 40px; white-space: nowrap; vertical-align: top; }
      </style>
      <table>
        <tr><td id="inline-overflow"><span style="overflow:hidden">VeryLongUnbrokenPropertyIdentifier</span></td><td id="inline-overflow-neighbor">1</td></tr>
        <tr><td id="block-overflow"><span style="display:block;width:40px;overflow:hidden">VeryLongUnbrokenPropertyIdentifier</span></td><td id="block-overflow-neighbor">2</td></tr>
        <tr><td id="cell-overflow" style="overflow:hidden"><span style="display:block;width:200px">VeryLongUnbrokenPropertyIdentifier</span></td><td id="cell-overflow-neighbor">3</td></tr>
      </table>`);
    // A non-replaced inline box generates no overflow clip, so the declaration computes to
    // `hidden` while the client box the rule would intersect against stays zero sized. The
    // text really does reach the next cell.
    const measured = await page.evaluate(() => {
      const span = document.getElementById("inline-overflow")!.firstElementChild! as HTMLElement;
      const cell = document.getElementById("inline-overflow")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(span.firstChild!);
      return {
        overflow: getComputedStyle(span).overflowX,
        clientWidth: span.clientWidth,
        clientHeight: span.clientHeight,
        reachesNextCell: range.getBoundingClientRect().right > cell.right,
      };
    });
    expect(measured).toEqual({ overflow: "hidden", clientWidth: 0, clientHeight: 0, reachesNextCell: true });
    // Painted pixels rather than layout boxes: the inline row inks the far half of the
    // neighbour cell while the block row, clipped at 40px, leaves it blank. Bun's test runner
    // refuses the first capture of a fresh browser often enough to need one retry.
    const directory = await mkdtemp(join(tmpdir(), "vlint-inline-overflow-"));
    const file = join(directory, "cells.png");
    let captured = false;
    for (let attempt = 0; attempt < 2 && !captured; attempt++) {
      captured = await page.screenshot({ path: file }).then(() => true, () => false);
      if (!captured) await Bun.sleep(100);
    }
    expect(captured).toBe(true);
    const shot = (await Bun.file(file).bytes()).toBase64();
    await rm(directory, { recursive: true, force: true });
    const painted = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return ["inline-overflow", "block-overflow"].map((id) => {
        const cell = document.getElementById(id)!.getBoundingClientRect();
        const pixels = context.getImageData(cell.right + 10, cell.top, 100, cell.height).data;
        let dark = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 450) dark += 1;
        }
        return dark;
      });
    }, shot);
    expect(painted[0]).toBeGreaterThan(0);
    expect(painted[1]).toBe(0);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#inline-overflow", "#inline-overflow-neighbor"],
    ]);
  } finally {
    await browser.close();
  }
});

test("respects a calculated inset instead of reading the expression as no clip", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent(`
      <style>
        body { margin: 0; font: 16px Arial; }
        table { table-layout: fixed; width: 360px; border-spacing: 4px; }
        col:first-child { width: 120px; }
        th, td { padding: 0; height: 40px; vertical-align: top; }
      </style>
      <table><colgroup><col><col></colgroup><tbody>
        <tr><td id="calc-visible" style="height:80px"><span style="display:block;width:300px;height:80px;clip-path:inset(0 calc(50% + 2px) 0 0)"><span style="position:relative;left:130px;top:40px;white-space:nowrap">OverflowingLabel</span></span></td><td id="calc-visible-neighbor" style="height:80px;vertical-align:bottom">1</td></tr>
        <tr><td id="calc-hidden" style="height:80px"><span style="display:block;width:300px;height:80px;clip-path:inset(0 calc(50% + 2px) 0 0)"><span style="position:relative;left:180px;top:40px;white-space:nowrap">OverflowingLabel</span></span></td><td id="calc-hidden-neighbor" style="height:80px;vertical-align:bottom">2</td></tr>
      </tbody></table>`);
    // The browser leaves the expression unresolved, so the rule has to read the `calc()` itself.
    const computed = await page.evaluate(() =>
      getComputedStyle(document.getElementById("calc-visible")!.firstElementChild!).clipPath);
    expect(computed).toBe("inset(0px calc(50% + 2px) 0px 0px)");
    // Painted pixels rather than layout boxes: `50% + 2px` of the 300px box keeps 148px, which
    // holds the first label's sliver over the neighbour and hides the second label whole. Bun's
    // test runner refuses the first capture of a fresh browser often enough to need one retry.
    const directory = await mkdtemp(join(tmpdir(), "vlint-calc-inset-"));
    const file = join(directory, "cells.png");
    let captured = false;
    for (let attempt = 0; attempt < 2 && !captured; attempt++) {
      captured = await page.screenshot({ path: file }).then(() => true, () => false);
      if (!captured) await Bun.sleep(100);
    }
    expect(captured).toBe(true);
    const shot = (await Bun.file(file).bytes()).toBase64();
    await rm(directory, { recursive: true, force: true });
    const painted = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      // The neighbour's own label sits at the bottom of its box, so the upper 60px hold only
      // whatever the clipped label paints over the neighbour.
      return ["calc-visible", "calc-hidden"].map((id) => {
        const neighbour = document.getElementById(`${id}-neighbor`)!.getBoundingClientRect();
        const pixels = context.getImageData(
          Math.round(neighbour.left), Math.round(neighbour.top), Math.round(neighbour.width), 60).data;
        let dark = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 450) dark += 1;
        }
        return dark;
      });
    }, shot);
    expect(painted[0]).toBeGreaterThan(0);
    expect(painted[1]).toBe(0);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#calc-visible", "#calc-visible-neighbor"],
    ]);
    // The visible sliver stops about 18px into the neighbour, where treating the expression as
    // no clip at all would report the whole 123.6px fragment.
    const visible = result.facts.violations.filter((item) => item.type === "table-cell-text-overlap")[0];
    expect(visible?.overlapPx).toBeGreaterThan(15);
    expect(visible?.overlapPx).toBeLessThan(25);
  } finally {
    await browser.close();
  }
});

test("checks 1,000 rows without scanning every cell against every other cell", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    const rows = Array.from({ length: 1_000 }, (_, row) =>
      `<tr>${Array.from({ length: 10 }, (_, column) => `<td>${row}-${column}</td>`).join("")}</tr>`).join("");
    await page.setContent(`<style>table{table-layout:fixed;width:700px;border-collapse:collapse}td{width:70px;height:20px;padding:0}</style><table>${rows}</table>`);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    expect(result.facts.elementsInspected).toBe(10_000);
    expect(result.facts.violations).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);

test("checks a tall single-column table without loading its whole column for each cell", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    const rows = Array.from({ length: 8_000 }, (_, row) => `<tr><td>${row}</td></tr>`).join("");
    await page.setContent(`<style>table{table-layout:fixed;width:120px;border-collapse:collapse}td{width:120px;height:20px;padding:0}</style><table>${rows}</table>`);
    const started = performance.now();
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    const elapsed = performance.now() - started;
    expect(result.failure).toBeNull();
    expect(result.facts.elementsInspected).toBe(8_000);
    expect(result.facts.violations).toEqual([]);
    // Handing every row of the column to each cell costs seconds at this size (3.9s measured
    // before the walk), while a walk of the neighbouring bands stays within one cell's work.
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    await browser.close();
  }
}, 20_000);

test("keeps the nearest vertical neighbour across separated borders and spanning cells", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    const rows = Array.from({ length: 200 }, (_, row) => {
      if (row === 0) return `<tr><td id="band-down"><span style="position:relative;top:155px">Down</span></td><td>1</td></tr>`;
      if (row === 1) return `<tr><td id="spanned" rowspan="2">Spans</td><td>2</td></tr>`;
      if (row === 2) return `<tr><td>3</td></tr>`;
      if (row === 3) return `<tr><td id="band-up"><span style="position:relative;top:-320px">Up</span></td><td>4</td></tr>`;
      return `<tr><td>${row + 1}</td><td>${row + 1}</td></tr>`;
    }).join("");
    // A 120px row gap is wider than one 64px neighbour band, so both walks skip a band.
    await page.setContent(`<style>table{table-layout:fixed;width:240px;border-spacing:0 120px}td{width:120px;height:40px;padding:0;vertical-align:top}</style><table>${rows}</table>`);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#band-down", "#spanned"],
      ["#band-up", "#spanned"],
    ]);
  } finally {
    await browser.close();
  }
});

test("named rule can be enabled per target with cell exclusions", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "vlint-cell-overrides-"));
  try {
    const url = `${server.url}/table-cell-text-overlap.html`;
    await Bun.write(join(isolated, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "phone", viewport: { width: 390, height: 720 }, screen: { width: 390, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      rules: [
        { name: "tab-label-single-line", type: "tab-label-single-line", allowZeroLabels: true },
        { name: "cells", type: "table-cell-text-overlap", enabled: false, excludeSelectors: ["#native-body"] },
      ],
      provider: { type: "static", targets: [
        { name: "off", url },
        { name: "on", url, ruleOverrides: { cells: { enabled: true, excludeSelectors: ["#aria-body"] } } },
      ] },
    }));
    const result = await runCheckCommand(isolated, null, {}, "test");
    expect(result.cases[0]?.rules.find((rule) => rule.name === "cells")?.status).toBe("disabled");
    const on = result.cases[1]?.rules.find((rule) => rule.name === "cells");
    expect(on?.status).toBe("violations");
    expect(on?.violations.map((item) => item.locator)).toEqual(["#native-row", "#aria-row"]);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test("skips text-backed icons without hiding the cell text beside them", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        table { table-layout: fixed; width: 240px; border-collapse: collapse; }
        td { padding: 0; height: 40px; white-space: nowrap; vertical-align: top; }
      </style>
      <table>
        <tr><td id="icon-font"><i aria-hidden="true" style="position:relative;left:118px">&#xe900;</i></td><td id="icon-font-neighbor">1</td></tr>
        <tr><td id="image-role"><span role="img" aria-label="check" style="position:relative;left:118px">&#xe900;</span></td><td id="image-role-neighbor">2</td></tr>
        <tr><td id="real-text">VeryLongUnbrokenPropertyIdentifier</td><td id="real-text-neighbor">3</td></tr>
        <tr><td id="icon-and-text"><i aria-hidden="true" style="position:relative;left:118px">&#xe900;</i>VeryLongUnbrokenPropertyIdentifier</td><td id="icon-and-text-neighbor">4</td></tr>
        <tr><td id="aria-hidden-cell" aria-hidden="true">VeryLongUnbrokenPropertyIdentifier</td><td id="aria-hidden-cell-neighbor">5</td></tr>
      </table>`);
    // Both glyphs really do paint into the neighbouring cell, so the silence the rule
    // keeps on those rows is the icon exclusion and not a missing overlap.
    const geometry = await page.evaluate(() => ["icon-font", "image-role"].map((id) => {
      const cell = document.getElementById(id)!.getBoundingClientRect();
      const icon = document.getElementById(id)!.firstElementChild!;
      const range = document.createRange();
      range.selectNodeContents(icon.firstChild!);
      return { id, reaches: range.getBoundingClientRect().right > cell.right };
    }));
    expect(geometry).toEqual([
      { id: "icon-font", reaches: true },
      { id: "image-role", reaches: true },
    ]);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    // A semantic image role and an icon font's decorative character carry a glyph rather than
    // cell content, so neither is reported. Text sharing the cell with an icon is still
    // measured, and `aria-hidden` on the cell itself hides nothing visible from the rule.
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#real-text", "#real-text-neighbor"],
      ["#icon-and-text", "#icon-and-text-neighbor"],
      ["#aria-hidden-cell", "#aria-hidden-cell-neighbor"],
    ]);
  } finally {
    await browser.close();
  }
});

test("keeps a farther lateral peer over the heights a shorter nearer cell leaves open", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    // Each grid holds a source cell spanning two rows, a nearer cell covering only its top row
    // and a farther cell spanning both. The middle of the second row stays empty, so the farther
    // cell is the nearest peer for the lower half of the source.
    const grid = (prefix: string, top: string) => `
      <div role="grid">
        <div role="row">
          <div role="gridcell" id="${prefix}-source" aria-rowspan="2" class="tall"><span class="label" style="left:30px;top:${top}">VeryLongUnbrokenPropertyIdentifier</span></div>
          <div role="gridcell" id="${prefix}-near"></div>
          <div role="gridcell" id="${prefix}-far" aria-rowspan="2" class="tall"></div>
        </div>
      </div>`;
    await page.setContent(`
      <style>
        body { margin: 0; font: 16px Arial; }
        [role="grid"] { display: grid; grid-template-columns: 120px 120px 120px; grid-auto-rows: 40px; gap: 4px; width: 368px; margin-bottom: 24px; }
        [role="row"] { display: contents; }
        .tall { grid-row: span 2; }
        .label { position: relative; white-space: nowrap; }
      </style>
      ${grid("span", "45px")}
      ${grid("cover", "5px")}`);
    // The first label sits below the nearer cell's 40px box, the second inside it. Both reach
    // past the nearer cell's right edge and into the farther cell.
    const measured = await page.evaluate((ids: string[]) => ids.map((id) => {
      const cell = document.getElementById(id)!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id)!.firstElementChild!.firstChild!);
      const rect = range.getBoundingClientRect();
      const far = document.getElementById(id.replace("source", "far"))!.getBoundingClientRect();
      const reaches = (peer: Element) => {
        const box = peer.getBoundingClientRect();
        return rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
      };
      return {
        id,
        pastCellEdge: rect.right > cell.right,
        reachesNear: reaches(document.getElementById(id.replace("source", "near"))!),
        reachesFar: reaches(document.getElementById(id.replace("source", "far"))!),
        depth: Math.min(rect.right, far.right) - far.left,
        band: { left: far.left, top: rect.top, width: far.right - far.left, height: rect.height },
      };
    }), ["span-source", "cover-source"]);
    expect(measured.map(({ id, pastCellEdge, reachesNear, reachesFar }) =>
      ({ id, pastCellEdge, reachesNear, reachesFar }))).toEqual([
      { id: "span-source", pastCellEdge: true, reachesNear: false, reachesFar: true },
      { id: "cover-source", pastCellEdge: true, reachesNear: true, reachesFar: true },
    ]);
    // Painted pixels rather than layout boxes: the label inks the farther cell in both grids, so
    // the silence on `#cover-far` is the nearest-peer choice and not missing ink.
    const directory = await mkdtemp(join(tmpdir(), "vlint-span-peers-"));
    const file = join(directory, "cells.png");
    let captured = false;
    for (let attempt = 0; attempt < 2 && !captured; attempt++) {
      captured = await page.screenshot({ path: file }).then(() => true, () => false);
      if (!captured) await Bun.sleep(100);
    }
    expect(captured).toBe(true);
    const shot = (await Bun.file(file).bytes()).toBase64();
    await rm(directory, { recursive: true, force: true });
    const ink = await page.evaluate(async ({ data, bands }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return bands.map(({ left, top, width, height }) => {
        const pixels = context.getImageData(Math.floor(left), Math.floor(top), Math.ceil(width), Math.ceil(height)).data;
        let painted = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 750) painted += 1;
        }
        return painted;
      });
    }, { data: shot, bands: measured.map(({ band }) => band) });
    expect(ink[0]).toBeGreaterThan(0);
    expect(ink[1]).toBeGreaterThan(0);
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: [],
    });
    expect(result.failure).toBeNull();
    // The uncovered lower half keeps the farther cell as the neighbour; the covered upper half
    // answers against the nearer cell alone, although the same label crosses both there.
    expect(result.facts.violations.map((item) => [item.locator, item.adjacentLocator])).toEqual([
      ["#span-source", "#span-far"],
      ["#cover-source", "#cover-near"],
    ]);
    // The reported distance is the part of the label the farther cell's box holds.
    const far = result.facts.violations.find((item) => item.locator === "#span-source");
    expect(far?.type === "table-cell-text-overlap" && far.overlapPx).toBeCloseTo(measured[0]!.depth, 1);
  } finally {
    await browser.close();
  }
});
