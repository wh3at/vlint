import type { RunResult } from "../contracts/result";
import { summarizeResult } from "./summary";

export function renderJson(result: RunResult): string {
  return `${JSON.stringify(summarizeResult(result))}\n`;
}
