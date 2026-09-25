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

  test("reads a calculated inset and leaves an expression it cannot read unmodelled", () => {
    // `inset(0 calc(50% + 2px) 0 0)` on a 100px box keeps 48px: the percentage resolves against
    // the element box, and the `+` binds inside the parentheses.
    expect(clipRegion("inset(0 calc(50% + 2px) 0 0)", coordinates)).toEqual({
      box: { x: 10, y: 20, width: 96, height: 240 },
      covers: null,
    });
    expect(clipRegion("inset(calc(100% - 60px) 0 0)", coordinates)).toEqual({
      box: { x: 10, y: 80, width: 200, height: 180 },
      covers: null,
    });
    expect(clipRegion("inset(0 calc((50% + 2px) * 0.5) 0 0)", coordinates)?.box).toEqual({
      x: 10, y: 20, width: 148, height: 240,
    });
    // An expression the engine cannot reduce to one length stays unmodelled, so the caller
    // leaves the shape alone rather than reading it as a clip that hides the text below it.
    expect(clipRegion("inset(0 min(2px, 4px) 0 0)", coordinates)).toBeNull();
    expect(clipRegion("inset(0 calc(50% + 1em) 0 0)", coordinates)).toBeNull();
    expect(clipRegion("inset(0 calc(50% 2px) 0 0)", coordinates)).toBeNull();
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
    // A `calc()` radius keeps the diagonal percentage base of a plain one: 50% of the reference
    // diagonal less 10px, mapped back through the x scale.
    const calculated = clipRegion("circle(calc(50% - 10px))", coordinates)!;
    expect(calculated.box!.width / (2 * coordinates.scale.x))
      .toBeCloseTo(Math.hypot(coordinates.width, coordinates.height) / Math.SQRT2 / 2 - 10, 10);
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
