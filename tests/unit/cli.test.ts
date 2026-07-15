import { describe, expect, test } from "bun:test";
import { parseCli } from "../../src/cli";

function invocation(args: readonly string[]) {
  const parsed = parseCli(args, "0.3.0");
  expect(parsed.kind).toBe("invocation");
  if (parsed.kind !== "invocation") throw new Error("expected invocation");
  return parsed.invocation;
}

function terminal(args: readonly string[]) {
  const parsed = parseCli(args, "0.3.0");
  expect(parsed.kind).toBe("terminal");
  if (parsed.kind !== "terminal") throw new Error("expected terminal outcome");
  return parsed;
}

describe("Commander CLI grammar", () => {
  test.each([
    [["check"], { kind: "check", url: null, format: "terminal" }],
    [["check", "--format=json", "--url", "https://example.com"], { kind: "check", url: "https://example.com", format: "json" }],
    [["check", "--format", "terminal", "--format", "json"], { kind: "check", url: null, format: "json" }],
    [["browser", "install"], { kind: "browser-install", force: false, withDeps: false }],
    [["browser", "install", "--force", "--with-deps"], { kind: "browser-install", force: true, withDeps: true }],
    [["init"], { kind: "init" }],
    [["setup"], { kind: "setup" }],
  ] as const)("accepts Commander-standard invocation %#", (args, expected) => {
    expect(invocation(args)).toEqual(expected);
  });

  test.each([
    [[]],
    [["-h"]],
    [["--help"]],
    [["--help", "check"]],
    [["help"]],
  ] as const)("renders root help for %#", (args) => {
    const parsed = terminal(args);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.stdout).toContain("Usage: vlint");
    expect(parsed.stdout).toContain("check");
    expect(parsed.stdout.endsWith("\n")).toBe(true);
  });

  test.each([
    [["check", "--help"], "Usage: vlint check", "--format"],
    [["browser", "--help"], "Usage: vlint browser", "install"],
    [["browser", "install", "-h"], "Usage: vlint browser install", "--with-deps"],
    [["init", "--help"], "Usage: vlint init", "Create vlint.config.json"],
    [["setup", "--help"], "Usage: vlint setup", "install the browser"],
    [["help", "check"], "Usage: vlint check", "--format"],
    [["browser", "help", "install"], "Usage: vlint browser install", "--with-deps"],
  ] as const)("renders scoped help for %#", (args, usage, detail) => {
    const parsed = terminal(args);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.stdout).toContain(usage);
    expect(parsed.stdout).toContain(detail);
  });

  test.each([
    [["check", "--unknown", "--help"]],
    [["check", "--format", "yaml", "--help"]],
    [["check", "--url", "--help"]],
    [["browser", "install", "--unknown", "--help"]],
  ] as const)("lets scoped help win over invalid neighboring tokens %#", (args) => {
    const parsed = terminal(args);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.stdout).toContain(args[0] === "browser" ? "Usage: vlint browser install" : "Usage: vlint check");
  });

  test.each([
    [["bogus"], "unknown command"],
    [["check", "--unknown"], "unknown option"],
    [["check", "--url"], "argument missing"],
    [["check", "--format", "yaml"], "Allowed choices"],
    [["check", "--url", "file:///tmp/page"], "unsupported URL protocol"],
    [["browser", "other"], "unknown command"],
    [["help", "unknown"], "Usage: vlint"],
  ] as const)("returns Commander usage errors for %#", (args, message) => {
    const parsed = terminal(args);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stdout).toBe("");
    expect(parsed.stderr).toContain(message);
    expect(parsed.stderr.endsWith("\n")).toBe(true);
  });

  test("keeps untrusted diagnostics inert and redacts URL credentials", () => {
    const unsafe = terminal(["bogus\u001b\r\n\u202e"]);
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.stderr).not.toContain("\u001b");
    expect(unsafe.stderr).not.toContain("\r");
    expect(unsafe.stderr).not.toContain("\n\u202e");
    expect(unsafe.stderr).toContain("\\u{1b}\\r\\n\\u{202e}");

    for (const args of [
      ["https://user:password@example.com/x?token=secret#fragment"],
      ["https://user:password@example.com/x?token=secret#fragment\u001b"],
      ["--bogus=https://user:password@example.com/x?token=secret#fragment"],
      ["check", "--url", "https://user:password@example.com/x?token=secret#fragment"],
    ]) {
      const parsed = terminal(args);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.stderr).not.toContain("user:password");
      expect(parsed.stderr).not.toContain("password");
      expect(parsed.stderr).not.toContain("secret");
      expect(parsed.stderr).not.toContain("fragment");
    }
  });

  test("renders safe help when an unsafe neighboring token is present", () => {
    const parsed = terminal(["check", "bad\u001b", "--help"]);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.stdout).toContain("Usage: vlint check");
    expect(parsed.stdout).not.toContain("\u001b");
  });

  test("supports Commander version aliases and preserves vlint version output", () => {
    for (const flag of ["--version", "-V"]) {
      const parsed = terminal([flag]);
      expect(parsed).toEqual({
        kind: "terminal",
        exitCode: 0,
        stdout: "vlint 0.3.0\n",
        stderr: "",
      });
    }
  });
});
