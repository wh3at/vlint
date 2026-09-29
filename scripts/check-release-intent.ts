export function isConventionalPullRequestTitle(title: string): boolean {
  return /^(feat|fix|perf|chore|docs|test|ci|build|refactor)(\([a-z0-9][a-z0-9-]*\))?!?: \S.*$/.test(title);
}

if (import.meta.main) {
  const title = process.env.PR_TITLE ?? "";
  if (!isConventionalPullRequestTitle(title)) {
    console.error(`Invalid PR title: ${title}\nUse a Conventional Commit title, e.g. feat: add a rule, fix!: change the CLI contract, or chore: update CI.`);
    process.exit(1);
  }
}
