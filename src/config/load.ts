import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LoadedConfig } from "../contracts/config";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { normalizeRules } from "./merge";
import { parseConfig } from "./schema";

const CONFIG_NAME = "vlint.config.json";
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

function configFailure(code: Failure["code"], message: string): BoundaryResult<LoadedConfig> {
  return boundaryFailure({ stage: "config", code, message, target: null, rule: null });
}

export async function loadConfig(cwd: string): Promise<BoundaryResult<LoadedConfig>> {
  const path = resolve(cwd, CONFIG_NAME);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return configFailure(
      code === "ENOENT" ? "config-not-found" : "config-read-failed",
      code === "ENOENT" ? `${CONFIG_NAME} was not found` : `cannot read ${CONFIG_NAME}`,
    );
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return configFailure("config-read-failed", `${CONFIG_NAME} is not a regular file`);
    if (stat.size > MAX_CONFIG_BYTES) {
      return configFailure("config-too-large", `${CONFIG_NAME} exceeds 8 MiB`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_CONFIG_BYTES) {
      return configFailure("config-too-large", `${CONFIG_NAME} exceeds 8 MiB`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return configFailure("config-invalid-json", `${CONFIG_NAME} is not valid JSON`);
    }
    const parsed = parseConfig(value);
    if (!parsed.ok) return parsed;
    return boundarySuccess({
      path,
      directory: dirname(path),
      provider: parsed.value.provider,
      defaults: parsed.value.defaults ?? {},
      rules: normalizeRules(parsed.value.rules),
    });
  } catch {
    return configFailure("config-read-failed", `cannot read ${CONFIG_NAME}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
