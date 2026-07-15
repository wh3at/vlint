import type { CommandProviderConfig, Target } from "../contracts/config";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { parseCommandProviderOutput } from "../config/schema";
import type { ProviderContext } from "./types";

const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const CLEANUP_GRACE_MS = 500;

interface BoundedRead {
  readonly bytes: Uint8Array;
  readonly overflow: boolean;
}

interface ProviderProcessResult {
  readonly exitCode: number;
  readonly stdout: BoundedRead;
  readonly stderr: BoundedRead;
}

function providerFailure(code: Failure["code"], message: string): BoundaryResult<readonly Target[]> {
  return boundaryFailure({ stage: "provider", code, message, target: null, device: null, rule: null });
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
  retain: boolean,
): Promise<BoundedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        onOverflow();
        await reader.cancel().catch(() => undefined);
        return { bytes: new Uint8Array(0), overflow: true };
      }
      if (retain) chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!retain) return { bytes: new Uint8Array(0), overflow: false };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow: false };
}

function signalProcessGroup(pid: number, signal: number): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    return false;
  }
}

async function terminateProcessGroup(child: Bun.Subprocess): Promise<boolean> {
  let ok = signalProcessGroup(child.pid, 15);
  try {
    child.kill(15);
  } catch {
    if (child.exitCode === null) ok = false;
  }
  await Promise.race([child.exited, Bun.sleep(CLEANUP_GRACE_MS)]);
  ok = signalProcessGroup(child.pid, 9) && ok;
  try {
    child.kill(9);
  } catch {
    if (child.exitCode === null) ok = false;
  }
  const reaped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(CLEANUP_GRACE_MS).then(() => false),
  ]);
  return ok && reaped;
}


export async function resolveCommandProvider(
  config: CommandProviderConfig,
  context: ProviderContext,
): Promise<BoundaryResult<readonly Target[]>> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([config.executable, ...(config.args ?? [])], {
      cwd: context.directory,
      env: context.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch {
    return providerFailure("provider-spawn-failed", "target provider could not be started");
  }

  let cap: "stdout" | "stderr" | null = null;
  let resolveCap!: (stream: "stdout" | "stderr") => void;
  const capPromise = new Promise<"stdout" | "stderr">((resolve) => {
    resolveCap = resolve;
  });
  const stdoutPromise = readBounded(child.stdout, STDOUT_LIMIT, () => {
    cap = "stdout";
    resolveCap("stdout");
  }, true);
  const stderrPromise = readBounded(child.stderr, STDERR_LIMIT, () => {
    cap = "stderr";
    resolveCap("stderr");
  }, false);
  const normalPromise: Promise<{ type: "normal"; value: ProviderProcessResult }> = Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]).then(([exitCode, stdout, stderr]) => ({ type: "normal", value: { exitCode, stdout, stderr } }));
  const timeoutMs = config.timeoutMs ?? 30_000;
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ type: "timeout" as const }));
  const capRace = capPromise.then((stream) => ({ type: "cap" as const, stream }));
  const abortPromise = new Promise<{ type: "abort" }>((resolve) => {
    if (context.signal?.aborted === true) resolve({ type: "abort" });
    else context.signal?.addEventListener("abort", () => resolve({ type: "abort" }), { once: true });
  });

  const outcome = await Promise.race([normalPromise, timeoutPromise, capRace, abortPromise]);
  if (outcome.type !== "normal") {
    const cleaned = await terminateProcessGroup(child);
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    if (!cleaned) return providerFailure("provider-cleanup-failed", "target provider cleanup failed");
    if (outcome.type === "abort") {
      return boundaryFailure({
        stage: "interrupt",
        code: "signal-interrupt",
        message: "target provider interrupted",
        target: null,
        device: null,
        rule: null,
      });
    }
    if (outcome.type === "timeout") {
      return providerFailure("provider-timeout", `target provider exceeded ${timeoutMs} ms`);
    }
    return providerFailure(
      "provider-output-too-large",
      `${outcome.stream} exceeded ${outcome.stream === "stdout" ? "8 MiB" : "64 KiB"}`,
    );
  }
  if (!(await terminateProcessGroup(child))) {
    return providerFailure("provider-cleanup-failed", "target provider cleanup failed");
  }

  if (cap !== null || outcome.value.stdout.overflow || outcome.value.stderr.overflow) {
    return providerFailure("provider-output-too-large", `${cap ?? "provider output"} exceeded its limit`);
  }
  if (outcome.value.exitCode !== 0) {
    return providerFailure("provider-exit-nonzero", `target provider exited with ${outcome.value.exitCode}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcome.value.stdout.bytes));
  } catch {
    return providerFailure("provider-output-invalid", "target provider stdout is not one valid JSON object");
  }
  const parsed = parseCommandProviderOutput(
    value,
    new Map(context.rules.map((rule) => [rule.name, rule])),
  );
  return parsed.ok ? boundarySuccess(parsed.value.targets) : parsed;
}
