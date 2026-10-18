# Complete check reports

Every `vlint check` saves its complete same-run JSON result in a unique private directory under the OS temporary directory (`TMPDIR` on Linux). The directory has mode 0700 and the report has mode 0600. Normal terminal output prints `reportPath`; JSON output includes `reportPath`.

The report retains successful, violating, failed, disabled and unexecuted evaluations, raw specified and observed URLs, diagnostics and common execution configuration. Treat it as potentially sensitive data. Reading it does not rerun the page.

Temporary reports can disappear during OS cleanup or reboot. For durable retention, copy the reported file into your CI artifact directory, for example `cp "$reportPath" "$CI_ARTIFACTS/check-report.json"`, then publish that directory using your CI artifact upload step. Keep artifact access appropriately restricted.

A shell step using `jq` can preserve the check exit code, including violations or
incomplete inspection, while copying the same execution's report:

```sh
umask 077
mkdir -p "$CI_ARTIFACTS" || exit 2
status=0
vlint check --format json > "$CI_ARTIFACTS/check-summary.json" || status=$?
reportPath=$(jq -r '.reportPath // empty' "$CI_ARTIFACTS/check-summary.json") || exit 2
if [ -n "$reportPath" ]; then
  cp "$reportPath" "$CI_ARTIFACTS/check-report.json" || exit 2
fi
exit "$status"
```

Run the artifact upload step even after nonzero exit. If the CLI runs inside a
container, copy or upload the file from that same container before removing it;
its reported absolute path belongs to its filesystem, not the caller's. A parser
or copy failure is not a successful retention step. CLI-usage errors need not emit
check JSON. Temporary storage, CI retention and artifact access policy remain the
caller's responsibility; vlint neither uploads results nor guarantees their lifetime.

If saving fails, check exits 2 with an incomplete result and a short `report-write-failed` diagnostic. `reportPath` is null; the CLI does not dump the full result as a fallback. Check available temporary storage and permissions. vlint does not maintain history or schedule deletion.
