import type { RunResultV3 } from "../contracts/result";

export function renderJson(result: RunResultV3): string {
  return `${JSON.stringify(result)}\n`;
}
