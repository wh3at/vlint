/// <reference lib="dom" />

import type { Page } from "playwright";
import type { EffectiveTableCellTextOverlapRule } from "../contracts/config";
import type { Geometry, RuleEvaluationOutcome, TableCellTextOverlapViolation } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  composeLocators,
  type ElementDescriptor,
} from "./locator";
import { createClippingEngine, type Box, type ClipCoordinates } from "./table-cell-clipping";

interface Overlap {
  readonly cell: ElementDescriptor;
  readonly adjacent: ElementDescriptor;
  readonly geometry: Box;
  readonly overlapPx: number;
}
interface Extraction {
  readonly elementsInspected: number;
  readonly overlaps: readonly Overlap[];
  readonly selectorError: string | null;
}
interface Scale { readonly x: number; readonly y: number }
interface Visible {
  readonly box: Box;
  /** Ancestor shapes the box must still be inside; empty when every clip was rectangular. */
  readonly shapes: readonly ((x: number, y: number) => boolean)[];
}

function extract({ excludeSelectors, stableAttrs, semanticAttrs }: {
  excludeSelectors: readonly string[];
  stableAttrs: readonly string[];
  semanticAttrs: readonly string[];
}, clipRegion: ReturnType<typeof createClippingEngine>): Extraction {
  function box(rect: DOMRect): Box {
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  function intersect(a: Box, b: Box): Box | null {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  function descriptor(element: Element): ElementDescriptor {
    const attribute = (names: readonly string[]) => {
      for (const name of names) {
        const value = element.getAttribute(name);
        if (value !== null) return { name, value };
      }
      return null;
    };
    const path: { tag: string; index: number }[] = [];
    let current: Element | null = element;
    while (current !== null) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling !== null) {
        if (sibling.localName === current.localName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      path.unshift({ tag: current.localName.toLowerCase(), index });
      current = current.parentElement;
    }
    return {
      tag: element.localName.toLowerCase(), id: element.id || null,
      stableDataAttribute: attribute(stableAttrs), semanticAttribute: attribute(semanticAttrs), path,
    };
  }
  // display, content-visibility, opacity and opacity filters hide the whole subtree.
  // visibility is inheritable and a descendant can restore it, so the text decides on its own value.
  function rendered(element: Element): boolean {
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.contentVisibility === "hidden" ||
          Number.parseFloat(style.opacity) <= 0 ||
          /\bopacity\(\s*0(?:\.0+)?%?\s*\)/.test(style.filter)) return false;
    }
    return getComputedStyle(element).display === "contents" || element.getClientRects().length > 0;
  }
  // `clip-path` and overflow lengths are element-space, so a transformed ancestor
  // paints them scaled. Shapes resolve in element space and map back through the
  // rendered border box, so a scale changes the clip exactly as it changes text.
  function scaleOf(element: Element, bounds: Box): Scale {
    const layout = element as HTMLElement;
    return {
      x: layout.offsetWidth > 0 ? bounds.width / layout.offsetWidth : 1,
      y: layout.offsetHeight > 0 ? bounds.height / layout.offsetHeight : 1,
    };
  }

  function framesOf(element: Element, bounds: Box): ClipCoordinates {
    const scale = scaleOf(element, bounds);
    return { bounds, scale, width: bounds.width / scale.x, height: bounds.height / scale.y };
  }

  /**
   * The part of an overlap box that a non-rectangular clip still shows. Sampled on a grid
   * of at most four CSS pixels, then grown half a step so a thin sliver stays measurable.
   */
  function shapeOverlap(covers: readonly ((x: number, y: number) => boolean)[], rect: Box): Box | null {
    const columns = Math.max(2, Math.min(64, Math.ceil(rect.width / 4)));
    const rows = Math.max(2, Math.min(64, Math.ceil(rect.height / 4)));
    const stepX = rect.width / columns;
    const stepY = rect.height / rows;
    let left = Number.POSITIVE_INFINITY, top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY, bottom = Number.NEGATIVE_INFINITY;
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const x = rect.x + stepX * (column + 0.5);
        const y = rect.y + stepY * (row + 0.5);
        if (!covers.every((cover) => cover(x, y))) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (!Number.isFinite(left)) return null;
    const x = Math.max(rect.x, left - stepX / 2);
    const y = Math.max(rect.y, top - stepY / 2);
    return {
      x, y,
      width: Math.min(rect.x + rect.width, right + stepX / 2) - x,
      height: Math.min(rect.y + rect.height, bottom + stepY / 2) - y,
    };
  }
  // `overflow` clips only where the principal box is a block, flex or grid container. A
  // non-replaced inline box computes the declaration but clips nothing, and its client box is
  // zero sized, so intersecting against it would hide every fragment the box holds.
  const CLIPPING_DISPLAYS = new Set([
    "block", "flow-root", "list-item", "inline-block", "table", "inline-table",
    "table-cell", "table-caption", "flex", "inline-flex", "grid", "inline-grid",
  ]);
  /**
   * The rounded edge of an overflow clip, or null when the box keeps square corners. `overflow`
   * clips at the padding box, and `border-radius` rounds that edge, so the visible rectangle
   * alone would report a corner the browser never paints. The used radii are the border box radii
   * shrunk together until the border box edges fit and then reduced by the border widths, which
   * is the rectangle `inset()` with `round` already describes, so the clipping engine resolves it.
   * Both axes have to clip: one clipped axis leaves the box a plain rectangle.
   */
  function roundedOverflow(style: CSSStyleDeclaration, ancestor: Element, scale: Scale, clip: Box) {
    const layout = ancestor as HTMLElement;
    const width = layout.offsetWidth;
    const height = layout.offsetHeight;
    // A box with no layout size, such as one under `display: contents`, has no edge to round.
    if (!(width > 0) || !(height > 0)) return null;
    /** One `border-*-radius`, written as `12px` or `10% 20%`, in element space. */
    const lengthOf = (part: string, base: number): number | null => {
      const value = Number.parseFloat(part);
      if (!Number.isFinite(value)) return null;
      return part.endsWith("%") ? value * base / 100 : value;
    };
    const corners = [style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => {
      const [horizontal, vertical] = value.trim().split(/\s+/);
      const x = lengthOf(horizontal ?? "", width);
      const y = lengthOf(vertical ?? horizontal ?? "", height);
      return x === null || y === null ? null : { x, y };
    });
    if (corners.some((corner) => corner === null)) return null;
    const radii = corners.map((corner) => corner!);
    const edges = [
      { length: width, sum: radii[0]!.x + radii[1]!.x },
      { length: width, sum: radii[3]!.x + radii[2]!.x },
      { length: height, sum: radii[0]!.y + radii[3]!.y },
      { length: height, sum: radii[1]!.y + radii[2]!.y },
    ];
    const factor = Math.min(1, ...edges.map((edge) =>
      edge.sum > 0 ? edge.length / edge.sum : Number.POSITIVE_INFINITY));
    const horizontalBorders = width - layout.clientWidth;
    const verticalBorders = height - layout.clientHeight;
    const borders = [
      { x: layout.clientLeft, y: layout.clientTop },
      { x: horizontalBorders - layout.clientLeft, y: layout.clientTop },
      { x: horizontalBorders - layout.clientLeft, y: verticalBorders - layout.clientTop },
      { x: layout.clientLeft, y: verticalBorders - layout.clientTop },
    ];
    const inner = radii.map((radius, index) => ({
      x: Math.max(radius.x * factor - borders[index]!.x, 0),
      y: Math.max(radius.y * factor - borders[index]!.y, 0),
    }));
    if (inner.every((radius) => radius.x === 0 && radius.y === 0)) return null;
    const axis = (values: readonly number[]) =>
      values.map((value) => `${Math.round(value * 1000) / 1000}px`).join(" ");
    // `round` takes four horizontal radii, then a slash and four vertical ones; interleaving the
    // pairs would hand a corner its neighbour's axis.
    const round = `${axis(inner.map((radius) => radius.x))} / ${axis(inner.map((radius) => radius.y))}`;
    const region = clipRegion(`inset(0 round ${round})`, {
      bounds: clip, scale, width: layout.clientWidth, height: layout.clientHeight,
    });
    return region === null ? null : region.covers;
  }
  function visibleRegion(rect: Box, parent: Element, sourceCell: Element): Visible | null {
    // An overlay opened from inside the source cell (tooltip, nested dialog, popover) is chrome,
    // so its text never reads as cell text. An overlay that hosts the whole table sits above the
    // source cell, and the table inside it keeps being measured.
    const overlay = parent.closest('[role="tooltip"], [role="dialog"], [popover]');
    if (overlay !== null && overlay !== sourceCell && sourceCell.contains(overlay)) return null;
    let visible: Visible | null = null;
    const viewport = intersect(rect, { x: 0, y: 0, width: innerWidth, height: innerHeight });
    if (viewport !== null) visible = { box: viewport, shapes: [] };
    let positioned: Element | null = null;
    let containingBlock: Element | null = null;
    for (let ancestor: Element | null = parent; ancestor !== null; ancestor = ancestor.parentElement) {
      const position = getComputedStyle(ancestor).position;
      if (position !== "absolute" && position !== "fixed") continue;
      positioned = ancestor;
      for (let block = ancestor.parentElement; block !== null; block = block.parentElement) {
        const style = getComputedStyle(block);
        const containsLayout = style.contain.split(/\s+/).some((part) => ["layout", "paint", "content", "strict"].includes(part));
        if ((position === "absolute" && style.position !== "static") || style.transform !== "none" ||
            style.filter !== "none" || style.perspective !== "none" || containsLayout) {
          containingBlock = block;
          break;
        }
      }
      break;
    }
    for (let ancestor: Element | null = parent; ancestor !== null && visible !== null; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipsOverflow = CLIPPING_DISPLAYS.has(style.display);
      const clipsX = clipsOverflow && ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
      const clipsY = clipsOverflow && ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
      const paintsInside = style.contain.split(/\s+/).some((part) => ["paint", "content", "strict"].includes(part));
      // A positioned descendant escapes overflow between it and its containing block.
      const escapesOverflow = positioned !== null && ancestor !== positioned &&
        ancestor.contains(positioned) && (containingBlock === null ||
          (ancestor !== containingBlock && containingBlock.contains(ancestor)));
      const clipHorizontal = (clipsX && !escapesOverflow) || paintsInside;
      const clipVertical = (clipsY && !escapesOverflow) || paintsInside;
      const clipPath = style.clipPath;
      if (!clipHorizontal && !clipVertical && clipPath === "none") continue;
      const bounds = box(ancestor.getBoundingClientRect());
      const scale = scaleOf(ancestor, bounds);
      let next: Box | null = visible.box;
      let shapes = visible.shapes;
      if (clipHorizontal || clipVertical) {
        const clip = {
          x: bounds.x + ancestor.clientLeft * scale.x, y: bounds.y + ancestor.clientTop * scale.y,
          width: ancestor.clientWidth * scale.x, height: ancestor.clientHeight * scale.y,
        };
        next = intersect(next, {
          x: clipHorizontal ? clip.x : next.x,
          y: clipVertical ? clip.y : next.y,
          width: clipHorizontal ? clip.width : next.width,
          height: clipVertical ? clip.height : next.height,
        });
        if (next === null) return null;
        // Chromium rounds the clip only where both axes clip. `overflow-x: clip` beside
        // `overflow-y: visible` stays a plain rectangle, so text crossing the visible axis keeps
        // being measured instead of disappearing into the rounded bounds.
        const rounded = clipHorizontal && clipVertical
          ? roundedOverflow(style, ancestor, scale, clip) : null;
        if (rounded !== null) shapes = [...shapes, rounded];
      }
      // Range geometry ignores `clip-path`, so the shape decides on its own. A shape
      // that is not modelled leaves the rectangle alone rather than guessing.
      const region = clipRegion(clipPath, framesOf(ancestor, bounds));
      if (region !== null) {
        next = region.box === null ? next : intersect(next, region.box);
        if (next === null) return null;
        if (region.covers !== null) shapes = [...shapes, region.covers];
      }
      visible = { box: next, shapes };
    }
    return visible;
  }
  // CSS background lists align by layer; commas inside a gradient are not layer separators.
  function layers(value: string): string[] {
    const result: string[] = [];
    let depth = 0, start = 0;
    for (let index = 0; index < value.length; index++) {
      if (value[index] === "(") depth++;
      else if (value[index] === ")") depth--;
      else if (value[index] === "," && depth === 0) {
        result.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    result.push(value.slice(start).trim());
    return result;
  }
  /** True when a computed colour paints at full opacity. */
  function opaque(color: string): boolean {
    const match = /^(?:rgb|hsl)a?\(([^)]*)\)$/i.exec(color.trim());
    if (match === null) return false;
    const parts = match[1]!.split(/[,/]/).map((part) => part.trim()).filter((part) => part !== "");
    return parts.length === 3 || (parts.length === 4 && Number.parseFloat(parts[3]!) === 1);
  }
  /** True when every side paints a solid, fully opaque border, which covers the ring it fills. */
  function opaqueBorder(style: CSSStyleDeclaration): boolean {
    return [
      [style.borderTopStyle, style.borderTopColor],
      [style.borderRightStyle, style.borderRightColor],
      [style.borderBottomStyle, style.borderBottomColor],
      [style.borderLeftStyle, style.borderLeftColor],
    ].every(([kind, color]) => kind === "solid" && opaque(color!));
  }
  interface PaintedLayer { readonly z: number; readonly node: Element }
  /**
   * The outermost stacking context of `node`'s branch inside `ancestor`, or its nearest
   * positioned box when there is no context. A positioned ancestor with `z-index: auto`
   * does not isolate a descendant's z-index, so the descendant can paint above a peer.
   */
  function paintLayer(node: Element, ancestor: Element): PaintedLayer | null {
    let layer: PaintedLayer | null = null;
    for (let current: Element | null = node; current !== null && current !== ancestor; current = current.parentElement) {
      const style = getComputedStyle(current);
      const positioned = style.position !== "static";
      const stacks = style.transform !== "none" || style.filter !== "none" ||
        style.perspective !== "none" || style.isolation === "isolate" ||
        style.contain.split(/\s+/).some((part) => ["layout", "paint", "content", "strict"].includes(part));
      if (!positioned && !stacks) continue;
      const z = positioned ? Number.parseInt(style.zIndex, 10) : 0;
      // A real stacking context confines its descendants; `position: relative` with
      // `z-index: auto` does not, even though its own box joins the positioned phase.
      if (stacks || (positioned && (style.zIndex !== "auto" || style.position === "sticky" || style.position === "fixed")) || layer === null) {
        layer = { z: Number.isFinite(z) ? z : 0, node: current };
      }
    }
    return layer;
  }
  /**
   * Whether `element` paints after the glyphs `text` lays down. CSS paints in-flow content before
   * positioned and stacking-context boxes, a higher `z-index` after a lower one, and boxes at the
   * same level in document order. An in-flow background paints before any glyph, so a box that
   * stays in flow never hides the text.
   */
  function paintsAbove(element: Element, text: Element): boolean {
    const ancestors = new Set<Element>();
    for (let current: Element | null = element; current !== null; current = current.parentElement) ancestors.add(current);
    let ancestor: Element | null = null;
    for (let current: Element | null = text; current !== null && ancestor === null; current = current.parentElement) {
      if (ancestors.has(current)) ancestor = current;
    }
    if (ancestor === null) return false;
    const painted = paintLayer(element, ancestor);
    if (painted === null) return false;
    const source = paintLayer(text, ancestor);
    if (source === null) return painted.z >= 0;
    if (painted.z !== source.z) return painted.z > source.z;
    return (source.node.compareDocumentPosition(painted.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }
  /**
   * The region an adjacent box paints over the glyphs, as a predicate, or null when it hides
   * nothing: it paints below the text, its background is not opaque, or its `background-clip`
   * trims the paint to a box or a shape this rule leaves unmodelled. The sliver a neighbour is
   * compared against always lies inside its border box, so the paint over that box decides on
   * its own.
   */
  function occludingPaint(element: Element, text: Element, rect: Box): ((x: number, y: number) => boolean) | null {
    if (!paintsAbove(element, text)) return null;
    const style = getComputedStyle(element);
    if (Number.parseFloat(style.opacity) < 1) return null;
    if (!opaque(style.backgroundColor)) return null;
    // Only the last background layer paints the colour, and a clip to the glyphs or to the
    // content box paints less than the border box the sliver was measured against.
    const clip = layers(style.backgroundClip || style.webkitBackgroundClip).at(-1) ?? "border-box";
    if (clip !== "border-box" && clip !== "padding-box") return null;
    // A padding-box clip leaves the border out, and an opaque border paints that ring itself, so
    // the border box stays the region the neighbour covers then.
    const covers = clip === "border-box" || opaqueBorder(style);
    const scale = scaleOf(element, rect);
    const layout = element as HTMLElement;
    const frames = framesOf(element, rect);
    // A padding-box clip the border does not fill starts from the padding box, while the radii
    // keep the border box's scale and percentage base, which is what CSS resolves them against.
    const region = clipRegion(`inset(0 round ${style.borderRadius.trim() || "0px"})`, covers ? frames
      : { ...frames, bounds: {
        x: rect.x + layout.clientLeft * scale.x, y: rect.y + layout.clientTop * scale.y,
        width: layout.clientWidth * scale.x, height: layout.clientHeight * scale.y,
      } });
    return region === null ? null : region.covers;
  }
  for (const selector of excludeSelectors) {
    try { document.querySelectorAll(selector); }
    catch { return { elementsInspected: 0, overlaps: [], selectorError: selector }; }
  }
  const candidates = document.querySelectorAll('table th, table td, [role="table"] [role="cell"], [role="table"] [role="rowheader"], [role="table"] [role="columnheader"], [role="grid"] [role="gridcell"], [role="grid"] [role="rowheader"], [role="grid"] [role="columnheader"]');
  interface Cell { element: Element; rect: Box; group: Group }
  interface Group {
    readonly byX: Map<number, Cell[]>;
    readonly byY: Map<number, Cell[]>;
    /** The x-bands the group's cells fill, so a lateral walk stops at the table's own extent. */
    readonly xSpan: { first: number; last: number };
    /** The y-bands the group's cells fill, so a vertical walk stops at the table's own extent. */
    readonly ySpan: { first: number; last: number };
  }
  /** A range of page coordinates in CSS pixels along one axis. */
  interface Interval { readonly start: number; readonly end: number }
  /** One cell a text fragment is compared with, and the part of it that comparison still holds on. */
  interface Neighbor {
    readonly element: Element;
    readonly rect: Box;
    readonly direction: "left" | "right" | "above" | "below";
    /**
     * Where this peer is still the nearest cell, on the axis the walk does not cross: the heights
     * for a lateral peer, the widths for one above or below. Always non-empty.
     */
    readonly ranges: readonly Interval[];
  }
  const groups = new Map<Element, Cell["group"]>();
  const inspected: Cell[] = [];
  const bandSize = 64;
  /** The band a coordinate falls in. Indexing and lookup must agree on band boundaries. */
  function bandOf(coordinate: number): number {
    return Math.floor(coordinate / bandSize);
  }
  function bandRange(start: number, size: number): { readonly first: number; readonly last: number } {
    return { first: bandOf(start), last: bandOf(start + size - 0.001) };
  }
  function index(bands: Map<number, Cell[]>, start: number, size: number, cell: Cell): { readonly first: number; readonly last: number } {
    const range = bandRange(start, size);
    for (let band = range.first; band <= range.last; band++) {
      const entries = bands.get(band) ?? [];
      entries.push(cell);
      bands.set(band, entries);
    }
    return range;
  }
  /**
   * How many cells share the bands a box fills on one axis. A lookup starts from whichever axis
   * holds fewer, so a tall column and a wide row both stay bounded.
   */
  function bandLoad(bands: Map<number, Cell[]>, start: number, size: number): number {
    const { first, last } = bandRange(start, size);
    let load = 0;
    for (let band = first; band <= last; band++) load += bands.get(band)?.length ?? 0;
    return load;
  }

  /**
   * True when the peers kept so far already span the box on `axis`, so a later peer only holds
   * widths or heights one of them already covers.
   */
  function spansBox(box: Box, peers: readonly Cell[], axis: "x" | "y"): boolean {
    const from = axis === "x" ? box.x : box.y;
    const size = axis === "x" ? box.width : box.height;
    const near = (rect: Box) => axis === "x" ? rect.x : rect.y;
    const end = (rect: Box) => axis === "x" ? rect.x + rect.width : rect.y + rect.height;
    let reach = from;
    for (const peer of [...peers].sort((a, b) => near(a.rect) - near(b.rect))) {
      if (near(peer.rect) > reach + 1) return false;
      reach = Math.max(reach, end(peer.rect));
    }
    return reach >= from + size - 1;
  }
  /**
   * The parts of an interval that `covered` does not already hold. Covered intervals may overlap
   * and arrive in any order, since they are the ranges kept by the peers chosen before.
   */
  function openIntervals(interval: Interval, covered: readonly Interval[]): Interval[] {
    const held = covered
      .filter((span) => span.end > interval.start && span.start < interval.end)
      .sort((a, b) => a.start - b.start);
    const open: Interval[] = [];
    let start = interval.start;
    for (const span of held) {
      if (span.start > start) open.push({ start, end: span.start });
      start = Math.max(start, span.end);
    }
    if (start < interval.end) open.push({ start, end: interval.end });
    return open;
  }
  /**
   * The peers that are still the nearest cell somewhere, nearest first. Each keeps only the part of
   * its `span` no nearer peer already answers for, so a peer left with nothing only answered
   * coordinates a nearer peer owns.
   */
  function nearestFirst(
    peers: readonly Cell[],
    direction: Neighbor["direction"],
    span: (rect: Box) => Interval,
  ): Neighbor[] {
    const covered: Interval[] = [];
    const chosen: Neighbor[] = [];
    for (const peer of peers) {
      const ranges = openIntervals(span(peer.rect), covered);
      if (ranges.length === 0) continue;
      chosen.push({ element: peer.element, rect: peer.rect, direction, ranges });
      covered.push(...ranges);
    }
    return chosen;
  }
  /** The parts of a box the listed ranges hold, in order. */
  function parts(box: Box, ranges: readonly Interval[], axis: "x" | "y"): Box[] {
    const pieces: Box[] = [];
    for (const range of ranges) {
      const from = Math.max(axis === "x" ? box.x : box.y, range.start);
      const to = Math.min(axis === "x" ? box.x + box.width : box.y + box.height, range.end);
      if (to <= from) continue;
      pieces.push(axis === "x"
        ? { x: from, y: box.y, width: to - from, height: box.height }
        : { x: box.x, y: from, width: box.width, height: to - from });
    }
    return pieces;
  }

  /**
   * The nearest cell on one side of the box, per column. A tall column and a wide row both stay
   * bounded: when the source's own X bands hold fewer cells than its Y bands, the vertical peers
   * come straight from the X index, otherwise the walk steps the Y bands outward from the box. A
   * walked peer only answers at the band its own y-edge falls in, so the walk meets neighbours
   * nearest first, and it runs until the peers it kept span the box across x, where every later
   * peer only holds widths one of them already covers. Border spacing and rowspans leave the gaps
   * the walk skips by band.
   */
  function nearestSide(cell: Cell, side: "above" | "below"): Cell[] {
    const { byX, byY, ySpan } = cell.group;
    const box = cell.rect;
    const below = side === "below";
    const step = below ? 1 : -1;
    const separates = (peer: Cell) => below
      ? peer.rect.y >= box.y + box.height - 1
      : peer.rect.y + peer.rect.height <= box.y + 1;
    const distance = (peer: Cell) => below ? peer.rect.y : -peer.rect.y - peer.rect.height;
    if (bandLoad(byX, box.x, box.width) <= bandLoad(byY, box.y, box.height)) {
      const peers = new Set<Cell>();
      for (let band = bandOf(box.x); band <= bandOf(box.x + box.width - 0.001); band++) {
        for (const peer of byX.get(band) ?? []) peers.add(peer);
      }
      return [...peers]
        .filter((peer) => peer.element !== cell.element && peer.rect.x < box.x + box.width &&
          peer.rect.x + peer.rect.width > box.x && separates(peer))
        .sort((a, b) => distance(a) - distance(b));
    }
    const start = bandOf(below ? box.y + box.height - 1 : box.y + 1 - 0.001);
    const ownBand = (peer: Cell) => below ? bandOf(peer.rect.y) : bandOf(peer.rect.y + peer.rect.height - 0.001);
    const chosen: Cell[] = [];
    for (let band = start; band >= ySpan.first && band <= ySpan.last; band += step) {
      const batch: Cell[] = [];
      for (const peer of byY.get(band) ?? []) {
        if (peer.element === cell.element || ownBand(peer) !== band) continue;
        if (peer.rect.x >= box.x + box.width || peer.rect.x + peer.rect.width <= box.x) continue;
        if (separates(peer)) batch.push(peer);
      }
      if (batch.length === 0) continue;
      batch.sort((a, b) => distance(a) - distance(b));
      chosen.push(...batch);
      if (spansBox(box, chosen, "x")) break;
    }
    return chosen;
  }
  /**
   * The nearest cell on one side of the box, per row. A tall column and a wide row both stay
   * bounded: when the source's own Y bands hold fewer cells than its X bands, the lateral peers
   * come straight from the Y index, otherwise the walk steps the X bands outward from the box. A
   * walked peer only answers at the band its own x-edge falls in, so the walk meets neighbours
   * nearest first, and it runs until the peers it kept span the box across y, where every later
   * peer only holds heights one of them already covers. Rowspans, column gaps and border spacing
   * leave the gaps the walk skips by band.
   */
  function nearestLateral(cell: Cell, side: "left" | "right"): Cell[] {
    const { byX, byY, xSpan } = cell.group;
    const box = cell.rect;
    const rightward = side === "right";
    const step = rightward ? 1 : -1;
    const separates = (peer: Cell) => rightward
      ? peer.rect.x >= box.x + box.width - 1
      : peer.rect.x + peer.rect.width <= box.x + 1;
    const distance = (peer: Cell) => rightward ? peer.rect.x : -peer.rect.x - peer.rect.width;
    if (bandLoad(byY, box.y, box.height) <= bandLoad(byX, box.x, box.width)) {
      const peers = new Set<Cell>();
      for (let band = bandOf(box.y); band <= bandOf(box.y + box.height - 0.001); band++) {
        for (const peer of byY.get(band) ?? []) peers.add(peer);
      }
      return [...peers]
        .filter((peer) => peer.element !== cell.element && peer.rect.y < box.y + box.height &&
          peer.rect.y + peer.rect.height > box.y && separates(peer))
        .sort((a, b) => distance(a) - distance(b));
    }
    const start = bandOf(rightward ? box.x + box.width - 1 : box.x + 1 - 0.001);
    const ownBand = (peer: Cell) => rightward ? bandOf(peer.rect.x) : bandOf(peer.rect.x + peer.rect.width - 0.001);
    const chosen: Cell[] = [];
    for (let band = start; band >= xSpan.first && band <= xSpan.last; band += step) {
      const batch: Cell[] = [];
      for (const peer of byX.get(band) ?? []) {
        if (peer.element === cell.element || ownBand(peer) !== band) continue;
        if (peer.rect.y >= box.y + box.height || peer.rect.y + peer.rect.height <= box.y) continue;
        if (separates(peer)) batch.push(peer);
      }
      if (batch.length === 0) continue;
      batch.sort((a, b) => distance(a) - distance(b));
      chosen.push(...batch);
      if (spansBox(box, chosen, "y")) break;
    }
    return chosen;
  }
  for (const element of candidates) {
    const scope = element.closest('table, [role="table"], [role="grid"]');
    if (scope === null || element.closest('tr, [role="row"]') === null || !rendered(element)) continue;
    let group = groups.get(scope);
    if (group === undefined) {
      group = {
        byX: new Map(), byY: new Map(),
        xSpan: { first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY },
        ySpan: { first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY },
      };
      groups.set(scope, group);
    }
    const rect = box(element.getBoundingClientRect());
    const cell = { element, rect, group };
    const xBands = index(group.byX, rect.x, rect.width, cell);
    group.xSpan.first = Math.min(group.xSpan.first, xBands.first);
    group.xSpan.last = Math.max(group.xSpan.last, xBands.last);
    const yBands = index(group.byY, rect.y, rect.height, cell);
    group.ySpan.first = Math.min(group.ySpan.first, yBands.first);
    group.ySpan.last = Math.max(group.ySpan.last, yBands.last);
    if (!excludeSelectors.some((selector) => element.matches(selector))) inspected.push(cell);
  }
  const overlaps: Overlap[] = [];
  // A text-backed icon paints a glyph rather than content the cell owns: `role="img"` marks
  // that character as an image, and `aria-hidden` marks an icon font's character as decorative.
  // Only markers inside the cell count, since an `aria-hidden` cell or table still paints its
  // own text.
  const ICON_SELECTOR = '[role="img"], [aria-hidden="true"]';
  for (const cell of inspected) {
    const { rect: cellBox, group } = cell;
    const right = nearestLateral(cell, "right");
    const left = nearestLateral(cell, "left");
    // Keep the nearest cell at each coordinate, including cells across a rowspan. Every list
    // arrives nearest first, so a peer keeps only the coordinates no nearer cell covers, and a peer
    // left with none at all only reached coordinates a nearer cell already answers for.
    const heights = (rect: Box): Interval => ({ start: rect.y, end: rect.y + rect.height });
    // An above or below peer answers for the width of the source alone, so the stretch of the peer
    // beside the source counts for nothing.
    const widths = (rect: Box): Interval => ({
      start: Math.max(cellBox.x, rect.x),
      end: Math.min(cellBox.x + cellBox.width, rect.x + rect.width),
    });
    const neighbors: Neighbor[] = [
      ...nearestFirst(right, "right", heights),
      ...nearestFirst(left, "left", heights),
      ...nearestFirst(nearestSide(cell, "below"), "below", widths),
      ...nearestFirst(nearestSide(cell, "above"), "above", widths),
    ];
    const walker = document.createTreeWalker(cell.element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const breaches = new Map<Element, number>();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      const parent = text.parentElement;
      if (parent === null || !text.nodeValue?.trim() || !rendered(parent)) continue;
      const icon = parent.closest(ICON_SELECTOR);
      if (icon !== null && icon !== cell.element && cell.element.contains(icon)) continue;
      const style = getComputedStyle(parent);
      // A hidden cell or wrapper still paints a descendant that restores visibility.
      if (style.visibility === "hidden" || style.visibility === "collapse") continue;
      const ink = style.webkitTextFillColor || style.color;
      const transparent = (color: string) => color === "transparent" || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color);
      const shadow = style.textShadow !== "none" && !/^(?:transparent|(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\))\s/.test(style.textShadow);
      const stroke = Number.parseFloat(style.webkitTextStrokeWidth) > 0 && !transparent(style.webkitTextStrokeColor);
      if (transparent(ink) && !shadow && !stroke) {
        // A gradient with only transparent stops cannot paint, even though its image is not `none`.
        const emptyGradient = (image: string): boolean => {
          const match = /^(?:repeating-)?linear-gradient\(([\s\S]*)\)$/i.exec(image);
          if (match === null) return false;
          const stops = layers(match[1]!);
          if (/^(?:to\s|[+-]?[\d.]+(?:deg|turn|rad|grad)\b)/i.test(stops[0] ?? "")) stops.shift();
          return stops.length > 0 && stops.every((stop) =>
            transparent(stop.replace(/\s+[-+]?[\d.]+(?:%|px)$/, "")));
        };
        const clips = layers(style.backgroundClip || style.webkitBackgroundClip);
        const images = layers(style.backgroundImage);
        const count = Math.max(clips.length, images.length);
        const paintedBackground = Array.from({ length: count }, (_, index) => index).some((index) =>
          clips[index % clips.length] === "text" &&
          ((images[index % images.length] !== "none" && !emptyGradient(images[index % images.length]!)) ||
            (index === count - 1 && !transparent(style.backgroundColor))));
        if (!paintedBackground) continue;
      }
      // Nested tables/grids belong to their own cells, not the containing cell.
      if (parent.closest('th, td, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]') !== cell.element) continue;
      // Whitespace can advance a Range without painting a glyph (notably under white-space: pre).
      for (const match of text.data.matchAll(/\S+/g)) {
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        for (const fragment of range.getClientRects()) {
          if (fragment.width <= 0 || fragment.height <= 0) continue;
          const visible = visibleRegion(box(fragment), parent, cell.element);
          if (visible === null) continue;
          for (const { element, rect, direction, ranges } of neighbors) {
            const overlap = intersect(visible.box, rect);
            if (overlap === null) continue;
            const covering = occludingPaint(element, parent, rect);
            // A peer that stays nearest over only part of the source answers there alone, so the
            // rest keeps reporting against the nearer cell that owns it.
            const lateral = direction === "left" || direction === "right";
            for (const sliver of parts(overlap, ranges, lateral ? "y" : "x")) {
              // The shape decides inside the overlap too, so a clipped corner cannot report a
              // neighbour the visible sliver never reaches. A peer painted above the text covers
              // the part of the sliver its opaque background hides, which then reports nothing.
              const shapes = covering === null
                ? visible.shapes
                : [...visible.shapes, (x: number, y: number) => !covering(x, y)];
              const shown = shapes.length === 0 ? sliver : shapeOverlap(shapes, sliver);
              if (shown === null) continue;
              const distance = lateral ? shown.width : shown.height;
              breaches.set(element, Math.max(breaches.get(element) ?? 0, distance));
            }
          }
        }
      }
    }
    for (const [adjacent, overlapPx] of breaches) {
      if (overlapPx > 1) overlaps.push({ cell: descriptor(cell.element), adjacent: descriptor(adjacent), geometry: cellBox, overlapPx });
    }
  }
  return { elementsInspected: inspected.length, overlaps, selectorError: null };
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }

export async function evaluateTableCellTextOverlap(
  page: Page,
  rule: EffectiveTableCellTextOverlapRule,
  target: string | null = null,
): Promise<RuleEvaluationOutcome<TableCellTextOverlapViolation>> {
  function failure(code: "rule-script-failed" | "exclude-selector-invalid" | "geometry-evaluation-failed", message: string): Failure {
    return { stage: "rule-evaluation", code, message, target, device: null, rule: rule.name };
  }
  let data: Extraction;
  try {
    // page.evaluate serializes only its entry function. Compose both self-contained
    // functions in the page world without injecting a persistent script into the page.
    const args = {
      excludeSelectors: rule.excludeSelectors,
      stableAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
      semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
    };
    data = await page.evaluate<Extraction>(`(${extract.toString()})(${JSON.stringify(args)}, (${createClippingEngine.toString()})())`);
  } catch {
    return { facts: { elementsInspected: 0, violations: [] }, failure: failure("rule-script-failed", "Table-cell text measurement could not read the page.") };
  }
  if (data.selectorError !== null) {
    return { facts: { elementsInspected: 0, violations: [] }, failure: failure("exclude-selector-invalid", `Invalid exclude selector "${data.selectorError}".`) };
  }
  const descriptions = data.overlaps.flatMap((item) => [item.cell, item.adjacent]);
  let locators: (string | null)[];
  try {
    locators = await page.evaluate((lists: string[][]) => lists.map((selectors) =>
      selectors.find((selector) => {
        try { return document.querySelectorAll(selector).length === 1; }
        catch { return false; }
      }) ?? null), descriptions.map((item) => [...composeLocators(item)]));
  } catch {
    return { facts: { elementsInspected: data.elementsInspected, violations: [] }, failure: failure("rule-script-failed", "Table-cell locator verification could not read the page.") };
  }
  if (locators.some((item) => item === null)) {
    return { facts: { elementsInspected: data.elementsInspected, violations: [] }, failure: failure("geometry-evaluation-failed", "Table-cell locator no longer resolves uniquely.") };
  }
  const violations: TableCellTextOverlapViolation[] = data.overlaps.map((item, index) => ({
    type: "table-cell-text-overlap", locator: locators[index * 2]!, adjacentLocator: locators[index * 2 + 1]!,
    geometry: { x: round(item.geometry.x), y: round(item.geometry.y), width: round(item.geometry.width), height: round(item.geometry.height) } as Geometry,
    overlapPx: round(item.overlapPx),
  }));
  return { facts: { elementsInspected: data.elementsInspected, violations }, failure: null };
}
