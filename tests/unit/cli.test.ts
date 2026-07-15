import { describe, expect, test } from "bun:test";
import { parseCli } from "../../src/cli";

describe("CLI grammar", () => {
  test.each([
    [[], { kind: "invalid", message: "unknown argument: " }],
    [["--version", "extra"], { kind: "invalid", message: "unknown argument: --version" }],
    [["check", "https://example.com"], { kind: "invalid", message: "unknown argument: https://example.com" }],
    [["check", "--unknown"], { kind: "invalid", message: "unknown argument: --unknown" }],
    [["check", "--url"], { kind: "invalid", message: "--url requires a value" }],
    [["check", "--url", "--format", "json"], { kind: "invalid", message: "--url requires a value" }],
    [["check", "--url", "https://a.example", "--url", "https://b.example"], { kind: "invalid", message: "duplicate option: --url" }],
    [["check", "--format", "yaml"], { kind: "invalid", message: "--format requires terminal or json" }],
    [["check", "--format", "json", "--format", "terminal"], { kind: "invalid", message: "duplicate option: --format" }],
    [["browser", "install", "--force", "--force"], { kind: "invalid", message: "duplicate option: --force" }],
    [["browser", "install", "--with-deps", "--with-deps"], { kind: "invalid", message: "duplicate option: --with-deps" }],
    [["browser", "install", "--other"], { kind: "invalid", message: "unknown argument: --other" }],
    [["browser", "other"], { kind: "invalid", message: "unknown argument: browser" }],
    [["init", "--url", "https://example.com"], { kind: "invalid", message: "unknown argument: --url" }],
    [["init", "extra"], { kind: "invalid", message: "unknown argument: extra" }],
    [["init", "init"], { kind: "invalid", message: "unknown argument: init" }],
    [["setup", "--force"], { kind: "invalid", message: "unknown argument: --force" }],
    [["check\u001b\r\n"], { kind: "invalid", message: "unknown argument: check\\u{1b}\\r\\n" }],
  ] as const)("rejects invalid invocation %#", (args, expected) => {
    expect(parseCli(args)).toEqual(expected);
  });

  test.each([
    [["--version"], { kind: "version" }],
    [["check"], { kind: "check", url: null, format: "terminal" }],
    [["check", "--format", "json", "--url", "https://example.com"], { kind: "check", url: "https://example.com", format: "json" }],
    [["browser", "install"], { kind: "browser-install", force: false, withDeps: false }],
    [["browser", "install", "--force"], { kind: "browser-install", force: true, withDeps: false }],
    [["browser", "install", "--with-deps", "--force"], { kind: "browser-install", force: true, withDeps: true }],
    [["init"], { kind: "init" }],
    [["setup"], { kind: "setup" }],
  ] as const)("accepts valid invocation %#", (args, expected) => {
    expect(parseCli(args)).toEqual(expected);
  });

});
