import { describe, expect, test } from "bun:test";
import type { OverflowComputedStyle } from "../../src/contracts/evaluation";
import {
  calculateHorizontalBreach,
  calculateRootOverflow,
  selectOverflowRepresentatives,
  type OverflowCandidate,
} from "../../src/rules/page-horizontal-overflow";

const STYLE: OverflowComputedStyle = {
  display: "block",
  position: "static",
  boxSizing: "content-box",
  width: "100px",
  minWidth: "0px",
  maxWidth: "none",
  whiteSpace: "normal",
  overflowX: "visible",
  flex: "0 1 auto",
  flexBasis: "auto",
  flexGrow: "0",
  flexShrink: "1",
  gridTemplateColumns: "none",
  gridAutoColumns: "auto",
};

function candidate(
  index: number,
  breachPx: number,
  ancestorIndices: readonly number[] = [],
  containedByLocalBoundary = false,
): OverflowCandidate {
  return {
    index,
    ancestorIndices,
    breachPx,
    containedByLocalBoundary,
    geometry: { x: 0, y: 0, width: 100, height: 20 },
    descriptor: {
      tag: "div",
      id: `item-${index}`,
      stableDataAttribute: null,
      semanticAttribute: null,
      path: [{ tag: "html", index: 1 }, { tag: "div", index: index + 1 }],
    },
    computedStyle: STYLE,
  };
}

describe("page horizontal overflow pure geometry", () => {
  test("root overflow is horizontal-only and clamps at zero", () => {
    expect(calculateRootOverflow(800, 800)).toBe(0);
    expect(calculateRootOverflow(800, 799.5)).toBe(0);
    expect(calculateRootOverflow(800, 812.25)).toBe(12.25);
  });

  test("candidate breach uses the larger left or right viewport escape", () => {
    expect(calculateHorizontalBreach({ x: 10, width: 100 }, 0, 800)).toBe(0);
    expect(calculateHorizontalBreach({ x: -12, width: 100 }, 0, 800)).toBe(12);
    expect(calculateHorizontalBreach({ x: 790, width: 30 }, 0, 800)).toBe(20);
    expect(calculateHorizontalBreach({ x: -20, width: 850 }, 0, 800)).toBe(30);
  });

  test("strict tolerance excludes exact-boundary candidates", () => {
    expect(selectOverflowRepresentatives([candidate(0, 1)], 1)).toEqual([]);
    expect(selectOverflowRepresentatives([candidate(0, 1.001)], 1).map((item) => item.index)).toEqual([0]);
  });

  test("collapses an ancestor chain to its outermost breaching element", () => {
    const representatives = selectOverflowRepresentatives([
      candidate(2, 20, [1, 0]),
      candidate(0, 5),
      candidate(1, 10, [0]),
    ], 1);
    expect(representatives.map((item) => item.index)).toEqual([0]);
  });

  test("keeps unrelated causes in extraction order and suppresses contained scroller descendants", () => {
    const representatives = selectOverflowRepresentatives([
      candidate(4, 8),
      candidate(7, 12, [], true),
      candidate(9, 6),
    ], 1);
    expect(representatives.map((item) => item.index)).toEqual([4, 9]);
  });
});
