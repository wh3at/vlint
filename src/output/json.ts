import type { RunResultV2 } from "../contracts/result";

export function renderJson(result: RunResultV2): string {
  return `${JSON.stringify(result)}\n`;
}
