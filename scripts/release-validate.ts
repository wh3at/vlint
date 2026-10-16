import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const result = spawnSync(process.execPath, ["run", "build:linux-x64"], { cwd: root, stdio: "inherit", timeout: 300_000 });
if (result.status !== 0) throw new Error("release binary build failed");
const validation = spawnSync(process.execPath, ["test", "tests/acceptance/installer-container-59.test.ts"], {
  cwd: root,
  env: { ...process.env, VLINT_INSTALLER_CONTAINER_ACCEPTANCE: "1" },
  stdio: "inherit",
  timeout: 1_800_000,
});
if (validation.status !== 0) throw new Error("release installer validation failed; preserve the named diagnostic container and logs");
