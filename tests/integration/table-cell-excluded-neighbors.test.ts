import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { evaluateTableCellTextOverlap } from "../../src/rules/table-cell-text-overlap";

test("excluded cells remain neighbors without counting as inspected cells", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent(`
      <style>body{margin:0;font:16px Arial}table{table-layout:fixed;width:240px;border-collapse:collapse}td{padding:0;height:40px;white-space:nowrap}</style>
      <table><tr><td id="source">VeryLongUnbrokenPropertyIdentifier</td><td id="neighbor"></td></tr></table>`);
    const expected = await page.evaluate(() => {
      const cell = document.getElementById("source")!.getBoundingClientRect();
      const adjacent = document.getElementById("neighbor")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("source")!);
      const text = range.getBoundingClientRect();
      return {
        geometry: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
        overlapPx: Math.round((Math.min(text.right, adjacent.right) - adjacent.left) * 1000) / 1000,
      };
    });
    const result = await evaluateTableCellTextOverlap(page, {
      name: "table-cell-text-overlap", type: "table-cell-text-overlap", enabled: true, excludeSelectors: ["#neighbor"],
    });
    expect(result.failure).toBeNull();
    expect(result.facts.elementsInspected).toBe(1);
    expect(result.facts.violations).toEqual([{
      type: "table-cell-text-overlap", locator: "#source", adjacentLocator: "#neighbor", ...expected,
    }]);
  } finally {
    await browser.close();
  }
}, 15_000);
