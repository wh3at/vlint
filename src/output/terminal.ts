import type { RunResultV1 } from "../contracts/result";

const BIDI_CONTROLS: Record<number, true> = {
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

export function renderTerminal(result: RunResultV1): string {
  const lines = [
    `vlint ${escapeTerminal(result.tool.version)}: ${result.status}`,
    `targets resolved=${result.summary.targets.resolved} complete=${result.summary.targets.complete} partial=${result.summary.targets.partial} failed=${result.summary.targets.failed} not-executed=${result.summary.targets.notExecuted}`,
    `rules clean=${result.summary.ruleEvaluations.clean} violations=${result.summary.ruleEvaluations.violations} failed=${result.summary.ruleEvaluations.failed} disabled=${result.summary.ruleEvaluations.disabled} not-executed=${result.summary.ruleEvaluations.notExecuted}`,
    `matched=${result.summary.matchedElements} violations=${result.summary.violations} failures=${result.summary.executionFailures}`,
  ];
  for (const target of result.targets) {
    lines.push(
      `target ${escapeTerminal(target.name)}: ${target.status} ${redactUrlForTerminal(target.url)} viewport=${target.viewport.width}x${target.viewport.height}@${target.deviceScaleFactor}`,
    );
    for (const rule of target.rules) {
      lines.push(
        `  rule ${escapeTerminal(rule.name)}: ${rule.status} labels=${rule.labelsInspected} violations=${rule.violations.length}`,
      );
      for (const violation of rule.violations) {
        const box = violation.geometry;
        lines.push(
          `    violation lines=${violation.lineCount} locator=${escapeTerminal(violation.locator)} box=${box.x},${box.y},${box.width},${box.height} text=${escapeTerminal(violation.text)}`,
        );
      }
    }
  }
  for (const finalization of result.ruleFinalizations) {
    lines.push(
      `finalize ${escapeTerminal(finalization.name)}: ${finalization.status} labels=${finalization.labelsInspected}`,
    );
  }
  if (result.failure !== null) {
    lines.push(
      `failure ${result.failure.stage}/${result.failure.code} target=${escapeTerminal(result.failure.target ?? "-")} rule=${escapeTerminal(result.failure.rule ?? "-")}: ${escapeTerminal(result.failure.message)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
