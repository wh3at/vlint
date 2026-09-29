import { expect, test } from "bun:test";
import { createCellNeighbors } from "../../src/rules/table-cell-neighbors";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test("keeps each table's neighbors separate and returns the nearby cell's area", () => {
  const source = { element: "source", scope: "table", rect: box(0, 0, 100, 40) };
  const neighbor = { element: "neighbor", scope: "table", rect: box(104, 0, 100, 40) };
  const other = { element: "other", scope: "grid", rect: box(100, 0, 100, 40) };
  const neighbors = createCellNeighbors([source, neighbor, other]);
  expect(neighbors(source)).toEqual([
    { element: "neighbor", rect: neighbor.rect, direction: "right", area: box(104, 0, 100, 40) },
  ]);
  expect(neighbors(other)).toEqual([]);
});

test("assigns the uncovered height of a row-spanning source to a farther lateral cell", () => {
  const source = { element: "source", scope: "grid", rect: box(0, 0, 100, 120) };
  const near = { element: "near", scope: "grid", rect: box(104, 0, 40, 40) };
  const far = { element: "far", scope: "grid", rect: box(200, 0, 50, 120) };
  const neighbors = createCellNeighbors([source, near, far]);
  expect(neighbors(source)).toEqual([
    { element: "near", rect: near.rect, direction: "right", area: box(104, 0, 40, 40) },
    { element: "far", rect: far.rect, direction: "right", area: box(200, 40, 50, 80) },
  ]);
});

test("splits a farther vertical cell around nearer cells after a row gap", () => {
  const source = { element: "source", scope: "table", rect: box(100, 100, 120, 40) };
  const nearLeft = { element: "left", scope: "table", rect: box(100, 144, 40, 40) };
  const nearRight = { element: "right", scope: "table", rect: box(180, 144, 40, 40) };
  const far = { element: "far", scope: "table", rect: box(80, 320, 160, 40) };
  const above = { element: "above", scope: "table", rect: box(100, 0, 120, 96) };
  const neighbors = createCellNeighbors([source, nearLeft, nearRight, far, above]);
  expect(neighbors(source)).toEqual([
    { element: "left", rect: nearLeft.rect, direction: "below", area: box(100, 144, 40, 40) },
    { element: "right", rect: nearRight.rect, direction: "below", area: box(180, 144, 40, 40) },
    { element: "far", rect: far.rect, direction: "below", area: box(140, 320, 40, 40) },
    { element: "above", rect: above.rect, direction: "above", area: box(100, 0, 120, 96) },
  ]);
});

test("a leftward search crosses empty bands and preserves both uncovered heights", () => {
  const source = { element: "source", scope: "grid", rect: box(300, 0, 100, 100) };
  const near = { element: "near", scope: "grid", rect: box(150, 20, 40, 40) };
  const far = { element: "far", scope: "grid", rect: box(0, 0, 50, 100) };
  const neighbors = createCellNeighbors([source, near, far]);
  expect(neighbors(source)).toEqual([
    { element: "near", rect: near.rect, direction: "left", area: box(150, 20, 40, 40) },
    { element: "far", rect: far.rect, direction: "left", area: box(0, 0, 50, 20) },
    { element: "far", rect: far.rect, direction: "left", area: box(0, 60, 50, 40) },
  ]);
});
