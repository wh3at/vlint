import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderCliHelpContract } from "../../src/cli";

test("every visible Commander scope matches the combined help contract", async () => {
  const expected = await Bun.file(join(import.meta.dir, "fixtures/cli-help.terminal.txt")).text();
  expect(renderCliHelpContract("0.3.0")).toBe(expected);
});
