import type { RunResultV1 } from "../contracts/result";

export function renderJson(result: RunResultV1): string {
  return `${JSON.stringify(result)}\n`;
}
