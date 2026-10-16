import { expect, test } from "bun:test";
import { installBrowser } from "../../src/browser/install";
import { parseBrowserInstallArgs } from "../../src/commands/browser-install";

test("browser install accepts repair but not independent engines, versions, or dependency modes", () => {
  expect(parseBrowserInstallArgs([])).toEqual({ ok: true, value: { force: false } });
  expect(parseBrowserInstallArgs(["--force"])).toEqual({ ok: true, value: { force: true } });
  for (const args of [["--force", "--force"], ["--with-deps"], ["firefox"], ["--version", "151.0"]]) {
    expect(parseBrowserInstallArgs(args).ok).toBe(false);
  }
});

test("browser repair reports an interrupted operation before starting preparation", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await installBrowser({ force: true, signal: controller.signal });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("signal-interrupt");
});
