# vlint releases

Release Please owns the version, `v<semver>` tag, changelog, and GitHub Release notes. The release pipeline owns the build, approval, asset upload, and public verification. Do not create a second tag or publish a second Release from PR labels or another CI system.

## Change classification

The repository allows squash merges only and uses the PR title as the squash commit title. Keep one Conventional Commit per change on `main`. The required `typecheck` check validates title syntax on PR open, update, and edit. Review the title and any `BREAKING CHANGE:` footer again in the merge dialog.

| Title or commit | Release Please result |
| --- | --- |
| `feat: add a rule` | minor version and changelog entry |
| `fix: correct a result` or `perf: speed up a check` | patch version and changelog entry |
| `feat!: change an interface` or `BREAKING CHANGE:` footer | major version and breaking-change note, including `0.x` to `1.0.0` |
| `chore:`, `docs:`, `test:`, `ci:`, `build:`, `refactor:` | no release on their own |

Changes to the public CLI, config, JSON, plugin contract, installer, or distributed binary require a releasable title even if they also change tests or documentation. Do not use a non-releasable type to suppress a user-facing change. For multiple user-facing changes in one PR, put additional `feat:` or `fix:` entries in the squash commit body, separated from preceding text by a blank line. Release Please 17.6.0 splits these entries into separate commits. Alternatively, use a `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block in the PR body to replace all parsed entries; include every intended change inside the block.

The first managed release starts after `v0.8.0`. The initial manifest version is `0.8.0`; the bootstrap SHA excludes earlier commits from the new changelog. Do not edit the generated version, manifest, or changelog independently. If the default bump is wrong, use Release Please's `Release-As: x.y.z` commit footer, then review the resulting Release PR. A breaking change in the `0.x` series proposes `1.0.0` by default; explicitly decide whether to approve it before merging. Release PRs are never auto-merged.

## Release PR and publication

1. Review the proposed version, public changes, breaking-change notes, and generated changelog in the Release PR. The `ci` workflow's required checks must pass for the PR before it can be merged.
2. Merge the Release PR by squash merge. Release Please checks that successful `main` CI belongs to the current SHA before processing. If `main` advances while it runs, the tag workflow still refuses to publish until required checks succeed at the exact tag SHA. A draft left by a failed provenance gate can be retried after CI succeeds; never publish an unverified commit.
3. Release Please creates the `v<semver>` tag and a draft GitHub Release containing its generated notes. It uses a GitHub App token so its PR and tag trigger GitHub Actions. Drafts use an eagerly created tag; without it, GitHub delays creating the tag until publication.
4. The tag workflow verifies the protected-branch ancestry, exact-SHA required checks, and package/tag version match before building and validating the same four assets as before: archive, deb, installer, and checksums. The protected `release` environment requires human approval before the publisher verifies the App-authored draft's tag, title, target, notes, and empty asset list, then uploads assets and publishes without replacing the notes. Inspect the draft notes during approval: authorized edits to the App's draft retain its author.
5. The workflow verifies published asset checksums again by anonymous download. After provenance succeeds, a failure removes an incomplete Release only if the release and tag still belong to this Release Please run. A provenance failure leaves the draft intact for retry after CI. Cleanup never deletes the tag.

The GitHub App `vlint-release-please` is installed only on `wh3at/vlint` with Contents, Issues, and Pull requests write access. The trusted Release Please workflow reads `VLINT_RELEASE_APP_CLIENT_ID` from an Actions variable and `VLINT_RELEASE_APP_PRIVATE_KEY` from a repository secret, minting a short-lived token scoped to that one repository. Never expose either the key or the token to PR jobs, artifacts, or logs. The PR CI workflow has no release credential and the publisher does not check out or execute repository code.

## Recovery

If provenance fails because CI for the tag SHA has not finished, wait for the exact SHA to pass and rerun the failed tag workflow against the retained draft. For other failures, inspect the failed workflow and its exact commit. Do not delete or retarget the tag automatically, rerun against an unverified commit, overwrite an existing Release, or merge another Release PR until the failure is understood. Correct the problem and rerun when the immutable artifacts remain available, or arrange reviewed manual recovery. If cleanup removed the draft but retained the tag, a maintainer must recreate the reviewed draft at that exact SHA using a short-lived token minted from the `vlint-release-please` App in a trusted environment before rerunning; a draft created with a personal `gh` token fails the immutable App-author check. Ordinary Release Please runs must not create a competing version.

Changing the GitHub App key requires generating a new key, replacing the repository secret, verifying token creation on `wh3at/vlint`, and revoking the old key. Keep the App installation limited to this repository. Woodpecker migration, if pursued later, must preserve Release Please as the only version and tag source and retire the GitHub Actions publisher before activating another publisher.
