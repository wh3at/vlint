# Integrated Linux x64 artifact acceptance (#66)

## Implemented contract versus validation scope

The completed component contracts are explicit environment selection, bundled
Playwright preparation/readiness, transactional common installation, three-engine
rule execution, concise presentation and private same-run reports. This record is
execution evidence, not a release announcement or a claim of native Windows,
macOS, iPhone or Android hardware testing. Those names select emulated inspection
environments on the Linux host. No new platform archive, official container or
release was published. Independent final spec/standards review remains parent-owned.

This integration ticket changes tests and documentation only. It removes remaining
implicit-init/full-stdout expectations rather than adding compatibility. Existing
failure-transition tests now require independent later rules to execute after a
rule-specific failure. A scaled-SVG integration fixture now loads the repository's
fixed DM Mono font before measuring: Ubuntu's unspecified monospace fallback gave
120px ink against an assertion requiring more than 130px. The assertion was not
relaxed. Selected Desktop Chrome expectations now use its pinned 1280×720 viewport,
1920×1080 screen and DPR 1, not the retired implicit MacBook init profile.

## Approved test environment

Bun 1.3.14, Playwright 1.61.1; Ubuntu 24.04 Docker isolation follows
[browser management validation](browser-management-validation.md). The Arch host
still lacks browser libraries and interactive sudo; no host dependency policy was
changed. The private snapshot contains the real engines prepared by #57's compiled
`browser install`, not mock executables. Only #66's container/cache were changed.

From the #66 worktree:

```sh
bun install --frozen-lockfile
bun run build:linux-x64
docker tag vlint-63-validation:local vlint-66-validation:local
docker run -d --name vlint-66-validation --network host \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-66 \
  -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/lane" vlint-66-validation:local sleep infinity
docker exec vlint-66-validation cp -a /tmp/browsers-57 /tmp/browsers-66
docker cp "$(readlink -f "$(command -v bun)")" vlint-66-validation:/usr/local/bin/bun
docker exec vlint-66-validation bun --version
docker exec vlint-66-validation sh -c 'apt-get update && apt-get install -y python3'
```

Python is a test-only prerequisite for the existing PTY acceptance. Initial
bootstrap failures were missing `bun` on PATH and missing `python3`; they were
corrected only in this private container. Bun must have the actual executable name
`bun`: naming the copied binary `bun-66` selects the plugin loader's non-Bun path.
The final source integration run uses `/usr/local/bin/bun`. An initial packaged
fixture also mixed root-created config with host-user writes; the archive gate now
runs its container commands as the invoking host UID/GID. These are fixture/setup
corrections, not fixed product failures.

Container ID: `3049499daee60cdf2b881d3c3ca57843d288f774181d0b6e0b85f6f5c01ab5e5`.
Do not prune shared Docker or browser assets. Containers, worktree and ignored
build artifacts remain for review.

## Commands and observed results

```sh
bun run typecheck
bun run check:architecture
bun run test:unit
docker exec -w /lane vlint-66-validation bun run test:integration
docker exec -w /lane vlint-66-validation bun test tests/acceptance/vlint.test.ts
docker exec -w /lane vlint-66-validation bun test \
  tests/acceptance/browser-management.test.ts \
  tests/acceptance/environments.test.ts tests/acceptance/init-selection.test.ts \
  tests/acceptance/installer-59.test.ts tests/acceptance/presentation-61.test.ts \
  tests/acceptance/report-60.test.ts
```

- Typecheck and architecture: pass, 42 production modules.
- Unit/golden: 343 pass, 0 fail, 926 assertions.
- Full scheduled integration: 279 pass, 0 skip, 0 fail across 13 process groups,
  1576 assertions (`/tmp/vlint-66-integration-final2.log`).
- Original compiled CLI suite: 39 pass, 0 fail, 467 assertions, 431.39 seconds
  (`/tmp/vlint-66-artifact-green.log`). This was not repeated after comment/title-only
  cleanup; its executable, fixture behavior and assertions are unchanged.
- Other non-container-gated acceptance: 29 pass in six files. The initial run had
  28 passes and the missing-Python PTY failure; after installing Python, the entire
  unchanged init-selection file passed 14 tests / 58 assertions. No remaining
  failure is hidden by a skip.

The compiled three-engine matrix was run together:

```sh
VLINT_ENVIRONMENT_CONTAINER=vlint-66-validation \
VLINT_INIT_CONTAINER=vlint-66-validation \
VLINT_REPORT_CONTAINER=vlint-66-validation \
VLINT_PRESENTATION_CONTAINER=vlint-66-validation \
VLINT_READINESS_CONTAINER=vlint-66-validation \
VLINT_RULES_63_CONTAINER=vlint-66-validation \
VLINT_TABLE_CELL_CONTAINER=vlint-66-validation \
VLINT_SVG_LOCAL_CONTAINER=vlint-66-validation \
bun test tests/acceptance/*container.test.ts tests/acceptance/single-line-overflow-63.test.ts
```

