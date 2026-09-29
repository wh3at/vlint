import { describe, expect, test } from "bun:test";
import { isConventionalPullRequestTitle } from "../../scripts/check-release-intent";

describe("release intent in PR titles", () => {
  test.each([
    "feat: add a rule",
    "fix: x",
    "fix(cli): correct an error",
    "feat!: change the CLI contract",
    "fix(config)!: remove an obsolete option",
    "chore(main): release 0.9.0",
    "docs: clarify installation",
    "test: cover packaging",
    "ci: pin an action",
    "perf: speed up scans",
    "refactor: simplify validation",
  ])("accepts %s", title => {
    expect(isConventionalPullRequestTitle(title)).toBe(true);
  });

  test.each([
    "Update release notes",
    "feature: add a rule",
    "feat: ",
    "feat:missing space",
    "feat(scope):",
    "Feat: add a rule",
  ])("rejects %s", title => {
    expect(isConventionalPullRequestTitle(title)).toBe(false);
  });
});
