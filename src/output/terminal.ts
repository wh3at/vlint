import type { RunResultV3 } from "../contracts/result";

const BIDI_CONTROLS: Record<number, true> = {
  0x061c: true,
  0x200e: true,
  0x200f: true,
  0x202a: true,
  0x202b: true,
  0x202c: true,
  0x202d: true,
  0x202e: true,
  0x2066: true,
  0x2067: true,
  0x2068: true,
  0x2069: true,
};

export function escapeTerminal(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || BIDI_CONTROLS[code] === true) {
      output += `\\u{${code.toString(16)}}`;
    } else output += character;
  }
  return output;
}

export function redactUrlForTerminal(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const entries = [...url.searchParams.keys()];
    for (const key of new Set(entries)) {
      const count = url.searchParams.getAll(key).length;
      url.searchParams.delete(key);
      for (let index = 0; index < count; index += 1) url.searchParams.append(key, "<redacted>");
    }
    url.hash = "";
    return escapeTerminal(url.toString());
  } catch {
    return escapeTerminal(value);
  }
}

function escapeNullable(value: string | null): string {
  return value === null ? "-" : escapeTerminal(value);
}

function failureLine(failure: {
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly target: string | null;
  readonly device: string | null;
  readonly rule: string | null;
  readonly browserDiagnostic?: {
    readonly status: string;
    readonly requirements: {
      readonly revision: string;
      readonly cacheRoot: string;
    };
    readonly detectedRevisions: readonly {
      readonly revision: string;
    }[];
  };
}): string {
  let line = `failure ${failure.stage}/${failure.code} target=${escapeNullable(failure.target)} device=${escapeNullable(failure.device)} rule=${escapeNullable(failure.rule)}: ${escapeTerminal(failure.message)}`;
  if (failure.browserDiagnostic !== undefined) {
    const diag = failure.browserDiagnostic;
    const revisions = diag.detectedRevisions.length > 0
      ? ` revisions=${escapeTerminal(diag.detectedRevisions.map((e) => e.revision).join(","))}`
      : "";
    line += `\n  browser status=${escapeTerminal(diag.status)} revision=${escapeTerminal(diag.requirements.revision)} cache=${escapeTerminal(diag.requirements.cacheRoot)}${revisions}`;
  }
  return line;
}

export function renderTerminal(result: RunResultV3): string {
  const lines = [
    `vlint ${escapeTerminal(result.tool.version)}: ${result.status}`,
    `targets resolved=${result.summary.targets.resolved}`,
    `cases resolved=${result.summary.cases.resolved} complete=${result.summary.cases.complete} partial=${result.summary.cases.partial} failed=${result.summary.cases.failed} not-executed=${result.summary.cases.notExecuted}`,
    `rules clean=${result.summary.ruleEvaluations.clean} violations=${result.summary.ruleEvaluations.violations} failed=${result.summary.ruleEvaluations.failed} disabled=${result.summary.ruleEvaluations.disabled} not-executed=${result.summary.ruleEvaluations.notExecuted}`,
    `elements=${result.summary.elementsInspected} violations=${result.summary.violations} failures=${result.summary.executionFailures}`,
  ];
  for (const caseResult of result.cases) {
    lines.push(
      `case target=${escapeTerminal(caseResult.target.name)} device=${escapeTerminal(caseResult.device.name)}: ${caseResult.status} ${redactUrlForTerminal(caseResult.target.url)} viewport=${caseResult.device.viewport.width}x${caseResult.device.viewport.height}@${caseResult.device.deviceScaleFactor}`,
    );
    for (const rule of caseResult.rules) {
      lines.push(
        `  rule ${escapeTerminal(rule.name)}: ${rule.status} elements=${rule.elementsInspected} violations=${rule.violations.length}`,
      );
      if (rule.failure !== null) lines.push(`    ${failureLine(rule.failure)}`);
      for (const violation of rule.violations) {
        const box = violation.geometry;
        if (violation.type === "tab-label-single-line") {
          lines.push(
            `    violation lines=${violation.lineCount} locator=${escapeTerminal(violation.locator)} box=${box.x},${box.y},${box.width},${box.height} text=${escapeTerminal(violation.text)}`,
          );
        } else {
          lines.push(
            `    violation overflow=${violation.overflowPx}px locator=${escapeTerminal(violation.locator)} box=${box.x},${box.y},${box.width},${box.height} css=${escapeTerminal(JSON.stringify(violation.computedStyle))}`,
          );
        }
      }
    }
    for (const failure of caseResult.failures) {
      lines.push(`  ${failureLine(failure)}`);
    }
  }
  for (const finalization of result.ruleFinalizations) {
    lines.push(
      `finalize ${escapeTerminal(finalization.name)}: ${finalization.status} elements=${finalization.elementsInspected}`,
    );
    if (finalization.failure !== null) lines.push(`  ${failureLine(finalization.failure)}`);
  }
  for (const failure of result.failures) {
    lines.push(failureLine(failure));
  }
  return `${lines.join("\n")}\n`;
}
