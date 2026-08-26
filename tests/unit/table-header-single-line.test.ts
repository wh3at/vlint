import { describe, expect, test } from "bun:test";
import {
  clusterTableHeaderLineTops,
  type TableHeaderTextRect,
} from "../../src/rules/table-header-single-line";

function rect(x: number, top: number): TableHeaderTextRect {
  return { x, top, width: 20, height: 16 };
}

describe("clusterTableHeaderLineTops", () => {
  test("returns one representative top per visual line", () => {
    expect(clusterTableHeaderLineTops([rect(30, 10.2), rect(0, 10), rect(0, 30)], 1)).toEqual([
      10,
      30,
    ]);
  });

  test("clusters vertically overlapping fragments such as superscripts as one line", () => {
    expect(
      clusterTableHeaderLineTops(
        [
          { x: 0, top: 10, width: 40, height: 19 },
          { x: 40, top: 4, width: 8, height: 13 },
        ],
        1,
      ),
    ).toEqual([4]);
  });

  test("uses fixed anchors so overlap chains are non-transitive", () => {
    expect(
      clusterTableHeaderLineTops(
        [
          { x: 0, top: 0, width: 20, height: 10 },
          { x: 20, top: 5, width: 20, height: 10 },
          { x: 40, top: 10, width: 20, height: 10 },
        ],
        1,
      ),
    ).toEqual([0, 10]);
  });

  test("uses fixed anchors so top-tolerance chains are non-transitive", () => {
    expect(
      clusterTableHeaderLineTops(
        [
          { x: 0, top: 0, width: 20, height: 1 },
          { x: 20, top: 0.75, width: 20, height: 1 },
          { x: 40, top: 1.5, width: 20, height: 1 },
        ],
        1,
      ),
    ).toEqual([0, 1.5]);
  });

  test("keeps the tolerance boundary in one cluster", () => {
    expect(clusterTableHeaderLineTops([rect(0, 10), rect(20, 11)], 1)).toEqual([10]);
  });

  test("rounds fractional browser coordinates to three decimals", () => {
    expect(clusterTableHeaderLineTops([rect(0, 10.12349), rect(0, 30.98765)], 0.5)).toEqual([
      10.123,
      30.988,
    ]);
  });

  test("ignores zero-area rectangles", () => {
    expect(
      clusterTableHeaderLineTops(
        [rect(0, 10), { x: 0, top: 30, width: 0, height: 16 }],
        1,
      ),
    ).toEqual([10]);
  });
});
