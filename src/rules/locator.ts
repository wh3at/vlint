/**
 * Light-DOM CSS locator generation (KTD9).
 *
 * Preference order: unique id -> stable data attribute -> semantic attribute
 * -> ancestor positional path. A locator is only chosen once it is verified to
 * resolve to exactly one element in the same document.
 *
 * The pure helpers here (composition + uniqueness selection) are unit-tested
 * directly. The rule evaluator drives `chooseUniqueLocator` with an
 * authoritative `CountMatches` that performs a real `document.querySelectorAll`
 * inside the browser, so uniqueness is checked against the live document rather
 * than a synthetic descriptor set.
 */

/** A single step in the positional ancestor path. */
export interface PathStep {
  /** Lowercased element tag name (no namespace). */
  readonly tag: string;
  /** 1-based `:nth-of-type` index among same-tag siblings under the same parent. */
  readonly index: number;
}

/** Raw, browser-extracted data describing one element for locator purposes. */
export interface ElementDescriptor {
  /** Lowercased tag name of the element. */
  readonly tag: string;
  /** `id` attribute value, or null when absent or empty. */
  readonly id: string | null;
  /** First present stable data attribute (data-testid, ...), or null. */
  readonly stableDataAttribute: { readonly name: string; readonly value: string } | null;
  /** First present semantic attribute (aria-label, role), or null. */
  readonly semanticAttribute: { readonly name: string; readonly value: string } | null;
  /** Positional path from the document root down to and including the element. */
  readonly path: readonly PathStep[];
}

/** Returns how many elements a CSS selector matches in a given document. */
export type CountMatches = (selector: string) => number;

/** Preference order for stable data attributes. */
export const LOCATOR_STABLE_DATA_ATTRIBUTES = [
  "data-testid",
  "data-test",
  "data-cy",
  "data-qa",
] as const;

/** Preference order for semantic attributes. */
export const LOCATOR_SEMANTIC_ATTRIBUTES = ["aria-label", "role"] as const;

/**
 * Escape an identifier per the CSSOM "serialize an identifier" algorithm,
 * mirroring the browser `CSS.escape` used in-page so selectors composed in
 * Node are accepted verbatim by `document.querySelectorAll`.
 */
export function cssEscape(value: string): string {
  const string = String(value);
  const length = string.length;
  const firstCodeUnit = string.charCodeAt(0);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0x0000) {
      result += "\uFFFD";
      continue;
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        firstCodeUnit === 0x002d)
    ) {
      result += "\\" + codeUnit.toString(16) + " ";
      continue;
    }
    if (
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a) ||
      codeUnit === 0x005f ||
      codeUnit === 0x002d ||
      codeUnit >= 0x00a1
    ) {
      result += string.charAt(index);
      continue;
    }
    result += "\\" + string.charAt(index);
  }
  return result;
}

/**
 * Produce candidate selectors for an element in KTD9 preference order. The
 * positional path is always last and is unique by construction; earlier
 * selectors are shorter but may not be unique, which the caller verifies.
 * Attribute values are escaped for a double-quoted `[a="…"]` selector
 * (backslash first, then the quote) so composed selectors are accepted
 * verbatim by `document.querySelectorAll`.
 */
export function composeLocators(desc: ElementDescriptor): readonly string[] {
  const candidates: string[] = [];
  if (desc.id !== null && desc.id.length > 0) {
    candidates.push(`#${cssEscape(desc.id)}`);
  }
  if (desc.stableDataAttribute !== null) {
    const escaped = desc.stableDataAttribute.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    candidates.push(`[${desc.stableDataAttribute.name}="${escaped}"]`);
  }
  if (desc.semanticAttribute !== null) {
    const escaped = desc.semanticAttribute.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    candidates.push(`[${desc.semanticAttribute.name}="${escaped}"]`);
  }
  candidates.push(
    desc.path.map((step) => `${cssEscape(step.tag)}:nth-of-type(${step.index})`).join(" > "),
  );
  return candidates;
}

/**
 * Return the first composed selector that matches exactly one element, or null
 * when none is unique. `count` is the document-query seam: unit tests supply a
 * synthetic counter; the rule evaluator supplies a real `querySelectorAll`.
 */
export function chooseUniqueLocator(
  desc: ElementDescriptor,
  count: CountMatches,
): string | null {
  for (const selector of composeLocators(desc)) {
    if (count(selector) === 1) {
      return selector;
    }
  }
  return null;
}
