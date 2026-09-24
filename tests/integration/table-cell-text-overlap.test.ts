import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("positioned tables, spanning rows and non-overflow clipping retain only visible adjacent text", async () => {
  const result = await runCheckCommand(directory, `${server.url}/table-cell-text-overlap-edges.html`, {}, "test");
  const narrow = result.cases.find((item) => item.device.name === "390")!;
  expect(narrow.status).toBe("complete");
  expect(narrow.rules.find((rule) => rule.type === "page-horizontal-overflow")?.violations).toEqual([]);
  expect(narrow.rules.find((rule) => rule.type === "table-cell-text-overlap")?.violations).toEqual([
    expect.objectContaining({ locator: "#spanning", adjacentLocator: "#second-row-neighbor" }),
    expect.objectContaining({ locator: "#positioned-body", adjacentLocator: "#positioned-neighbor" }),
  ]);
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
