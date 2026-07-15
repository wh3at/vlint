import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const UBUNTU_BROWSER_DEPENDENCIES = [
  "ca-certificates",
  "fonts-liberation",
  "libasound2t64",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcairo2",
  "libcups2t64",
  "libdbus-1-3",
  "libdrm2",
  "libgbm1",
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
] as const;

export interface ReleaseNames {
  readonly tag: string;
  readonly archive: string;
  readonly deb: string;
  readonly installer: string;
}

export function releaseNames(version: string): ReleaseNames {
  return {
    tag: `v${version}`,
    archive: `vlint-v${version}-linux-x64.tar.gz`,
    deb: `vlint_${version}_amd64.deb`,
    installer: `install-v${version}.sh`,
  };
}

export function renderDebianControl(version: string): string {
  return [
    "Package: vlint",
    `Version: ${version}`,
    "Architecture: amd64",
    "Maintainer: vlint project <noreply@github.com>",
    `Depends: ${UBUNTU_BROWSER_DEPENDENCIES.join(", ")}`,
    "Section: devel",
    "Priority: optional",
    "Homepage: https://github.com/wh3at/vlint",
    "Description: deterministic DOM-geometry layout checks",
    " vlint checks declared UI targets for layout contract violations.",
    "",
  ].join("\n");
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

for command in curl sha256sum tar install uname; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'vlint installer: required command not found: %s\\n' "$command" >&2
    exit 2
  }
done

if [ "$(uname -s)" != "Linux" ] || { [ "$(uname -m)" != "x86_64" ] && [ "$(uname -m)" != "amd64" ]; }; then
  printf 'vlint installer: Ubuntu 24.04 x64 is required\\n' >&2
  exit 2
fi
if [ ! -r /etc/os-release ]; then
  printf 'vlint installer: cannot verify Ubuntu 24.04\\n' >&2
  exit 2
fi
ID=
VERSION_ID=
. /etc/os-release
if [ "$ID" != "ubuntu" ] || [ "$VERSION_ID" != "24.04" ]; then
  printf 'vlint installer: Ubuntu 24.04 x64 is required\\n' >&2
  exit 2
fi

WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT HUP INT TERM
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
mv -f "$TARGET" "$INSTALL_DIR/vlint"
printf 'vlint %s installed to %s/vlint\\n' "$TAG" "$INSTALL_DIR"
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

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)}`);
  }
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
    const archiveRoot = join(workspace, "archive");
    await mkdir(archiveRoot);
    await copyFile(options.binaryPath, join(archiveRoot, "vlint"));
    await chmod(join(archiveRoot, "vlint"), 0o755);
    await copyFile(join(options.root, "README.md"), join(archiveRoot, "README.md"));
    run("tar", [
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      join(options.outputDirectory, names.archive),
      "vlint",
      "README.md",
    ], archiveRoot);

    const packageRoot = join(workspace, "deb");
    await mkdir(join(packageRoot, "DEBIAN"), { recursive: true });
    await mkdir(join(packageRoot, "usr", "bin"), { recursive: true });
    await mkdir(join(packageRoot, "usr", "share", "doc", "vlint"), { recursive: true });
    await writeFile(
      join(packageRoot, "DEBIAN", "control"),
      renderDebianControl(options.version),
      "utf8",
    );
    await copyFile(options.binaryPath, join(packageRoot, "usr", "bin", "vlint"));
    await chmod(join(packageRoot, "usr", "bin", "vlint"), 0o755);
    await copyFile(
      join(options.root, "README.md"),
      join(packageRoot, "usr", "share", "doc", "vlint", "README.md"),
    );
    run("dpkg-deb", [
      "--root-owner-group",
      "--build",
      packageRoot,
      join(options.outputDirectory, names.deb),
    ], options.root);

    const installerPath = join(options.outputDirectory, names.installer);
    await writeFile(
      installerPath,
      renderInstaller(options.version, options.repository),
      { encoding: "utf8", mode: 0o755 },
    );

    const assets = [names.archive, names.deb, names.installer];
    const checksums: string[] = [];
    for (const asset of assets) {
      checksums.push(`${await sha256(join(options.outputDirectory, asset))}  ${asset}`);
    }
    await writeFile(
      join(options.outputDirectory, "SHA256SUMS"),
      `${checksums.join("\n")}\n`,
      "utf8",
    );
    return names;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version is missing");
  }
  const outputArgument = process.argv.indexOf("--output");
  const outputDirectory = outputArgument === -1
    ? join(root, "dist", "release")
    : resolve(process.argv[outputArgument + 1] ?? "");
  if (outputArgument !== -1 && process.argv[outputArgument + 1] === undefined) {
    throw new Error("--output requires a directory");
  }
  const binaryPath = join(root, "dist", "vlint-linux-x64");
  const names = await packageRelease({
    root,
    outputDirectory,
    version: packageJson.version,
    repository: "wh3at/vlint",
    binaryPath,
  });
  process.stdout.write(
    `Packaged ${basename(names.archive)}, ${basename(names.deb)}, and ${basename(names.installer)} in ${outputDirectory}\n`,
  );
}

if (import.meta.main) {
  await main();
}
