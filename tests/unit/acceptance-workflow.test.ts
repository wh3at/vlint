import { expect, test } from "bun:test";
import { resolve } from "node:path";

async function workflow(): Promise<Record<string, any>> {
  return Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, "../../.github/workflows/ci.yml")).text()) as Record<string, any>;
}

test("every PR runs the compiled three-engine and isolated privilege acceptance gates", async () => {
  const ci = await workflow();
  expect(ci.on.pull_request.types).toContain("synchronize");
  for (const [name, command] of [
    ["three-engine-acceptance", "bun run test:acceptance:three-engine"],
    ["browser-privilege", "bun run test:acceptance:privilege"],
  ] as const) {
    const job = ci.jobs[name];
    expect(job.needs).toBe("build");
    expect(job.if).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.steps.some((step: any) => step.run === command)).toBe(true);
    const download = job.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download.with).toEqual({ name: "vlint-linux-x64", path: "dist" });
    expect(job.steps.some((step: any) => /build:linux-x64/.test(step.run ?? ""))).toBe(false);
    const upload = job.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("always()");
    expect(upload.with.path).toBe("dist/acceptance/");
  }
});

test("the existing required browser-tests context fails unless every browser gate succeeds", async () => {
  const ci = await workflow();
  const gate = ci.jobs["browser-tests"];
  expect(gate.needs).toEqual(["browser-integration", "three-engine-acceptance", "browser-privilege"]);
  expect(gate.if).toBe("always()");
  const step = gate.steps[0];
  expect(step.env).toEqual({
    INTEGRATION: "${{ needs.browser-integration.result }}",
    THREE_ENGINE: "${{ needs.three-engine-acceptance.result }}",
    PRIVILEGE: "${{ needs.browser-privilege.result }}",
  });
  const run = (env: Record<string, string>) => Bun.spawnSync(["bash", "-e", "-c", step.run], { env, stdout: "pipe", stderr: "pipe" }).exitCode;
  const success = { INTEGRATION: "success", THREE_ENGINE: "success", PRIVILEGE: "success" };
  expect(run(success)).toBe(0);
  for (const variable of Object.keys(success)) {
    for (const result of ["failure", "skipped", "cancelled", ""]) expect(run({ ...success, [variable]: result })).not.toBe(0);
  }
});
