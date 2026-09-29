# vlint releases

Release Please owns the version, `v<semver>` tag, changelog, and GitHub Release notes. The release pipeline owns the build, approval, asset upload, and public verification. Do not create a second tag or publish a second Release from PR labels or another CI system.

## Change classification

The repository allows squash merges only and uses the PR title as the squash commit title. Keep one Conventional Commit per change on `main`. The required `typecheck` check validates title syntax on PR open, update, and edit. Review the title and any `BREAKING CHANGE:` footer again in the merge dialog.

| Title or commit | Release Please result |
| --- | --- |
| `feat: add a rule` | minor version and changelog entry |
| `fix: correct a result` | patch version and changelog entry |
| `feat!: change an interface` or `BREAKING CHANGE:` footer | major version and breaking-change note, including `0.x` to `1.0.0` |
| `chore:`, `docs:`, `test:`, `ci:`, `build:`, `refactor:`, `perf:` | no release on their own |

Changes to the public CLI, config, JSON, plugin contract, installer, or distributed binary require a releasable title even if they also change tests or documentation. Do not use a non-releasable type to suppress a user-facing change. If one PR contains multiple user-facing changes, describe them in the squash commit body with additional Conventional Commit entries. Release Please can override a merged commit's generated notes with a `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block in that PR's body.

The first managed release starts after `v0.8.0`. The initial manifest version is `0.8.0`; the bootstrap SHA excludes earlier commits from the new changelog. Do not edit the generated version, manifest, or changelog independently. If the default bump is wrong, use Release Please's `Release-As: x.y.z` commit footer, then review the resulting Release PR. A breaking change in the `0.x` series proposes `1.0.0` by default; explicitly decide whether to approve it before merging. Release PRs are never auto-merged.

## Release PR and publication

1. Review the proposed version, public changes, breaking-change notes, and generated changelog in the Release PR. The `ci` workflow's required checks must pass for the PR before it can be merged.
2. Merge the Release PR by squash merge. The `main` CI run must complete successfully for the exact merge SHA before Release Please processes it. Only the current `main` SHA is eligible.
3. Release Please creates the `v<semver>` tag and a draft GitHub Release containing its generated notes. It uses a GitHub App token so its PR and tag trigger GitHub Actions. Drafts use an eagerly created tag; without it, GitHub delays creating the tag until publication.
4. The tag workflow verifies the protected-branch ancestry, exact-SHA required checks, and package/tag version match before building and validating the same four assets as before: archive, deb, installer, and checksums. The protected `release` environment requires human approval before the only write-token job uploads them to the Release Please draft and publishes it without replacing its notes.
5. The workflow verifies published asset checksums again by anonymous download. A failure removes an incomplete Release only if the release and tag still belong to this Release Please run. It does not delete the tag.

The GitHub App `vlint-release-please` is installed only on `wh3at/vlint` with Contents, Issues, and Pull requests write access. The trusted Release Please workflow reads `VLINT_RELEASE_APP_CLIENT_ID` from an Actions variable and `VLINT_RELEASE_APP_PRIVATE_KEY` from a repository secret, minting a short-lived token scoped to that one repository. Never expose either the key or the token to PR jobs, artifacts, or logs. The PR CI workflow has no release credential and the publisher does not check out or execute repository code.

## Recovery

If validation or publication fails, inspect the failed workflow and its exact commit. An incomplete Release may be removed while its tag stays in place. Do not delete or retarget the tag automatically, rerun the release workflow against an unverified commit, overwrite an existing Release, or merge another Release PR until the failure is understood. Correct the underlying problem, rerun the failed job when its immutable artifacts are still available, or arrange a reviewed manual recovery of the tagged version. If the tag is retained but the draft was removed, recreate only the expected draft with the reviewed notes and exact target SHA under maintainer supervision before rerunning; ordinary Release Please runs must not silently create a competing version.

Changing the GitHub App key requires generating a new key, replacing the repository secret, verifying token creation on `wh3at/vlint`, and revoking the old key. Keep the App installation limited to this repository. Woodpecker migration, if pursued later, must preserve Release Please as the only version and tag source and retire the GitHub Actions publisher before activating another publisher.
