# Init environment selection validation (#58)

The seam is the compiled Linux x64 executable, plus real terminal input through a Python standard-library PTY. No browser substitute or test-only product flag is used.

```sh
bun install --frozen-lockfile
bun run build:linux-x64
bun run typecheck
bun run check:architecture
bun test tests/unit/init.test.ts tests/unit/cli.test.ts tests/unit/cli-run.test.ts tests/golden/cli-help-golden.test.ts tests/acceptance/init-selection.test.ts
VLINT_INIT_CONTAINER=vlint-58-validation bun test tests/acceptance/init-selection-container.test.ts
```

Observed on implementation commit `01c83a20947398b4480473466bd2a9156b73fd77`: typecheck and architecture passed; 74 targeted tests passed; container acceptance passed. The container test generates all six environments through compiled init and checks the generated configuration twice against a fixed loopback page using Chromium, Firefox and WebKit. Both executions were clean, in declared order. The real PTY test chooses Windows → Firefox and iPhone → WebKit, and proves byte-identical output to explicit flags both with and without a terminal. Additional cases cover help, unsupported selections, and preservation of existing regular files, directories, live symlinks and dangling symlinks. Auxiliary preset-source tests retain missing-field failure coverage.

RED/GREEN: the first compiled non-TTY/no-selection test failed with exit 0 instead of 2; after guidance/rejection implementation it passed. The next explicit-selection generation test failed with exit 1 instead of 0; after repeatable CLI options and complete config generation it passed. The old help golden failed before its init-only update. A container assertion initially used obsolete Pixel dimensions; it was corrected against the pinned public Pixel 10 descriptor (viewport 360×732, screen 360×808, DPR 3). A first container run hit Bun's default five-second test timeout; the test now has a 120-second bound and completes in approximately 6–10 seconds.

Docker uses the approved #56 isolation approach and #57's already prepared engines, not host package changes. The lane owns image/container `vlint-58-validation:local` / `vlint-58-validation` and private `/tmp/browsers-58`. Preparation commands were:

```sh
docker commit vlint-57-validation vlint-58-validation:local
docker run -d --name vlint-58-validation --network host -v "$PWD:/lane" -e PLAYWRIGHT_SKIP_BROWSER_GC=1 -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-58 vlint-58-validation:local sleep infinity
docker exec vlint-58-validation cp -a /tmp/browsers-57 /tmp/browsers-58
```

The writable lane mount allows compiled init to create its test-specific temporary configuration. Browser download transport is pointed at unreachable loopback during the checks. No shared browser assets were removed. Containers/image/worktree remain for review. See browser-management-validation.md for the host missing-library/sudo limitation; this does not establish arbitrary host support.

A broader `bun run test:unit` run yielded 351 pass and four failures, all in obsolete `tests/unit/setup.test.ts`. Setup removal belongs to #59; this ticket neither adds default environments to satisfy those tests nor changes that source contract. The final targeted run includes CLI/help and init coverage; the full browser-lifecycle integration suite was not rerun here. Existing browser-lifecycle fixture sourcing was minimally migrated to explicit selected profiles.
