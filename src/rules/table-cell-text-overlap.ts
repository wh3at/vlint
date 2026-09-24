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

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
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
interface Region {
  /** The region's rectangle, or null when only the shape itself bounds it. */
  readonly box: Box | null;
  /** Null when the region is exactly its box; otherwise whether a point is inside the shape. */
  readonly covers: ((x: number, y: number) => boolean) | null;
}
interface Visible {
  readonly box: Box;
  /** Ancestor shapes the box must still be inside; empty when every clip was rectangular. */
  readonly shapes: readonly ((x: number, y: number) => boolean)[];
}

function extract({ excludeSelectors, stableAttrs, semanticAttrs }: {
  excludeSelectors: readonly string[];
  stableAttrs: readonly string[];
  semanticAttrs: readonly string[];
}): Extraction {
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

  interface Frames {
    readonly bounds: Box;
    readonly scale: Scale;
    /** The border box in element space, where `clip-path` lengths are written. */
    readonly width: number;
    readonly height: number;
  }

  function framesOf(element: Element, bounds: Box): Frames {
    const scale = scaleOf(element, bounds);
    return { bounds, scale, width: bounds.width / scale.x, height: bounds.height / scale.y };
  }

  /** One element-space length, or null when CSS wrote a keyword instead. */
  function elementLength(part: string | undefined, base: number): number | null {
    const text = (part ?? "").trim();
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return null;
    return text.endsWith("%") ? value * base / 100 : value;
  }

  /** An `<ellipse>`/`<circle>` radius, including the `closest-side`/`farthest-side` keywords. */
  function radiusOf(part: string | undefined, base: number, centre: number): number | null {
    const text = (part ?? "").trim();
    if (text === "closest-side") return Math.min(centre, base - centre);
    if (text === "farthest-side") return Math.max(centre, base - centre);
    return elementLength(part, base);
  }

  function ellipseRegion(cx: number, cy: number, rx: number, ry: number): Region {
    return {
      box: { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 },
      covers: rx > 0 && ry > 0
        ? (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
        : () => false,
    };
  }

  function polygonRegion(points: readonly { x: number; y: number }[]): Region {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      box: {
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      },
      covers: (x, y) => {
        let inside = false;
        for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
          const a = points[index]!;
          const b = points[previous]!;
          if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
      },
    };
  }

  /** `round` corner radii in element space, reduced so adjacent corners do not overlap. */
  /**
   * `round` corner radii: percentages follow the reference box, then the radii shrink
   * until opposite corners meet on the resulting shape rectangle (CSS border-radius rules).
   */
  function cornerRadii(
    tokens: readonly string[],
    frames: Frames,
    shape: { readonly width: number; readonly height: number },
  ): { x: number; y: number }[] | null {
    const slash = tokens.indexOf("/");
    const horizontal = slash === -1 ? tokens : tokens.slice(0, slash);
    const spread = (parts: readonly string[], base: number) => {
      const values = parts.map((part) => elementLength(part, base));
      if (values.length === 0 || values.some((value) => value === null)) return null;
      const [first, second, third, fourth] = values as number[];
      return [first!, second ?? first!, third ?? first!, fourth ?? second ?? first!];
    };
    const horizontalRadii = spread(horizontal, frames.width);
    const verticalRadii = spread(slash === -1 ? horizontal : tokens.slice(slash + 1), frames.height);
    if (horizontalRadii === null || verticalRadii === null) return null;
    const edges = [
      { length: shape.width, sum: horizontalRadii[0]! + horizontalRadii[1]! },
      { length: shape.width, sum: horizontalRadii[3]! + horizontalRadii[2]! },
      { length: shape.height, sum: verticalRadii[0]! + verticalRadii[3]! },
      { length: shape.height, sum: verticalRadii[1]! + verticalRadii[2]! },
    ];
    const factor = Math.min(1, ...edges.map((edge) => (edge.sum > 0 ? edge.length / edge.sum : Number.POSITIVE_INFINITY)));
    return horizontalRadii.map((radius, index) => ({ x: radius * factor, y: verticalRadii[index]! * factor }));
  }

  function roundedCovers(box: Box, radii: readonly { x: number; y: number }[]) {
    const corners = [
      { cx: box.x + radii[0]!.x, cy: box.y + radii[0]!.y, rx: radii[0]!.x, ry: radii[0]!.y, left: true, top: true },
      { cx: box.x + box.width - radii[1]!.x, cy: box.y + radii[1]!.y, rx: radii[1]!.x, ry: radii[1]!.y, left: false, top: true },
      { cx: box.x + box.width - radii[2]!.x, cy: box.y + box.height - radii[2]!.y, rx: radii[2]!.x, ry: radii[2]!.y, left: false, top: false },
      { cx: box.x + radii[3]!.x, cy: box.y + box.height - radii[3]!.y, rx: radii[3]!.x, ry: radii[3]!.y, left: true, top: false },
    ];
    return (x: number, y: number) => {
      if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) return false;
      for (const corner of corners) {
        if (!(corner.rx > 0 && corner.ry > 0)) continue;
        if ((corner.left ? x < corner.cx : x > corner.cx) && (corner.top ? y < corner.cy : y > corner.cy) &&
            ((x - corner.cx) / corner.rx) ** 2 + ((y - corner.cy) / corner.ry) ** 2 > 1) return false;
      }
      return true;
    };
  }

  let inkContext: CanvasRenderingContext2D | null | undefined;
  /** A 2D context used only to answer point-in-path questions about `clip-path`. */
  function ink(): CanvasRenderingContext2D | null {
    if (inkContext === undefined) inkContext = document.createElement("canvas").getContext("2d");
    return inkContext;
  }

  /** SVG and CSS length units in user units; `em` and unknown units resolve outside this table. */
  const SVG_UNITS: Record<string, number> = {
    "": 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16,
  };

  /** The SVG viewport in user units: the `viewBox` size when set, otherwise the rendered size. */
  function svgViewport(element: Element): { readonly width: number; readonly height: number } {
    const svg = (element as SVGGraphicsElement).ownerSVGElement;
    if (svg === null) return { width: 0, height: 0 };
    const view = svg.viewBox.baseVal;
    if (view.width > 0 && view.height > 0) return { width: view.width, height: view.height };
    const bounds = svg.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }

  /** An SVG length in user units, or null when the value needs a font or a unit we do not know. */
  function svgLength(element: Element, raw: string, base: number): number | null {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]*)$/i.exec(raw.trim());
    if (match === null) return null;
    const value = Number.parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    if (unit === "%") return value * base / 100;
    if (unit === "em") return value * Number.parseFloat(getComputedStyle(element).fontSize);
    const scale = SVG_UNITS[unit];
    return scale === undefined ? null : value * scale;
  }

  /** A rounded rectangle with independent axis radii, as SVG clamps them. */
  function roundedRect(geometry: Path2D, x: number, y: number, width: number, height: number, rx: number, ry: number): void {
    geometry.moveTo(x + rx, y);
    geometry.lineTo(x + width - rx, y);
    geometry.ellipse(x + width - rx, y + ry, rx, ry, 0, -Math.PI / 2, 0);
    geometry.lineTo(x + width, y + height - ry);
    geometry.ellipse(x + width - rx, y + height - ry, rx, ry, 0, 0, Math.PI / 2);
    geometry.lineTo(x + rx, y + height);
    geometry.ellipse(x + rx, y + height - ry, rx, ry, 0, Math.PI / 2, Math.PI);
    geometry.lineTo(x, y + ry);
    geometry.ellipse(x + rx, y + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
    geometry.closePath();
  }

  /** An SVG basic shape as path geometry in its own user space; null when not modelled. */
  function svgShape(element: Element, viewport: { readonly width: number; readonly height: number }): Path2D | null {
    const attribute = (name: string): string | null => element.getAttribute(name);
    // Undefined means the attribute is absent; null means the length could not be resolved.
    const optional = (name: string, base: number): number | null | undefined => {
      const raw = attribute(name);
      return raw === null ? undefined : svgLength(element, raw, base);
    };
    const length = (name: string, base: number, fallback: number): number | null => {
      const value = optional(name, base);
      return value === undefined ? fallback : value;
    };
    const geometry = new Path2D();
    if (element.localName === "rect") {
      const x = length("x", viewport.width, 0), y = length("y", viewport.height, 0);
      const width = length("width", viewport.width, 0), height = length("height", viewport.height, 0);
      if (x === null || y === null || width === null || height === null) return null;
      const radiusX = optional("rx", viewport.width), radiusY = optional("ry", viewport.height);
      if (radiusX === null || radiusY === null) return null;
      const rx = Math.min(radiusX ?? radiusY ?? 0, width / 2);
      const ry = Math.min(radiusY ?? radiusX ?? 0, height / 2);
      if (rx > 0 && ry > 0) roundedRect(geometry, x, y, width, height, rx, ry);
      else geometry.rect(x, y, width, height);
      return geometry;
    }
    if (element.localName === "circle") {
      const cx = length("cx", viewport.width, 0), cy = length("cy", viewport.height, 0);
      const r = length("r", Math.hypot(viewport.width, viewport.height) / Math.SQRT2, 0);
      if (cx === null || cy === null || r === null) return null;
      geometry.arc(cx, cy, r, 0, Math.PI * 2);
      return geometry;
    }
    if (element.localName === "ellipse") {
      const cx = length("cx", viewport.width, 0), cy = length("cy", viewport.height, 0);
      const rx = length("rx", viewport.width, 0), ry = length("ry", viewport.height, 0);
      if (cx === null || cy === null || rx === null || ry === null) return null;
      geometry.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      return geometry;
    }
    if (element.localName === "polygon" || element.localName === "polyline") {
      const raw = (attribute("points") ?? "").trim();
      if (raw.length === 0) return null;
      const tokens = raw.split(/[\s,]+/);
      const points = tokens.map((token, index) => svgLength(element, token, index % 2 === 0 ? viewport.width : viewport.height));
      if (points.length < 4 || points.length % 2 !== 0 || points.some((point) => point === null)) return null;
      for (let index = 0; index < points.length; index += 2) {
        if (index === 0) geometry.moveTo(points[0]!, points[1]!);
        else geometry.lineTo(points[index]!, points[index + 1]!);
      }
      if (element.localName === "polygon") geometry.closePath();
      return geometry;
    }
    if (element.localName === "path") {
      try { return new Path2D(attribute("d") ?? ""); } catch { return null; }
    }
    return null;
  }

  /** A `url(#id)` clip-path as path geometry, evaluated in the clip element's user space. */
  function referencedClip(id: string, frames: Frames): Region | null {
    const clip = document.getElementById(id);
    if (clip === null || clip.localName !== "clipPath") return null;
    const context = ink();
    if (context === null) return null;
    // A transform on the clipPath itself applies to every child. SVG transform syntax
    // needs the SVG parser, so it is consolidated through a throwaway <g>.
    const svgMatrix = (value: string | null): DOMMatrix => {
      if (value === null) return new DOMMatrix();
      const holder = document.createElementNS("http://www.w3.org/2000/svg", "g");
      holder.setAttribute("transform", value);
      const matrix = holder.transform.baseVal.consolidate()?.matrix;
      return matrix === undefined
        ? new DOMMatrix()
        : new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]);
    };
    const group = svgMatrix(clip.getAttribute("transform"));
    // `objectBoundingBox` writes its geometry as fractions of the element box, so its
    // percentages resolve against 1 rather than against the SVG viewport.
    const bounding = clip.getAttribute("clipPathUnits") === "objectBoundingBox";
    const viewport = bounding ? { width: 1, height: 1 } : svgViewport(clip);
    // A clip path with no shape hides everything it applies to; an unreadable child
    // leaves the whole reference unmodelled instead.
    const children = [...clip.children].filter((child) => !["title", "desc", "metadata"].includes(child.localName));
    if (children.length === 0) return { box: null, covers: () => false };
    const shapes: { readonly path: Path2D; readonly evenOdd: boolean }[] = [];
    for (const child of children) {
      const path = svgShape(child, viewport);
      if (path === null) return null;
      const matrix = new Path2D();
      matrix.addPath(path, group.multiply(svgMatrix(child.getAttribute("transform"))));
      const style = getComputedStyle(child) as CSSStyleDeclaration & { readonly clipRule?: string };
      shapes.push({ path: matrix, evenOdd: style.clipRule === "evenodd" || child.getAttribute("fill-rule") === "evenodd" });
    }
    return {
      box: null,
      covers: (x, y) => {
        const left = bounding ? (x - frames.bounds.x) / frames.bounds.width : (x - frames.bounds.x) / frames.scale.x;
        const top = bounding ? (y - frames.bounds.y) / frames.bounds.height : (y - frames.bounds.y) / frames.scale.y;
        return shapes.some((shape) => context.isPointInPath(shape.path, left, top, shape.evenOdd ? "evenodd" : "nonzero"));
      },
    };
  }

  /** `inset()`, `xywh()`, `circle()`, `ellipse()`, `polygon()`, `path()` and `url()`; null when not modelled. */
  function clipRegion(value: string, frames: Frames): Region | null {
    const shape = /^([a-z-]+)\(([\s\S]*)\)$/.exec(value.trim());
    if (shape === null) return null;
    const name = shape[1]!;
    const body = shape[2]!.trim();
    const tokensOf = (text: string) => text.trim().split(/\s+/).filter((part) => part.length > 0);
    const viewportX = (length: number) => frames.bounds.x + length * frames.scale.x;
    const viewportY = (length: number) => frames.bounds.y + length * frames.scale.y;
    const viewportRadii = (radii: readonly { x: number; y: number }[]) =>
      radii.map((radius) => ({ x: radius.x * frames.scale.x, y: radius.y * frames.scale.y }));
    const sidesOf = (text: string) => {
      const round = /(?:^|\s)round\s+([\s\S]+)$/.exec(text);
      return {
        sides: (round === null ? text : text.slice(0, round.index)).trim().split(/\s+/),
        round: round === null ? null : tokensOf(round[1]!),
      };
    };
    const roundedRegion = (box: Box, round: readonly string[] | null): Region | null => {
      if (round === null) return { box, covers: null };
      const radii = cornerRadii(round, frames, { width: box.width / frames.scale.x, height: box.height / frames.scale.y });
      return radii === null ? null : { box, covers: roundedCovers(box, viewportRadii(radii)) };
    };
    if (name === "inset") {
      const { sides, round } = sidesOf(body);
      const left = elementLength(sides[3] ?? sides[1] ?? sides[0], frames.width);
      const top = elementLength(sides[0], frames.height);
      const right = elementLength(sides[1] ?? sides[0], frames.width);
      const bottom = elementLength(sides[2] ?? sides[0], frames.height);
      if (left === null || top === null || right === null || bottom === null) return null;
      return roundedRegion({
        x: viewportX(left), y: viewportY(top),
        width: (frames.width - left - right) * frames.scale.x,
        height: (frames.height - top - bottom) * frames.scale.y,
      }, round);
    }
    if (name === "xywh") {
      const { sides, round } = sidesOf(body);
      const x = elementLength(sides[0], frames.width);
      const y = elementLength(sides[1], frames.height);
      const width = elementLength(sides[2], frames.width);
      const height = elementLength(sides[3], frames.height);
      if (x === null || y === null || width === null || height === null) return null;
      return roundedRegion(
        { x: viewportX(x), y: viewportY(y), width: width * frames.scale.x, height: height * frames.scale.y },
        round,
      );
    }
    if (name === "circle" || name === "ellipse") {
      const tokens = tokensOf(body);
      const split = tokens.indexOf("at");
      const radii = split === -1 ? tokens : tokens.slice(0, split);
      const centreTokens = split === -1 ? [] : tokens.slice(split + 1);
      const centre = (index: number) => {
        const part = centreTokens[index] ?? "50%";
        return part === "center"
          ? (index === 0 ? frames.width : frames.height) / 2
          : elementLength(part, index === 0 ? frames.width : frames.height);
      };
      const cx = centre(0);
      const cy = centre(1);
      if (cx === null || cy === null) return null;
      if (name === "circle") {
        const token = (radii[0] ?? "").trim();
        const percent = Number.parseFloat(token);
        const resolved = token === "farthest-side"
          ? Math.max(cx, frames.width - cx, cy, frames.height - cy)
          : token === "" || token === "closest-side"
            ? Math.min(cx, frames.width - cx, cy, frames.height - cy)
            : token.endsWith("%")
              ? (Number.isFinite(percent) ? percent * Math.hypot(frames.width, frames.height) / Math.SQRT2 / 100 : null)
              : elementLength(radii[0], frames.height);
        if (resolved === null || !(resolved >= 0)) return null;
        return ellipseRegion(viewportX(cx), viewportY(cy), resolved * frames.scale.x, resolved * frames.scale.y);
      }
      const rx = radii[0] === undefined ? Math.min(cx, frames.width - cx) : radiusOf(radii[0], frames.width, cx);
      const ry = radii[1] === undefined ? Math.min(cy, frames.height - cy) : radiusOf(radii[1], frames.height, cy);
      if (rx === null || ry === null || !(rx >= 0) || !(ry >= 0)) return null;
      return ellipseRegion(viewportX(cx), viewportY(cy), rx * frames.scale.x, ry * frames.scale.y);
    }
    if (name === "polygon") {
      const points = body
        .replace(/^(?:evenodd|nonzero)\s*,\s*/i, "")
        .split(",")
        .map((pair) => tokensOf(pair))
        .filter((pair) => pair.length >= 2)
        .map((pair) => ({
          x: elementLength(pair[0], frames.width),
          y: elementLength(pair[1], frames.height),
        }));
      if (points.length < 3 || points.some((point) => point.x === null || point.y === null)) return null;
      return polygonRegion(points.map((point) => ({ x: viewportX(point.x!), y: viewportY(point.y!) })));
    }
    if (name === "path") {
      const context = ink();
      if (context === null) return null;
      const data = body.replace(/^(["'])([\s\S]*)\1$/, "$2");
      let inkPath: Path2D;
      try { inkPath = new Path2D(data); } catch { return null; }
      return {
        box: null,
        covers: (x, y) => context.isPointInPath(
          inkPath, (x - frames.bounds.x) / frames.scale.x, (y - frames.bounds.y) / frames.scale.y),
      };
    }
    if (name === "url") {
      const reference = /^["']?#([^"')\s]+)["']?$/.exec(body);
      return reference === null ? null : referencedClip(reference[1]!, frames);
    }
    return null;
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
  function visibleRegion(rect: Box, parent: Element): Visible | null {
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
      if (ancestor.matches('[role="tooltip"], [role="dialog"], [popover]')) return null;
      const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
      const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
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
      }
      // Range geometry ignores `clip-path`, so the shape decides on its own. A shape
      // that is not modelled leaves the rectangle alone rather than guessing.
      const region = clipRegion(clipPath, framesOf(ancestor, bounds));
      if (region !== null) {
        next = region.box === null ? next : intersect(next, region.box);
        if (next === null) return null;
        visible = { box: next, shapes: region.covers === null ? visible.shapes : [...visible.shapes, region.covers] };
      } else {
        visible = { box: next, shapes: visible.shapes };
      }
    }
    return visible;
  }
  for (const selector of excludeSelectors) {
    try { document.querySelectorAll(selector); }
    catch { return { elementsInspected: 0, overlaps: [], selectorError: selector }; }
  }
  const candidates = document.querySelectorAll('table th, table td, [role="table"] [role="cell"], [role="table"] [role="rowheader"], [role="table"] [role="columnheader"], [role="grid"] [role="gridcell"], [role="grid"] [role="rowheader"], [role="grid"] [role="columnheader"]');
  interface Cell { element: Element; rect: Box; group: { byX: Map<number, Cell[]>; byY: Map<number, Cell[]> } }
  const groups = new Map<Element, Cell["group"]>();
  const inspected: Cell[] = [];
  const bandSize = 64;
  /** Indexing and lookup must agree on band boundaries, so both use one range. */
  function bandRange(start: number, size: number): { readonly first: number; readonly last: number } {
    return { first: Math.floor(start / bandSize), last: Math.floor((start + size - 0.001) / bandSize) };
  }
  function index(bands: Map<number, Cell[]>, start: number, size: number, cell: Cell): void {
    const { first, last } = bandRange(start, size);
    for (let band = first; band <= last; band++) {
      const entries = bands.get(band) ?? [];
      entries.push(cell);
      bands.set(band, entries);
    }
  }
  function nearby(bands: Map<number, Cell[]>, start: number, size: number): Set<Cell> {
    const found = new Set<Cell>();
    const { first, last } = bandRange(start, size);
    for (let band = first; band <= last; band++) {
      for (const cell of bands.get(band) ?? []) found.add(cell);
    }
    return found;
  }
  for (const element of candidates) {
    const scope = element.closest('table, [role="table"], [role="grid"]');
    if (scope === null || element.closest('tr, [role="row"]') === null || !rendered(element)) continue;
    let group = groups.get(scope);
    if (group === undefined) {
      group = { byX: new Map(), byY: new Map() };
      groups.set(scope, group);
    }
    const rect = box(element.getBoundingClientRect());
    const cell = { element, rect, group };
    index(group.byX, rect.x, rect.width, cell);
    index(group.byY, rect.y, rect.height, cell);
    if (!excludeSelectors.some((selector) => element.matches(selector))) inspected.push(cell);
  }
  const overlaps: Overlap[] = [];
  for (const { element: cell, rect: cellBox, group } of inspected) {
    const horizontal = [...nearby(group.byY, cellBox.y, cellBox.height)].filter((peer) => peer.element !== cell &&
      peer.rect.y < cellBox.y + cellBox.height && peer.rect.y + peer.rect.height > cellBox.y);
    const right = horizontal.filter(({ rect }) => rect.x >= cellBox.x + cellBox.width - 1)
      .sort((a, b) => a.rect.x - b.rect.x);
    const left = horizontal.filter(({ rect }) => rect.x + rect.width <= cellBox.x + 1)
      .sort((a, b) => b.rect.x + b.rect.width - a.rect.x - a.rect.width);
    // Keep the nearest cell at each height, including cells across a rowspan.
    const lateral = (peers: Cell[], edge: "left" | "right") => {
      const chosen: Cell[] = [];
      for (const peer of peers) {
        if (!chosen.some((between) =>
          (edge === "right" ? between.rect.x < peer.rect.x : between.rect.x + between.rect.width > peer.rect.x + peer.rect.width) &&
          between.rect.y < peer.rect.y + peer.rect.height && between.rect.y + between.rect.height > peer.rect.y)) chosen.push(peer);
      }
      return chosen;
    };
    const vertical = [...nearby(group.byX, cellBox.x, cellBox.width)].filter((peer) => peer.element !== cell &&
      peer.rect.x < cellBox.x + cellBox.width && peer.rect.x + peer.rect.width > cellBox.x);
    const below = vertical.filter(({ rect }) => rect.y >= cellBox.y + cellBox.height - 1)
      .sort((a, b) => a.rect.y - b.rect.y);
    const above = vertical.filter(({ rect }) => rect.y + rect.height <= cellBox.y + 1)
      .sort((a, b) => b.rect.y + b.rect.height - a.rect.y - a.rect.height);
    // A separated-border table has a gap between rows; keep the nearest cell in each column.
    const nearest = (peers: Cell[]) => {
      const chosen: Cell[] = [];
      for (const peer of peers) {
        if (!chosen.some((between) =>
          between.rect.x < peer.rect.x + peer.rect.width && between.rect.x + between.rect.width > peer.rect.x)) chosen.push(peer);
      }
      return chosen;
    };
    const neighbors = [
      ...lateral(right, "right").map((peer) => ({ ...peer, direction: "right" as const })),
      ...lateral(left, "left").map((peer) => ({ ...peer, direction: "left" as const })),
      ...nearest(below).map((peer) => ({ ...peer, direction: "below" as const })),
      ...nearest(above).map((peer) => ({ ...peer, direction: "above" as const })),
    ];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const breaches = new Map<Element, number>();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      const parent = text.parentElement;
      if (parent === null || !text.nodeValue?.trim() || !rendered(parent)) continue;
      const style = getComputedStyle(parent);
      // A hidden cell or wrapper still paints a descendant that restores visibility.
      if (style.visibility === "hidden" || style.visibility === "collapse") continue;
      const ink = style.webkitTextFillColor || style.color;
      const transparent = (color: string) => color === "transparent" || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color);
      const shadow = style.textShadow !== "none" && !/^(?:transparent|(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\))\s/.test(style.textShadow);
      const stroke = Number.parseFloat(style.webkitTextStrokeWidth) > 0 && !transparent(style.webkitTextStrokeColor);
      if (transparent(ink) && !shadow && !stroke) continue;
      // Nested tables/grids belong to their own cells, not the containing cell.
      if (parent.closest('th, td, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]') !== cell) continue;
      // Whitespace can advance a Range without painting a glyph (notably under white-space: pre).
      for (const match of text.data.matchAll(/\S+/g)) {
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        for (const fragment of range.getClientRects()) {
          if (fragment.width <= 0 || fragment.height <= 0) continue;
          const visible = visibleRegion(box(fragment), parent);
          if (visible === null) continue;
          for (const { element, rect, direction } of neighbors) {
            const overlap = intersect(visible.box, rect);
            if (overlap === null) continue;
            // The shape decides inside the overlap too, so a clipped corner cannot
            // report a neighbour the visible sliver never reaches.
            const shown = visible.shapes.length === 0 ? overlap : shapeOverlap(visible.shapes, overlap);
            if (shown === null) continue;
            const distance = direction === "right" || direction === "left" ? shown.width : shown.height;
            breaches.set(element, Math.max(breaches.get(element) ?? 0, distance));
          }
        }
      }
    }
    for (const [adjacent, overlapPx] of breaches) {
      if (overlapPx > 1) overlaps.push({ cell: descriptor(cell), adjacent: descriptor(adjacent), geometry: cellBox, overlapPx });
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
    data = await page.evaluate(extract, {
      excludeSelectors: rule.excludeSelectors,
      stableAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
      semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
    });
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
