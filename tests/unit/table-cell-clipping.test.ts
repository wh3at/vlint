import { describe, expect, test } from "bun:test";
import { createClippingEngine, type ClipCoordinates } from "../../src/rules/table-cell-clipping";

const coordinates: ClipCoordinates = {
  bounds: { x: 10, y: 20, width: 200, height: 240 },
  scale: { x: 2, y: 3 },
  width: 100,
  height: 80,
};

const clipRegion = createClippingEngine();

describe("table-cell clipping regions", () => {
  test("resolves inset percentages and lengths in element space, then maps to viewport space", () => {
    expect(clipRegion("inset(10% 25% 5px 10px)", coordinates)).toEqual({
      box: { x: 30, y: 44, width: 130, height: 201 },
      covers: null,
    });
    expect(clipRegion("xywh(10px 20px 50% 25%)", coordinates)).toEqual({
      box: { x: 30, y: 80, width: 100, height: 60 },
      covers: null,
    });
  });

  test("rounded corners shrink against the inset rectangle, not the border box", () => {
    const region = clipRegion("inset(10px round 40px)", coordinates)!;
    expect(region.box).toEqual({ x: 30, y: 50, width: 160, height: 180 });
    expect(region.covers?.(31, 51)).toBe(false);
    expect(region.covers?.(110, 140)).toBe(true);
    expect(region.covers?.(30, 140)).toBe(true);
  });

  test("default circle and ellipse radii follow different axes under scale", () => {
    const circle = clipRegion("circle()", coordinates)!;
    expect(circle.box).toEqual({ x: 30, y: 20, width: 160, height: 240 });
    expect(circle.covers?.(110, 140)).toBe(true);
    expect(circle.covers?.(30, 20)).toBe(false);

    const ellipse = clipRegion("ellipse(at 25% 50%)", coordinates)!;
    expect(ellipse.box).toEqual({ x: 10, y: 20, width: 100, height: 240 });
    expect(ellipse.covers?.(60, 140)).toBe(true);
    expect(ellipse.covers?.(110, 20)).toBe(false);
  });

  test("polygon returns a point predicate; unsupported or unresolved shapes return null", () => {
    const triangle = clipRegion("polygon(0 0, 100% 0, 50% 100%)", coordinates)!;
    expect(triangle.box).toEqual(coordinates.bounds);
    expect(triangle.covers?.(110, 80)).toBe(true);
    expect(triangle.covers?.(20, 230)).toBe(false);
    expect(clipRegion("none", coordinates)).toBeNull();
    expect(clipRegion("rect(0 0 10 10)", coordinates)).toBeNull();
    expect(clipRegion("xywh(auto 0 10px 10px)", coordinates)).toBeNull();
  });
});
