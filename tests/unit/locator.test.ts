import { describe, expect, test } from "bun:test";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  chooseUniqueLocator,
  composeLocators,
  cssEscape,
  type ElementDescriptor,
} from "../../src/rules/locator";

function descriptor(over: Partial<ElementDescriptor> & Pick<ElementDescriptor, "path">): ElementDescriptor {
  return {
    tag: over.tag ?? "button",
    id: over.id ?? null,
    stableDataAttribute: over.stableDataAttribute ?? null,
    semanticAttribute: over.semanticAttribute ?? null,
    path: over.path,
  };
}

const fullPath: ElementDescriptor["path"] = [
  { tag: "html", index: 1 },
  { tag: "body", index: 1 },
  { tag: "div", index: 2 },
  { tag: "button", index: 1 },
];

describe("composeLocators preference order (KTD9)", () => {
  test("id is preferred over every other signal", () => {
    const desc = descriptor({
      tag: "button",
      id: "save",
      stableDataAttribute: { name: "data-testid", value: "t1" },
      semanticAttribute: { name: "aria-label", value: "Save" },
      path: fullPath,
    });
    expect(composeLocators(desc)[0]).toBe("#save");
  });

  test("stable data attribute comes after id and before semantic", () => {
    const desc = descriptor({
      id: null,
      stableDataAttribute: { name: "data-testid", value: "t1" },
      semanticAttribute: { name: "aria-label", value: "Save" },
      path: fullPath,
    });
    const sels = composeLocators(desc);
    expect(sels[0]).toBe('[data-testid="t1"]');
    expect(sels[1]).toBe('[aria-label="Save"]');
  });

  test("semantic attribute is used when no id or stable data attribute is present", () => {
    const desc = descriptor({
      id: null,
      stableDataAttribute: null,
      semanticAttribute: { name: "role", value: "tab" },
      path: fullPath,
    });
    expect(composeLocators(desc)[0]).toBe('[role="tab"]');
  });

  test("the positional path is always the final fallback", () => {
    const desc = descriptor({ id: null, stableDataAttribute: null, semanticAttribute: null, path: fullPath });
    const sels = composeLocators(desc);
    expect(sels).toHaveLength(1);
    expect(sels[0]).toBe(
      "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(1)",
    );
  });

  test("an empty id is treated as absent", () => {
    const desc = descriptor({ id: "", path: fullPath });
    expect(composeLocators(desc)[0]).toBe(
      "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(1)",
    );
  });
});

describe("cssEscape", () => {
  test("dotted id is backslash-escaped", () => {
    expect(`#${cssEscape("a.b")}`).toBe("#a\\.b");
  });

  test("a leading digit is escaped as a hex code point", () => {
    expect(`#${cssEscape("1foo")}`).toBe("#\\31 foo");
  });

  test("plain identifiers pass through", () => {
    expect(cssEscape("save_tab-1")).toBe("save_tab-1");
  });
});

describe("composeLocators attribute escaping", () => {
  test("double quotes in attribute values are backslash-escaped", () => {
    const desc = descriptor({
      id: null,
      stableDataAttribute: { name: "data-testid", value: 'a"b' },
      path: fullPath,
    });
    expect(composeLocators(desc)[0]).toBe('[data-testid="a\\"b"]');
  });

  test("backslashes in attribute values are doubled", () => {
    const desc = descriptor({
      id: null,
      stableDataAttribute: { name: "data-testid", value: "a\\b" },
      path: fullPath,
    });
    expect(composeLocators(desc)[0]).toBe('[data-testid="a\\\\b"]');
  });
});

describe("chooseUniqueLocator", () => {
  test("returns the unique id selector when it matches exactly one", () => {
    const desc = descriptor({ id: "save", path: fullPath });
    const count = (sel: string) => (sel === "#save" ? 1 : 9);
    expect(chooseUniqueLocator(desc, count)).toBe("#save");
  });

  test("falls through id to the stable attribute when id is not unique", () => {
    const desc = descriptor({
      id: "dup",
      stableDataAttribute: { name: "data-testid", value: "uniq" },
      path: fullPath,
    });
    const count = (sel: string) => {
      if (sel === "#dup") return 2;
      if (sel === '[data-testid="uniq"]') return 1;
      return 0;
    };
    expect(chooseUniqueLocator(desc, count)).toBe('[data-testid="uniq"]');
  });

  test("falls back to the positional path when nothing shorter is unique", () => {
    const desc = descriptor({ id: "dup", path: fullPath });
    const pathSel = "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(1)";
    const count = (sel: string) => (sel === pathSel ? 1 : 2);
    expect(chooseUniqueLocator(desc, count)).toBe(pathSel);
  });

  test("returns null when no selector is unique", () => {
    const desc = descriptor({ id: "dup", path: fullPath });
    expect(chooseUniqueLocator(desc, () => 2)).toBeNull();
  });
});

describe("locator attribute preference constants", () => {
  test("stable data attributes are ordered testid-first", () => {
    expect(LOCATOR_STABLE_DATA_ATTRIBUTES[0]).toBe("data-testid");
  });

  test("semantic attributes are ordered aria-label before role", () => {
    expect(LOCATOR_SEMANTIC_ATTRIBUTES).toEqual(["aria-label", "role"]);
  });
});
