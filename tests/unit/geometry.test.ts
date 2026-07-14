import { describe, expect, test } from "bun:test";
import { clusterFragments, clusterLineCount, type TextFragment } from "../../src/rules/tab-label-single-line";

/** Build a fragment: top-left (x,y), size (w,h), resolved line-height lh. */
function frag(x: number, y: number, w: number, h: number, lh: number): TextFragment {
  return { x, y, width: w, height: h, lineHeight: lh };
}

describe("clusterLineCount", () => {
  test("a single fragment is one line", () => {
    expect(clusterLineCount([frag(0, 0, 40, 16, 16)])).toBe(1);
  });

  test("no fragments is zero lines", () => {
    expect(clusterLineCount([])).toBe(0);
  });

  test("two fragments that vertically overlap are one line", () => {
    const a = frag(0, 100, 30, 20, 20);
    const b = frag(40, 102, 30, 20, 20);
    expect(clusterLineCount([a, b])).toBe(1);
  });

  test("superscript sharing a baseline stays one line", () => {
    // baseline center 110; superscript sits higher (center 99) but overlaps.
    const baseline = frag(0, 100, 60, 20, 20);
    const sup = frag(62, 92, 10, 14, 14);
    expect(clusterLineCount([baseline, sup])).toBe(1);
    expect(clusterFragments([baseline, sup])).toHaveLength(1);
  });

  test("a translated badge on the same line stays one line", () => {
    const label = frag(0, 100, 60, 20, 20);
    const badge = frag(62, 96, 14, 14, 14); // nudged up, still overlapping
    expect(clusterLineCount([label, badge])).toBe(1);
  });

  test("wrapped text across two baselines is two lines", () => {
    const first = frag(0, 100, 200, 16, 16);
    const second = frag(0, 140, 120, 16, 16); // 40px below, no overlap
    expect(clusterLineCount([first, second])).toBe(2);
  });

  test("three stacked lines are three clusters", () => {
    expect(
      clusterLineCount([
        frag(0, 100, 100, 16, 16),
        frag(0, 140, 100, 16, 16),
        frag(0, 180, 100, 16, 16),
      ]),
    ).toBe(3);
  });

  test("line-height normal (lh equals rect height) clusters like an explicit height", () => {
    // normal line-height: resolved lh == fragment rect height (KTD8 fallback).
    const a = frag(0, 100, 60, 18, 18);
    const b = frag(62, 101, 30, 18, 18);
    expect(clusterLineCount([a, b])).toBe(1);
  });

  test("fractional geometry is not collapsed into one line", () => {
    const a = frag(0, 100.25, 60, 16.5, 16.5);
    const b = frag(0, 140.75, 60, 16.5, 16.5);
    expect(clusterLineCount([a, b])).toBe(2);
  });
});

describe("clusterFragments non-transitivity (tall badge does not bridge)", () => {
  test("a tall badge spanning two text lines does not merge them", () => {
    const line1 = frag(0, 100, 120, 16, 16); // center 108
    const line2 = frag(0, 140, 120, 16, 16); // center 148
    const badge = frag(130, 100, 24, 56, 56); // spans both, center 128
    const clusters = clusterFragments([line1, line2, badge]);
    expect(clusters).toHaveLength(2);
    // the two real text lines must live in separate clusters
    const line1Cluster = clusters.find((c) => c.includes(line1))!;
    const line2Cluster = clusters.find((c) => c.includes(line2))!;
    expect(line1Cluster).not.toBe(line2Cluster);
  });

  test("a tall badge does not bridge even when it appears first", () => {
    const badge = frag(130, 80, 24, 40, 40); // center 100, processed first
    const line1 = frag(0, 112, 120, 16, 16); // center 120
    const line2 = frag(0, 152, 120, 16, 16); // center 160
    const clusters = clusterFragments([badge, line1, line2]);
    expect(clusters).toHaveLength(2);
    const line1Cluster = clusters.find((c) => c.includes(line1))!;
    const line2Cluster = clusters.find((c) => c.includes(line2))!;
    expect(line1Cluster).not.toBe(line2Cluster);
  });
});
