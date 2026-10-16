import { expect, test } from "bun:test";

const container = process.env.VLINT_PRIVILEGE_CONTAINER;
(container ? test : test.skip)("compiled preparation preserves non-root sudo prompts and scopes prompt/downloader cancellation", async () => {
  const proc = Bun.spawn(["docker", "exec", container!, "python3", "/lane/tests/acceptance/browser-privilege-55.py"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  console.log(stdout);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const results = JSON.parse(stdout);
  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result.checkpointReached).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.survivors).toEqual([]);
    expect(result.ownedProcesses).toBeGreaterThan(1);
  }
  expect(results[3].downloaderObserved).toBe(true);
}, 180_000);
