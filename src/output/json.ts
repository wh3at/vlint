import type { RunResult } from "../contracts/result";
import { publishResult } from "./publish";

export function renderJson(result: RunResult): string {
  return `${JSON.stringify(publishResult(result))}\n`;
}
