# Common installer validation (#59)

## Contract and reproduction

Linux x64 releases contain the archive, version-bound common installer, and SHA256SUMS. No Debian package or distribution-specific dependency list is produced. The candidate is staged beside the installed executable, prepared using the compiled `browser install`, checked with `browser status`, then switched by rename. Playwright owns dependencies and privileges. Preparation disables browser garbage collection; OS package rollback is not attempted. Failure and catchable interruption leave the old executable in place. Configuration belongs to `init`; `setup` is removed.

Primary acceptance uses real archives, the shell installer, and the compiled CLI in a unique Ubuntu 24.04 Docker guest. Only certificates and curl are bootstrapped by the fixture; browser dependencies and all browser downloads come from Playwright. The curl transport is replaced only for release-asset delivery and deterministic acquisition failure/interruption. Browser operations are real. Each guest command has a 600-second deadline and kill grace; diagnostics survive failure. Successful guests remove only themselves, retaining host command logs. No host dependency or Docker/browser global cleanup is performed.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check:architecture
bun run test:unit
bun run build:linux-x64
bun test tests/acceptance/installer-59.test.ts
bun run package:release
sh tests/release/validate.sh release \
  dist/release/vlint-v0.10.0-linux-x64.tar.gz \
  dist/release/SHA256SUMS dist/release/install-v0.10.0.sh
```

`bun run release:validate` builds and runs the same packaging/installer acceptance. The tag workflow validates its actual downloaded immutable archive and installer through `validate.sh release` rather than rebuilding the production payload.

## Evidence

At code/merge head `657ee85f1cc0899190da5f87500c5bdf24724d64` (includes integration `bf07b1f`): typecheck and architecture passed (42 modules), unit/golden tests passed (343 tests, 926 assertions), build passed, retired-setup compiled acceptance passed. The real packaged-artifact gate passed in 421.98 seconds with 16 assertions; `/tmp/vlint-59-final-release.log` and `dist/vlint-59-1231233-1792138844686/command-*.log` retain exact evidence. The archive and installer checksums both passed.

The gate covers first acquisition failure (no installed executable), successful first preparation, same-version repetition, failed update acquisition, executable-present Firefox launch failure, TERM during acquisition, byte-for-byte old executable preservation on failures, candidate cleanup after interruption, successful replacement, forced browser repair, old-cache sentinel survival, and offline status. Chromium 149.0.7827.55 revision 1228, Firefox 151.0 revision 1532, and WebKit 26.5 revision 2311 all passed launch, empty page creation/close, and browser close. WebKit version provenance remains Playwright metadata.

The update fixture assigns a synthetic next release tag to the same real binary archive and marks the previous installed payload before replacement. It proves candidate replacement and preservation, not a browser revision upgrade between two published historical releases. The host lacks browser libraries; all positive engine evidence is container evidence, not a universal Linux guarantee.

### RED/GREEN

Before setup removal, `bun test tests/acceptance/installer-59.test.ts` against the old compiled binary failed (expected parser exit 1, got 2). After rebuilding it passed. An earlier `setup --help` probe also demonstrated the old command existed (exit 0).

Before installer changes, `VLINT_INSTALLER_CONTAINER_ACCEPTANCE=1 bun test tests/acceptance/installer-container-59.test.ts` failed: installer reported installation success without `chromium, firefox, webkit ready`. `/tmp/vlint-59-red.log` retains that failure. After the change, diagnostic full acceptance passed in 237.5 seconds, and the final actual packaged-artifact gate above passed after merging integration.

### Unexplained initial hang

The first GREEN attempt timed out after 1800 seconds in candidate `browser install`. Its worker had exited, browser descendants were defunct, and no live browser remained. The exact owned container `vlint-59-978769-1792136182817` is retained stopped, with candidate `/tmp/bin/.vlint.mMLgxl`, former guest PID 2563, and leftover Firefox/Chromium profiles. `/tmp/vlint-59-green.log` contains the outer test header. The supervisor approved diagnosis and a same-protocol rerun. No speculative lifecycle patch was made.

Bounded `DEBUG=pw:browser` status on the same candidate passed all engines; bounded install on both candidate and normal pathname passed. Three further bounded installs in the preserved guest passed (`/tmp/vlint-59-repeat.log`; guest `/tmp/repeat59-{1,2,3}.{out,err}`). Both complete subsequent installer gates passed. Thus a deterministic pathname cause was ruled out; an intermittent lifecycle/completion hang remains unexplained, not declared fixed. The supervisor briefly extended ownership to browser lifecycle diagnosis; neither browser source file required edits.

## Deferred integrated-test migration (#66)

An opportunistic `bun test tests/acceptance/installer-59.test.ts tests/integration/cli-acceptance.test.ts` run had 21 passes and four failures in pre-existing expectations. The supervisor explicitly reserved these unrelated migrations for #66:

- `no config and no url resolves to config-not-found over JSON`: expects full `cases: []` in concise stdout; now undefined.
- `no config and no url renders the terminal view`: expects one stdout chunk; reportPath adds a second.
- `creates a stable config on stdout only with exit 0 (AE1)`: old runtime calls init without required selections, receives exit 2.
- `refuses to overwrite an existing config with exit 2 (AE2)`: same old runtime receives init-environment-required before config-already-exists.

Only obsolete setup runtime/type scaffolding was removed from that file in #59. This lane does not claim the entire integration suite is green. No release, push, issue closure, or host package mutation was performed.
