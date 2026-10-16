import type { RunResult, RuleResultStatus } from "../contracts/result";
import { publishResult } from "./publish";

export function summarizeResult(result: RunResult) {
  const published = publishResult(result);
  const environmentRules: { environment: string; rule: string; executions: number; elementsInspected: number; clean: number; violations: number; failed: number; disabled: number; notExecuted: number }[] = [];
  for (const auditCase of published.cases) {
    for (const rule of auditCase.rules) {
      let row = environmentRules.find(row => row.environment === auditCase.environment && row.rule === rule.name);
      if (row === undefined) {
        row = { environment: auditCase.environment, rule: rule.name, executions: 0, elementsInspected: 0, clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 };
        environmentRules.push(row);
      }
      const key: Record<RuleResultStatus, "clean" | "violations" | "failed" | "disabled" | "notExecuted"> = { clean: "clean", violations: "violations", failed: "failed", disabled: "disabled", "not-executed": "notExecuted" };
      row[key[rule.status]]++;
      if (rule.status !== "disabled" && rule.status !== "not-executed") row.executions++;
      row.elementsInspected += rule.elementsInspected;
    }
  }
  const diagnostics = published.cases.filter(item => item.failures.length > 0 || item.rules.some(rule => rule.failure !== null || rule.violations.length > 0)).map(item => ({
    target: item.target, actualUrl: item.actualUrl ?? null, environment: item.environment, device: item.device,
    failures: item.failures,
    rules: item.rules.filter(rule => rule.failure !== null || rule.violations.length > 0),
  }));
  const affected = new Set(diagnostics.map(item => item.environment));
  const environments = published.execution.environments.filter(item => affected.has(item.name));
  const engines = published.execution.engines.filter(item => environments.some(environment => environment.browser === item.engine));
  return {
    status: published.status, tool: published.tool, summary: published.summary, environmentRules, diagnostics,
    executionDiagnostics: engines.length === 0 ? undefined : { engines, environments },
    ruleFinalizations: published.ruleFinalizations.filter(item => item.failure !== null),
    failures: published.failures,
    reportPath: (result as RunResult & { reportPath?: string | null }).reportPath ?? null,
  };
}
