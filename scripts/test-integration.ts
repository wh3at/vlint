import { Glob } from "bun";

const groups = [
  [
    "browser-install.test.ts",
    "cli-acceptance.test.ts",
    "result-transitions.test.ts",
  ],
  ["browser-lifecycle.test.ts"],
  ["readiness.test.ts"],
  ["measurement-contract.test.ts"],
  ["local-rules.test.ts"],
  ["tab-label-single-line.test.ts"],
  ["table-header-single-line.test.ts"],
  ["page-horizontal-overflow.test.ts"],
  ["table-cell-text-overlap.test.ts"],
  ["table-cell-excluded-neighbors.test.ts"],
  ["svg-text-clipping.test.ts"],
  ["svg-text-clipping-pairs.test.ts"],
  ["svg-text-clipping-tspan.test.ts"],
];

const directory = "tests/integration";
const scheduled = new Set(groups.flat());
const discovered = Array.from(
  new Glob("**/*.test.ts").scanSync(directory),
).sort();

for (const file of discovered) {
  if (!scheduled.has(file)) groups.push([file]);
}

for (const group of groups) {
  const result = Bun.spawn({
    cmd: [process.execPath, "test", ...group.map((file) => `${directory}/${file}`)],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await result.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
