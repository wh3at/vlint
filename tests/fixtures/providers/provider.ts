import { appendFile } from "node:fs/promises";

const [mode, ...args] = process.argv.slice(2);
const target = { name: "settings", url: "http://127.0.0.1:4173/settings" };

if (mode === "valid") {
  process.stdout.write(JSON.stringify({ targets: [target] }));
} else if (mode === "echo-argv") {
  const value = args[0] ?? "";
  const environment = process.env.VLINT_PROVIDER_TEST ?? "";
  process.stdout.write(
    JSON.stringify({ targets: [{ name: `${value}:${environment}`, url: target.url }] }),
  );
} else if (mode === "nonzero") {
  process.exit(7);
} else if (mode === "invalid-json") {
  process.stdout.write("not json");
} else if (mode === "bare-array") {
  process.stdout.write(JSON.stringify([target]));
} else if (mode === "unknown-field") {
  process.stdout.write(JSON.stringify({ targets: [target], log: "no" }));
} else if (mode === "unmatched-override") {
  process.stdout.write(
    JSON.stringify({ targets: [{ ...target, ruleOverrides: { missing: { enabled: true } } }] }),
  );
} else if (mode === "duplicate") {
  process.stdout.write(JSON.stringify({ targets: [target, target] }));
} else if (mode === "empty") {
  process.stdout.write(JSON.stringify({ targets: [] }));
} else if (mode === "stdout-cap") {
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < 129; index += 1) process.stdout.write(chunk);
  await Bun.sleep(60_000);
} else if (mode === "stderr-cap") {
  const chunk = "x".repeat(1024);
  for (let index = 0; index < 65; index += 1) process.stderr.write(chunk);
  await Bun.sleep(60_000);
} else if (mode === "timeout") {
  await Bun.sleep(60_000);
} else if (mode === "child-ignore") {
  process.on("SIGTERM", () => undefined);
  await Bun.sleep(60_000);
} else if (mode === "grandchild") {
  const pidFile = args[0];
  if (pidFile === undefined) throw new Error("pid file required");
  const child = Bun.spawn([process.execPath, import.meta.path, "child-ignore"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await appendFile(pidFile, String(child.pid));
  process.on("SIGTERM", () => undefined);
  await Bun.sleep(60_000);
} else if (mode === "open-pipe") {
  Bun.spawn([process.execPath, import.meta.path, "child-ignore"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