At that run the newly added archive gate was not yet present: 18 pass, 1 skip,
0 fail, 2165 assertions, 357.62 seconds (`/tmp/vlint-66-all-engines.log`). The skip
is the explicitly gated browser preparation suite; preparation/repair evidence is
reused below. All selected init, environments, minimums, presentation, persistence,
readiness, five built-ins and local-rule gates actually ran. The matrix observes
Chromium 149.0.7827.55 (1228), Firefox 151.0 (1532), WebKit 26.5 (2311).
WebKit version provenance is Playwright metadata. See component validation records
for precise sampled URL/ready/font guarantees, repeatability, engine-failure scope,
and independently reproduced mobile screen/touch limits; none are expanded here.

The artifact-specific gate uses the actual packaged archive, extracts its executable,
checks version, runs explicit six-environment init, edits the generated config and
runs all five built-ins plus a local evaluator. Every environment has positive
inspected counts for tab/header/cell/SVG/local; overflow's clean fast path counts
zero. It reads that run's full private report and copies its exact bytes as a CI
artifact without revisiting the page. It runs as a non-root UID; report mode is 0600.

```sh
bun run package:release
(cd dist/release && sha256sum -c SHA256SUMS)
VLINT_ARTIFACT_CONTAINER=vlint-66-validation bun test tests/acceptance/artifact-66-container.test.ts
```

Result: checksums pass; 1 test, 43 assertions, 0 failures, 33.11 seconds
(`/tmp/vlint-66-packaged-artifact-green.log`). Initial fixture assertions counted
only the body cell; table-cell inspection correctly includes the header cell too.
The final independent expected per-rule counts are `[1, 0, 1, 2, 1, 1]` in every
environment. All checks point download transport at unreachable loopback; check
and status empty-cache tests separately verify no acquisition or mutation.

Artifact SHA256:

- Executable: `370aecc675a755e9a0eef64b4a1cf386c45def3f82a988a8271969a26c819cf4`
- Archive: `34fbf33050e2d8af3092a15c500955a4552ef9ffca8e09d14d7abe2468a7c2ac`
- Installer: `67f8842d21b06c1d7723efa828679ccb0537c4a9e4cfcda0dfa59da0eb47c826`

## RED → GREEN migration evidence

The pre-migration compiled/integration command was:

```sh
bun test tests/integration/cli-acceptance.test.ts tests/acceptance/environments.test.ts tests/acceptance/report-60.test.ts
```

It produced 31 pass / 5 fail (`/tmp/vlint-66-red.log`): missing full stdout
execution/cases, extra terminal reportPath chunk and obsolete implicit init.
After reportPath reads and selection forwarding, CLI acceptance alone passed
24 tests / 126 assertions (`/tmp/vlint-66-cli-green.log`). Full integration then
exposed the obsolete stop-after-rule-failure and desktop-preset expectations;
those now pass with #62 continuation and #58 explicit-selection contracts.
The compiled legacy suite also failed on stdout `cases` before migration
(`/tmp/vlint-66-artifact-red.log`) and subsequently passed all 39 tests. The
six-environment init container test was separately RED on stdout `cases.map`, then
GREEN with the same-run full report and all five generated rule evaluations.

## Reused installer/preparation evidence and residuals

The expensive installer gate is **not claimed rerun by #66**. The accepted #59
packaged gate ran against code/merge head
`657ee85f1cc0899190da5f87500c5bdf24724d64`: 16 assertions, 421.98 seconds, real
archive/common installer and all engines. It covers first acquisition failure,
first install, same-version repeat, failed update, catchable interruption,
byte-for-byte old executable preservation, successful replacement, forced browser
repair, sentinel survival and offline status. The successful-update tag is
synthetic over the same real binary, not a published historical browser upgrade.
See [installer evidence](installer-59-validation.md) and its retained exact logs.

Before reuse, #66 ran:

```sh
git diff 657ee85f1cc0899190da5f87500c5bdf24724d64 -- src scripts package.json bun.lock install.sh .github tests/release
```

There was no difference (0 bytes, `/tmp/vlint-66-installer-input-diff.txt`). #66
makes no production, build, dependency, installer, release-workflow or installer-test
changes. This is exact-input reuse, not a fresh exact-head installer run. #56's
accepted real preparation/repair gate likewise supplies the skipped preparation
suite's existing evidence; no shared cache is deleted to manufacture another run.

The initial #59 lifecycle/completion hang remains unexplained and is **not fixed**
by this ticket. Its stopped diagnostic container is preserved; three bounded
focused installs and two later complete installer gates passed after authorized
same-protocol diagnosis. Temporary reports are not durable storage, emulated
platforms are not native OS certification, and boundary sampling is not continuous
monitoring. Final independent review and spec acceptance remain separate from
these completed execution checks.
