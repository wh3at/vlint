import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface ReleaseNames {
  readonly tag: string;
  readonly archive: string;
  readonly installer: string;
}

export function releaseNames(version: string): ReleaseNames {
  return {
    tag: `v${version}`,
    archive: `vlint-v${version}-linux-x64.tar.gz`,
    installer: `install-v${version}.sh`,
  };
}

export function renderInstaller(version: string, repository: string): string {
  const names = releaseNames(version);
  return `#!/bin/sh
set -eu

TAG="${names.tag}"
REPOSITORY="${repository}"
ARCHIVE="${names.archive}"
INSTALL_DIR=\${VLINT_INSTALL_DIR:-"$HOME/.local/bin"}
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;
esac

WORK_DIR=
TARGET=
COMMITTED=false
cleanup() {
  status=$?
  trap - EXIT
  if [ "$COMMITTED" != true ]; then
    if [ -e "$INSTALL_DIR/vlint" ]; then
      printf 'vlint installer: not updated; previous executable preserved\\n' >&2
    else
      printf 'vlint installer: installation failed\\n' >&2
    fi
  fi
  if [ -n "$TARGET" ]; then rm -f "$TARGET"; fi
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command in curl sha256sum tar install uname mktemp awk wc mv; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'vlint installer: required command not found: %s\\n' "$command" >&2
    exit 2
  }
done
if [ "$(uname -s)" != "Linux" ] || { [ "$(uname -m)" != "x86_64" ] && [ "$(uname -m)" != "amd64" ]; }; then
  printf 'vlint installer: Linux x64 is required\\n' >&2
  exit 2
fi

INVOCATION_DIR=$(pwd)
WORK_DIR=$(mktemp -d)
cd "$WORK_DIR"
BASE="https://github.com/$REPOSITORY/releases/download/$TAG"
curl -fsSL "$BASE/$ARCHIVE" -o "$ARCHIVE"
curl -fsSL "$BASE/SHA256SUMS" -o SHA256SUMS
awk -v name="$ARCHIVE" '$2 == name { print }' SHA256SUMS > ARCHIVE.SHA256
if [ "$(wc -l < ARCHIVE.SHA256)" -ne 1 ]; then
  printf 'vlint installer: checksum entry missing or duplicated for %s\\n' "$ARCHIVE" >&2
  exit 2
fi
sha256sum -c ARCHIVE.SHA256
tar -xzf "$ARCHIVE" vlint
mkdir -p "$INSTALL_DIR"
TARGET=$(mktemp "$INSTALL_DIR/.vlint.XXXXXX")
install -m 0755 vlint "$TARGET"
(cd "$INVOCATION_DIR" && PLAYWRIGHT_SKIP_BROWSER_GC=1 "$TARGET" browser install)
(cd "$INVOCATION_DIR" && "$TARGET" browser status)
mv -f "$TARGET" "$INSTALL_DIR/vlint"
TARGET=
COMMITTED=true
printf 'vlint %s installed to %s/vlint\\n' "$TAG" "$INSTALL_DIR"
printf 'Create project configuration with: vlint init --help\\n'
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add %s to PATH before running vlint.\\n' "$INSTALL_DIR" ;;
esac
`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export interface PackageReleaseOptions {
  readonly root: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly repository: string;
  readonly binaryPath: string;
}

export async function packageRelease(options: PackageReleaseOptions): Promise<ReleaseNames> {
  const names = releaseNames(options.version);
  await mkdir(options.outputDirectory, { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), "vlint-package-"));
  try {
    await copyFile(options.binaryPath, join(workspace, "vlint"));
    await chmod(join(workspace, "vlint"), 0o755);
    await copyFile(join(options.root, "README.md"), join(workspace, "README.md"));
    const result = spawnSync("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", join(options.outputDirectory, names.archive), "vlint", "README.md"], { cwd: workspace, stdio: "inherit" });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`tar exited ${String(result.status)}`);
    await writeFile(join(options.outputDirectory, names.installer), renderInstaller(options.version, options.repository), { encoding: "utf8", mode: 0o755 });
    const checksums: string[] = [];
    for (const asset of [names.archive, names.installer]) {
      checksums.push(`${await sha256(join(options.outputDirectory, asset))}  ${asset}`);
    }
    await writeFile(join(options.outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
    return names;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) throw new Error("package.json version is missing");
  const outputArgument = process.argv.indexOf("--output");
  if (outputArgument !== -1 && process.argv[outputArgument + 1] === undefined) throw new Error("--output requires a directory");
  const outputDirectory = outputArgument === -1 ? join(root, "dist", "release") : resolve(process.argv[outputArgument + 1]!);
  const names = await packageRelease({ root, outputDirectory, version: packageJson.version, repository: "wh3at/vlint", binaryPath: join(root, "dist", "vlint-linux-x64") });
  process.stdout.write(`Packaged ${basename(names.archive)} and ${basename(names.installer)} in ${outputDirectory}\n`);
}

if (import.meta.main) await main();
