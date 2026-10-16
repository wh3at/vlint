# Table-cell overlap validation (#64)

The boundary is the compiled CLI, its JSON summary and persisted report. The fixture server binds loopback; the approved Ubuntu 24.04 Docker environment uses host networking to reach it. No source evaluator substitutes for the acceptance executable.

## Reproduce

Build with pinned Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run build:linux-x64
VLINT_TABLE_CELL_CONTAINER=vlint-64-validation bun test tests/acceptance/table-cell-64-container.test.ts
bun run typecheck
bun run check:architecture
bun test tests/unit/table-cell-clipping.test.ts tests/unit/table-cell-neighbors.test.ts
```

The container must mount this worktree read-only at `/lane`, use host networking, and have all three pinned Playwright engines prepared. Follow [browser-management validation](browser-management-validation.md) for the approved preparation method; use a lane-private cache and `PLAYWRIGHT_SKIP_BROWSER_GC=1`. This acceptance does not install or remove browsers.

This run reused the existing prepared Ubuntu validation image, locally tagged `vlint-64-validation:local`, and copied its browser cache privately:

```sh
docker run -d --name vlint-64-validation --network host \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-64 \
  -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/lane:ro" vlint-64-validation:local sleep infinity
docker exec vlint-64-validation sh -c 'cp -a /tmp/browsers-57 /tmp/browsers-64'
```

The reused image contains the prepared `/tmp/browsers-57` cache; that path is an environment reuse detail, not a new distribution interface. Do not prune shared images or caches. On an unprepared image, use compiled `browser install` per #56 instead of copying nonexistent assets.

## Observations

Each test repeats the same compiled executable, fixed pages, configuration and browser binaries three times and compares complete per-case rule observations, including geometry, counts and violation identities.

- Chromium 149.0.7827.55 (1228), Firefox 151.0 (1532), WebKit 26.5 (2311; version from metadata) all execute real pages.
- Clean path clipping inspects one source cell and finds no overlap. The excluded neighbor still participates in violation detection: the unclipped source reports `#source` against `#neighbor`, overlap 60 CSS pixels. Excluded sources and hidden tables inspect zero cells.
- A fixed page returning null from the browser's Canvas `getContext` now gives `rule-script-failed`, incomplete exit 2, a partial case, and retains the earlier rule's clean result. Subsequent rules remain explicitly not-executed. Other cases retain their successful results and violations in the report.
- Existing edges, clipping and clip-shapes pages inspect 19, 30 and 26 cells respectively in every engine. Exact expected violation identity sets are checked, including rowspan adjacency, escaping positioned text, scaled/rounded/circular/elliptical/polygon/path/SVG-reference clips and object-bounding-box shapes.
- Firefox exposes null `svg.viewBox.baseVal` when a viewBox is absent. The rule now falls back to rendered viewport dimensions, as it already did for an empty viewBox in other engines. A direct Firefox page evaluation reproduced the null-access failure; compiled acceptance failed before this fix and passed afterward.

TDD: the compiled Canvas regression expected exit 2 but received 1 before the null-context failure was propagated. The existing fixture matrix then exposed Firefox referenced-clip failures (exit 2 instead of expected 1), fixed by the null-viewBox handling. Both REDs and subsequent GREENs used actual compiled CLI processes.

Host browser dependencies remain unavailable without interactive sudo; acceptance uses the previously approved Docker isolation, not a claim of support for every host distribution. Sampling and unsupported clipping-shape limits of the existing rule are unchanged.
