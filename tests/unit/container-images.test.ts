import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { containerImageFailures } from "../../scripts/check-container-images";

const pinned = `ubuntu@sha256:${"a".repeat(64)}`;

describe("container image pins", () => {
  test.each(["ubuntu:24.04", "ubuntu:latest", "ubuntu", "ghcr.io/example/browser:v1", `ubuntu@sha256:${"a".repeat(63)}`])("rejects mutable or malformed FROM %s", image => {
    expect(containerImageFailures("tests/Containerfile", `FROM ${image}\n`)).toHaveLength(1);
  });

  test("accepts digests, scratch, platforms and previously declared build stages", () => {
    expect(containerImageFailures("Dockerfile", `FROM --platform=linux/amd64 ${pinned} AS build\nFROM build AS final\nFROM scratch\n`)).toEqual([]);
  });

  test("checks shell base image declarations without rejecting locally built images", () => {
    expect(containerImageFailures("tests/validate.sh", `IMAGE="vlint:local"\nBASE_IMAGE="${pinned}"\n`)).toEqual([]);
    expect(containerImageFailures("tests/validate.sh", 'export BASE_IMAGE="ubuntu:24.04"\n')).toEqual([
      "tests/validate.sh:1: container image must use @sha256:<64 lowercase hex digits>: ubuntu:24.04",
    ]);
  });

  test("checks literal and variable shell run images while allowing images built in the same script", () => {
    expect(containerImageFailures("tests/validate.sh", `docker run --rm -e A=B ${pinned} true\n`)).toEqual([]);
    expect(containerImageFailures("tests/validate.sh", 'docker run --rm ubuntu:24.04 true\n')).toHaveLength(1);
    expect(containerImageFailures("tests/validate.sh", 'IMAGE="ubuntu:24.04"\ndocker run "$IMAGE" true\n')).toHaveLength(1);
    expect(containerImageFailures("tests/validate.sh", 'IMAGE="vlint:local"\ndocker build -t "$IMAGE" .\ndocker run "$IMAGE" true\n')).toEqual([]);
    expect(containerImageFailures("tests/validate.sh", 'docker run "$UNKNOWN_IMAGE" true\n')).toHaveLength(1);
  });

  test.each([
    'await docker("run", "--name", name, "-d", "-e", "A=B", "-v", `${root}:/lane:ro`, IMAGE, "sleep", "infinity");',
    'Bun.spawn(["docker", "run", "--rm", "--network=none", IMAGE, "true"]);',
    'command(["docker", "run", "--", IMAGE, "true"]);',
  ])("checks TypeScript docker run image arguments: %s", command => {
    expect(containerImageFailures("tests/container.test.ts", command.replace("IMAGE", JSON.stringify(pinned)))).toEqual([]);
    const failures = containerImageFailures("tests/container.test.ts", command.replace("IMAGE", '"ubuntu:24.04"'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("tests/container.test.ts:1:");
    expect(failures[0]).toContain("ubuntu:24.04");
  });

  test("checks constant image references and fails on unresolved images or unknown options", () => {
    expect(containerImageFailures("tests/container.test.ts", `const image = "${pinned}"; docker("run", image);`)).toEqual([]);
    expect(containerImageFailures("tests/container.test.ts", 'docker("run", process.env.IMAGE);')).toHaveLength(1);
    expect(containerImageFailures("tests/container.test.ts", `docker("run", "--unknown", "value", "${pinned}");`)[0]).toContain("unsupported docker run option");
  });

  test("ignores comments, unrelated strings and commands that do not start containers", () => {
    expect(containerImageFailures("tests/container.test.ts", 'const example = "ubuntu:24.04"; docker("exec", "container", "true");')).toEqual([]);
    expect(containerImageFailures("Containerfile", '# FROM ubuntu:24.04\n')).toEqual([]);
  });

  test("runs the image check in CI and the full local test command", async () => {
    const root = resolve(import.meta.dir, "../..");
    const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/ci.yml")).text()) as Record<string, any>;
    expect(workflow.jobs.architecture.steps.some((step: any) => step.run === "bun run check:container-images")).toBe(true);
    const pkg = await Bun.file(join(root, "package.json")).json();
    expect(pkg.scripts["check:container-images"]).toContain("scripts/check-container-images.ts");
    expect(pkg.scripts["test:all"]).toContain("bun run check:container-images");
  });

  test("CLI scans the repository and exits nonzero for unpinned image references", async () => {
    const root = await mkdtemp(join(tmpdir(), "vlint-image-pins-"));
    try {
      await mkdir(join(root, "tests"));
      const file = join(root, "tests", "container.test.ts");
      const script = resolve(import.meta.dir, "../../scripts/check-container-images.ts");
      const run = () => Bun.spawnSync([process.execPath, script, root]);
      await writeFile(file, 'docker("run", "ubuntu:24.04");');
      const failed = run();
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr.toString()).toContain("tests/container.test.ts:1:");
      await writeFile(file, `docker("run", "${pinned}");`);
      const passed = run();
      expect(passed.exitCode).toBe(0);
      expect(passed.stdout.toString()).toContain("container image pins ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
