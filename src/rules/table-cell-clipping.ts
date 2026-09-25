/// <reference lib="dom" />

export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ClipCoordinates {
  readonly bounds: Box;
  readonly scale: { readonly x: number; readonly y: number };
  /** The border box in element space, where `clip-path` lengths are written. */
  readonly width: number;
  readonly height: number;
}
export interface Region {
  /** The region's rectangle, or null when only the shape itself bounds it. */
  readonly box: Box | null;
  /** Null when the region is exactly its box; otherwise whether a point is inside the shape. */
  readonly covers: ((x: number, y: number) => boolean) | null;
}

export type ClippingEngine = (value: string, coordinates: ClipCoordinates) => Region | null;

/** Self-contained so the same clipping engine runs in tests and in Playwright's page world. */
export function createClippingEngine(): ClippingEngine {
  /** One element-space length, or null when CSS wrote a keyword instead. */
  function elementLength(part: string | undefined, base: number): number | null {
    const text = (part ?? "").trim();
    const expression = /^calc\(([\s\S]*)\)$/i.exec(text);
    if (expression !== null) return calcLength(expression[1]!, base);
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

  /** `round` radii shrink until opposite corners meet on the shape rectangle. */
  function cornerRadii(
    tokens: readonly string[],
    frames: ClipCoordinates,
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

  /**
   * A `calc()` expression reduced to one element-space length. Only `+`, `-`, `*` and `/` over
   * lengths, percentages and numbers are modelled, with nesting; a keyword such as `min()` or a
   * unit with no fixed size leaves the expression unresolved, so the caller keeps the shape
   * unmodelled instead of reading an unreadable expression as a zero clip.
   */
  function calcLength(text: string, base: number): number | null {
    interface Term { readonly value: number; readonly length: boolean }
    let index = 0;
    function skipSpace(): void {
      while (index < text.length && /\s/.test(text[index]!)) index += 1;
    }
    function atom(): Term | null {
      skipSpace();
      if (text[index] === "(") {
        index += 1;
        const inner = sum();
        skipSpace();
        if (inner === null || text[index] !== ")") return null;
        index += 1;
        return inner;
      }
      const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?([a-z%]*)/i.exec(text.slice(index));
      if (match === null) return null;
      index += match[0]!.length;
      const value = Number.parseFloat(match[0]!);
      const unit = match[1]!.toLowerCase();
      if (unit === "%") return { value: value * base / 100, length: true };
      if (unit === "") return { value, length: false };
      const scale = SVG_UNITS[unit];
      return scale === undefined ? null : { value: value * scale, length: true };
    }
    function product(): Term | null {
      let left = atom();
      for (;;) {
        if (left === null) return null;
        skipSpace();
        const operator = text[index];
        if (operator !== "*" && operator !== "/") return left;
        index += 1;
        const right = atom();
        // CSS multiplies and divides by a number, so two lengths have no product.
        if (right === null || left.length === right.length) return null;
        if (operator === "*") left = { value: left.value * right.value, length: true };
        else if (right.value !== 0) left = { value: left.value / right.value, length: left.length };
        else return null;
      }
    }
    function sum(): Term | null {
      let left = product();
      for (;;) {
        if (left === null) return null;
        skipSpace();
        const operator = text[index];
        if (operator !== "+" && operator !== "-") return left;
        index += 1;
        const right = product();
        if (right === null || left.length !== right.length) return null;
        left = {
          value: operator === "+" ? left.value + right.value : left.value - right.value,
          length: left.length,
        };
      }
    }
    const resolved = sum();
    skipSpace();
    if (resolved === null || !resolved.length || index !== text.length) return null;
    return resolved.value;
  }

  /**
   * A negative `r`/`rx`/`ry` is an SVG error: the browser draws that axis with the shape's
   * other radius, or draws nothing when it has none. `Path2D.arc` and `Path2D.ellipse` throw
   * on the invalid value itself.
   */
  function drawableRadius(value: number, other: number): number {
    return value < 0 ? Math.max(other, 0) : value;
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
      // An invalid radius draws nothing, so the reference stays modelled as an empty shape
      // instead of becoming an unmodelled one that leaves the text clipped by nothing.
      if (r < 0) return geometry;
      geometry.arc(cx, cy, r, 0, Math.PI * 2);
      return geometry;
    }
    if (element.localName === "ellipse") {
      const cx = length("cx", viewport.width, 0), cy = length("cy", viewport.height, 0);
      // An absent `rx`/`ry` is the SVG `auto` value: the axis takes the other axis' radius,
      // while an explicit zero still disables rendering of the element.
      const radiusX = optional("rx", viewport.width), radiusY = optional("ry", viewport.height);
      if (cx === null || cy === null || radiusX === null || radiusY === null) return null;
      const rx = radiusX ?? radiusY ?? 0, ry = radiusY ?? radiusX ?? 0;
      geometry.ellipse(cx, cy, drawableRadius(rx, ry), drawableRadius(ry, rx), 0, 0, Math.PI * 2);
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
  function referencedClip(id: string, frames: ClipCoordinates): Region | null {
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
    const children = [...clip.children]
      .filter((child) => !["title", "desc", "metadata"].includes(child.localName))
      // A hidden shape contributes no geometry, so it cannot keep the clip open.
      // `visibility` is inherited, but an ancestor's `display: none` is not.
      .filter((child) => {
        for (let current: Element | null = child; current !== null && current !== clip; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.contentVisibility === "hidden" ||
              (current === child && (style.visibility === "hidden" || style.visibility === "collapse"))) return false;
        }
        return true;
      });
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
  function clipRegion(value: string, frames: ClipCoordinates): Region | null {
    const shape = /^([a-z-]+)\(([\s\S]*)\)$/.exec(value.trim());
    if (shape === null) return null;
    const name = shape[1]!;
    const body = shape[2]!.trim();
    /**
     * Whitespace-separated parts, keeping a functional notation such as `calc(50% + 2px)` whole.
     * A plain split cuts the expression into fragments no length can resolve.
     */
    const tokensOf = (text: string): string[] => {
      const tokens: string[] = [];
      let token = "";
      let depth = 0;
      for (const character of text) {
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        else if (depth === 0 && /\s/.test(character)) {
          if (token.length > 0) tokens.push(token);
          token = "";
          continue;
        }
        token += character;
      }
      if (token.length > 0) tokens.push(token);
      return tokens;
    };
    const viewportX = (length: number) => frames.bounds.x + length * frames.scale.x;
    const viewportY = (length: number) => frames.bounds.y + length * frames.scale.y;
    const viewportRadii = (radii: readonly { x: number; y: number }[]) =>
      radii.map((radius) => ({ x: radius.x * frames.scale.x, y: radius.y * frames.scale.y }));
    const sidesOf = (text: string) => {
      const round = /(?:^|\s)round\s+([\s\S]+)$/.exec(text);
      return {
        sides: tokensOf(round === null ? text : text.slice(0, round.index)),
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
              // A circle's percentage radius resolves against the reference box diagonal,
              // so a `calc()` radius has to resolve against that same length.
              : elementLength(radii[0], Math.hypot(frames.width, frames.height) / Math.SQRT2);
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

  return clipRegion;
}
