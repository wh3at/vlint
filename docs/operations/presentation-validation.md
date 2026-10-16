# Concise check presentation (#61)

Normal terminal and JSON output share the same coverage projection: overall status and case partitions, environment-by-rule executions, inspected-element counts, disabled and unexecuted counts, actionable case diagnostics, failing finalizations, and run-wide failures. An execution is a clean, violating or failed rule evaluation; disabled and unexecuted evaluations are counted separately. Inspected elements are summed rule observations, not distinct DOM nodes or case counts.

JSON exposes `environmentRules`, `diagnostics`, and relevant `executionDiagnostics`, not the old full `cases` / `execution` schema. Successful case URLs, individual successful elements, and detailed successful execution configuration are available in the same-run file at `reportPath`. Terminal prints the same path. No verbose rerun is needed. Displayed URLs retain query/hash values; terminal control and bidi characters are escaped. Full reports remain sensitive, private temporary files; see [reports](reports.md).

## Validation

Approved seam: compiled CLI external processes with fixed loopback HTML, config, stdout, exit status and saved reports. No test-only product interface or browser substitute.

```sh
bun install --frozen-lockfile
bun run build:linux-x64
bun test tests/acceptance/presentation-61.test.ts
VLINT_PRESENTATION_CONTAINER=vlint-61-validation bun test tests/acceptance/presentation-61-container.test.ts tests/acceptance/presentation-61.test.ts tests/acceptance/report-60.test.ts
bun test tests/unit/output.test.ts tests/golden/reporter-golden.test.ts
bun run typecheck
bun run check:architecture
```

The first slice was RED because the baseline JSON exposed `cases: []`; GREEN followed the concise projection. The second slice was RED because terminal still enumerated all successful cases instead of environment-rule counts; GREEN followed terminal projection. Fixture corrections before that meaningful RED removed an unsupported rule option and accounted for default rules and overflow's actual inspected candidate count (three, not one).

Final compiled acceptance: 4 tests, 93 assertions pass. Each of clean (0), violations (1), and simultaneous violation plus minimum failure (incomplete, 2) runs in JSON and terminal using actual Chromium 149.0.7827.55, Firefox 151.0, WebKit 26.5. Reports retain three cases and non-null obtained engine versions. Goldens and output unit tests: 23 tests, 73 assertions pass; typecheck and architecture (43 modules) pass.

Isolation reuses #60's prepared Ubuntu environment without touching its container or browser cache:

```sh
docker commit vlint-60-validation vlint-61-validation:local
docker run -d --name vlint-61-validation --network host -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-61 -e PLAYWRIGHT_SKIP_BROWSER_GC=1 -v /home/wh3at/orca/workspaces/vlint/issue-55-ticket-61:/lane:ro vlint-61-validation:local sh -c 'mv /tmp/browsers-60 /tmp/browsers-61; sleep infinity'
```

The image contains a private snapshot of already prepared browser assets; renaming occurs only in the new container. No host dependency bypass, browser installation, shared cache deletion, or global cleanup was performed. Host browser library/sudo limitations remain those recorded in browser-management-validation.md. This is container evidence, not universal host support.

Full unit run initially had 341 passes and 14 failures: ten output/schema/golden assertions were migrated and now pass; four obsolete setup tests remain outside this ticket. Existing #57/#60 container suites still expect full stdout and require integration migration to read `reportPath`; they are not claimed passing here. This ticket validates presentation, not every built-in rule's three-engine geometry contract.
