import type { Box } from "./table-cell-clipping";

export interface CellPosition<ElementId, ScopeId> {
  readonly element: ElementId;
  readonly scope: ScopeId;
  readonly rect: Box;
}

export interface CellNeighbor<ElementId> {
  readonly element: ElementId;
  readonly rect: Box;
  readonly direction: "left" | "right" | "above" | "below";
  readonly area: Box;
}

export function createCellNeighbors<ElementId, ScopeId>(positions: readonly CellPosition<ElementId, ScopeId>[]) {
  interface Indexed { readonly position: CellPosition<ElementId, ScopeId>; readonly group: Group }
  interface Group {
    readonly byX: Map<number, Indexed[]>;
    readonly byY: Map<number, Indexed[]>;
    readonly xSpan: { first: number; last: number };
    readonly ySpan: { first: number; last: number };
  }
  interface Interval { readonly start: number; readonly end: number }
  const groups = new Map<ScopeId, Group>();
  const entries = new Map<CellPosition<ElementId, ScopeId>, Indexed>();
  const bandSize = 64;
  function bandOf(coordinate: number): number {
    return Math.floor(coordinate / bandSize);
  }
  function bandRange(start: number, size: number) {
    return { first: bandOf(start), last: bandOf(start + size - 0.001) };
  }
  function index(bands: Map<number, Indexed[]>, start: number, size: number, entry: Indexed) {
    const range = bandRange(start, size);
    for (let band = range.first; band <= range.last; band++) {
      const items = bands.get(band) ?? [];
      items.push(entry);
      bands.set(band, items);
    }
    return range;
  }
  function bandLoad(bands: Map<number, Indexed[]>, start: number, size: number): number {
    const { first, last } = bandRange(start, size);
    let load = 0;
    for (let band = first; band <= last; band++) load += bands.get(band)?.length ?? 0;
    return load;
  }
  function coordinate(rect: Box, axis: "x" | "y"): number {
    return rect[axis];
  }
  function size(rect: Box, axis: "x" | "y"): number {
    return axis === "x" ? rect.width : rect.height;
  }
  function spansBox(rect: Box, peers: readonly Indexed[], axis: "x" | "y"): boolean {
    const from = coordinate(rect, axis);
    let reach = from;
    for (const peer of [...peers].sort((a, b) => coordinate(a.position.rect, axis) - coordinate(b.position.rect, axis))) {
      const candidate = peer.position.rect;
      if (coordinate(candidate, axis) > reach + 1) return false;
      reach = Math.max(reach, coordinate(candidate, axis) + size(candidate, axis));
    }
    return reach >= from + size(rect, axis) - 1;
  }
  function nearest(cell: Indexed, direction: CellNeighbor<ElementId>["direction"]): Indexed[] {
    const vertical = direction === "above" || direction === "below";
    const forward = direction === "right" || direction === "below";
    const across = vertical ? "y" : "x";
    const along = vertical ? "x" : "y";
    const { byX, byY, xSpan, ySpan } = cell.group;
    const alongBands = vertical ? byX : byY;
    const acrossBands = vertical ? byY : byX;
    const acrossSpan = vertical ? ySpan : xSpan;
    const rect = cell.position.rect;
    const edge = coordinate(rect, across) + size(rect, across);
    const separates = (peer: Indexed) => {
      const candidate = peer.position.rect;
      return forward ? coordinate(candidate, across) >= edge - 1
        : coordinate(candidate, across) + size(candidate, across) <= coordinate(rect, across) + 1;
    };
    const distance = (peer: Indexed) => {
      const candidate = peer.position.rect;
      return forward ? coordinate(candidate, across) : -coordinate(candidate, across) - size(candidate, across);
    };
    const overlaps = (peer: Indexed) => {
      const candidate = peer.position.rect;
      return coordinate(candidate, along) < coordinate(rect, along) + size(rect, along) &&
        coordinate(candidate, along) + size(candidate, along) > coordinate(rect, along);
    };
    if (bandLoad(alongBands, coordinate(rect, along), size(rect, along)) <=
        bandLoad(acrossBands, coordinate(rect, across), size(rect, across))) {
      const peers = new Set<Indexed>();
      for (let band = bandOf(coordinate(rect, along)); band <= bandOf(coordinate(rect, along) + size(rect, along) - 0.001); band++) {
        for (const peer of alongBands.get(band) ?? []) peers.add(peer);
      }
      return [...peers].filter((peer) => peer.position.element !== cell.position.element && overlaps(peer) && separates(peer))
        .sort((a, b) => distance(a) - distance(b));
    }
    const start = bandOf(forward ? edge - 1 : coordinate(rect, across) + 1 - 0.001);
    const ownBand = (peer: Indexed) => {
      const candidate = peer.position.rect;
      return bandOf(forward ? coordinate(candidate, across) : coordinate(candidate, across) + size(candidate, across) - 0.001);
    };
    const chosen: Indexed[] = [];
    for (let band = start; band >= acrossSpan.first && band <= acrossSpan.last; band += forward ? 1 : -1) {
      const batch: Indexed[] = [];
      for (const peer of acrossBands.get(band) ?? []) {
        if (peer.position.element === cell.position.element || ownBand(peer) !== band) continue;
        if (overlaps(peer) && separates(peer)) batch.push(peer);
      }
      if (batch.length === 0) continue;
      batch.sort((a, b) => distance(a) - distance(b));
      chosen.push(...batch);
      if (spansBox(rect, chosen, along)) break;
    }
    return chosen;
  }
  function openIntervals(interval: Interval, covered: readonly Interval[]): Interval[] {
    const held = covered.filter((span) => span.end > interval.start && span.start < interval.end)
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
  for (const position of positions) {
    let group = groups.get(position.scope);
    if (group === undefined) {
      group = {
        byX: new Map(), byY: new Map(),
        xSpan: { first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY },
        ySpan: { first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY },
      };
      groups.set(position.scope, group);
    }
    const entry = { position, group };
    entries.set(position, entry);
    const xBands = index(group.byX, position.rect.x, position.rect.width, entry);
    group.xSpan.first = Math.min(group.xSpan.first, xBands.first);
    group.xSpan.last = Math.max(group.xSpan.last, xBands.last);
    const yBands = index(group.byY, position.rect.y, position.rect.height, entry);
    group.ySpan.first = Math.min(group.ySpan.first, yBands.first);
    group.ySpan.last = Math.max(group.ySpan.last, yBands.last);
  }
  return (position: CellPosition<ElementId, ScopeId>): CellNeighbor<ElementId>[] => {
    const cell = entries.get(position)!;
    const chosen: CellNeighbor<ElementId>[] = [];
    for (const direction of ["right", "left", "below", "above"] as const) {
      const vertical = direction === "below" || direction === "above";
      const axis = vertical ? "x" : "y";
      const covered: Interval[] = [];
      for (const peer of nearest(cell, direction)) {
        const rect = peer.position.rect;
        const start = vertical ? Math.max(position.rect.x, rect.x) : rect.y;
        const end = vertical ? Math.min(position.rect.x + position.rect.width, rect.x + rect.width) : rect.y + rect.height;
        for (const range of openIntervals({ start, end }, covered)) {
          const area = axis === "x"
            ? { x: range.start, y: rect.y, width: range.end - range.start, height: rect.height }
            : { x: rect.x, y: range.start, width: rect.width, height: range.end - range.start };
          chosen.push({ element: peer.position.element, rect, direction, area });
          covered.push(range);
        }
      }
    }
    return chosen;
  };
}
