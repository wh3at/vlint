import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

async function workflow(name: string): Promise<Record<string, any>> {
  return Bun.YAML.parse(await Bun.file(join(root, ".github/workflows", name)).text()) as Record<string, any>;
}

describe("release workflow boundaries", () => {
  test("keeps the Node release manifest aligned with the package version", async () => {
    const config = await Bun.file(join(root, "release-please-config.json")).json();
    const manifest = await Bun.file(join(root, ".release-please-manifest.json")).json();
    const pkg = await Bun.file(join(root, "package.json")).json();
    expect(manifest).toEqual({ ".": pkg.version });
    expect(config["bootstrap-sha"]).toBe("4b00f6ffd3216bf9690eace54719d2ab84570c3b");
    expect(config["release-type"]).toBe("node");
    expect(config.packages).toEqual({ ".": {} });
    expect(config["include-component-in-tag"]).toBe(false);
    expect(config["include-v-in-tag"]).toBe(true);
    expect(config.draft).toBe(true);
    expect(config["force-tag-creation"]).toBe(true);
    expect(config["skip-github-release"]).not.toBe(true);
  });

  test("validates edited PR titles in a secret-free CI job", async () => {
    const ci = await workflow("ci.yml");
    expect(ci.on.pull_request.types).toContain("edited");
    expect(ci.permissions).toEqual({ contents: "read" });
    const steps = ci.jobs.typecheck.steps as Array<Record<string, any>>;
    const titleCheck = steps.find(step => step.name === "Verify PR title encodes release intent");
    expect(titleCheck?.env.PR_TITLE).toBe("${{ github.event.pull_request.title }}");
    expect(titleCheck?.run).toBe("bun run scripts/check-release-intent.ts");
  });

  test("creates App-scoped release artifacts only after successful main CI", async () => {
    const config = await workflow("release-please.yml");
    expect(config.on.workflow_run.workflows).toEqual(["ci"]);
    expect(config.on.workflow_run.branches).toEqual(["main"]);
    expect(config.permissions).toEqual({ contents: "read" });
    const job = config.jobs["release-please"];
    expect(job.if).toContain("workflow_run.event == 'push'");
    expect(job.if).toContain("workflow_run.conclusion == 'success'");
    const steps = job.steps as Array<Record<string, any>>;
    expect(steps.at(0)?.with.repositories).toBe("vlint");
    expect(steps.at(0)?.with["permission-contents"]).toBe("write");
    expect(steps.at(1)?.run).toContain('test "$CI_SHA" = "$main_sha"');
    expect(steps.at(2)?.with.token).toBe("${{ steps.app.outputs.token }}");
  });

  test("validates the App draft before upload and keeps publish approval isolated", async () => {
    const release = await workflow("release.yml");
    const publish = release.jobs.publish;
    expect(publish.environment).toBe("release");
    expect(publish.permissions).toEqual({ contents: "write" });
    const steps = publish.steps as Array<Record<string, any>>;
    const commands = steps.map(step => step.run ?? "").join("\n");
    expect(commands).toContain('.author.login == "vlint-release-please[bot]"');
    expect(commands).toContain(".isDraft == true");
    expect(commands).toContain(".targetCommitish == $sha");
    expect(commands).toContain('gh release view "$TAG"');
    expect(commands).not.toContain("/releases/tags/");
    expect(commands).toContain(".name == $tag");
    expect(commands).toContain("gh release upload");
    expect(commands).toContain("gh release edit");
    expect(commands).not.toContain("gh release create");
    expect(commands).not.toContain("checkout");
    expect(release.jobs["verify-public"].permissions).toEqual({});
    expect(release.jobs["cleanup-on-failure"].needs).toContain("provenance");
    expect(release.jobs["cleanup-on-failure"].if).toContain("needs.provenance.result == 'success'");
    expect(release.jobs["cleanup-on-failure"].if).toContain("github.event_name != 'workflow_dispatch' || needs.publish.result == 'success'");
  });

  test("recovers an existing tag from protected main without rebuilding from main", async () => {
    const release = await workflow("release.yml");
    expect(release.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(release.env.TAG).toBe("${{ inputs.tag || github.ref_name }}");
    expect(release.concurrency.group).toContain("inputs.tag || github.ref_name");
    const provenance = release.jobs.provenance;
    expect(provenance.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    expect(provenance.outputs.sha).toBe("${{ steps.checked.outputs.sha }}");
    expect(provenance.steps.find((step: { id?: string }) => step.id === "checked")?.run).toContain('SHA="$(git rev-parse HEAD)"');
    expect(release.jobs.build.steps[0].with.ref).toBe("${{ needs.provenance.outputs.tag }}");
    expect(release.jobs.publish.steps.find((step: { name?: string }) => step.name === "Verify tag and App-authored draft")?.env.SHA)
      .toBe("${{ needs.provenance.outputs.sha }}");
  });
});
