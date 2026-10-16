# Complete check reports

Every `vlint check` saves its complete same-run JSON result in a unique private directory under the OS temporary directory (`TMPDIR` on Linux). The directory has mode 0700 and the report has mode 0600. Normal terminal output prints `reportPath`; JSON output includes `reportPath`.

The report retains successful, violating, failed, disabled and unexecuted evaluations, raw specified and observed URLs, diagnostics and common execution configuration. Treat it as potentially sensitive data. Reading it does not rerun the page.

Temporary reports can disappear during OS cleanup or reboot. For durable retention, copy the reported file into your CI artifact directory, for example `cp "$reportPath" "$CI_ARTIFACTS/check-report.json"`, then publish that directory using your CI artifact upload step. Keep artifact access appropriately restricted.

If saving fails, check exits 2 with an incomplete result and a short `report-write-failed` diagnostic. `reportPath` is null; the CLI does not dump the full result as a fallback. Check available temporary storage and permissions. vlint does not maintain history or schedule deletion.
