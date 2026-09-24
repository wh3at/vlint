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
  ]);
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
