
import { mkdir } from "node:fs/promises";

const playwrightPackage = await Bun.file("node_modules/playwright-core/package.json").json();
const playwrightBrowsers = await Bun.file("node_modules/playwright-core/browsers.json").json();
const vlintPackage = await Bun.file("package.json").json();

const playwrightManifestPlugin: Bun.BunPlugin = {
  name: "embed-playwright-manifests",
  setup(build) {
    build.onLoad(
      { filter: /node_modules\/playwright-core\/lib\/.*\.js$/ },
      async ({ path }) => {
        let contents = await Bun.file(path).text();
        contents = contents.replace(
          /require\(import_path\w*\.default\.join\(packageRoot, "package\.json"\)\)/g,
          JSON.stringify(playwrightPackage),
        );
        contents = contents.replace(
          /require\(import_path\w*\.default\.join\(packageRoot, "browsers\.json"\)\)/g,
          JSON.stringify(playwrightBrowsers),
        );
        return { contents, loader: "js" };
      },
    );
  },
};

interface BuildTarget {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly embedsPlaywright: boolean;
}

const targets: Readonly<Record<string, BuildTarget>> = {
  feasibility: {
    entrypoint: "tests/feasibility/compiled-playwright.ts",
    outfile: "dist/vlint-playwright-feasibility",
    embedsPlaywright: true,
  },
  "fixture-server": {
    entrypoint: "tests/release/fixture-server.ts",
    outfile: "dist/vlint-fixture-server",
    embedsPlaywright: false,
  },
  "linux-x64": {
    entrypoint: "src/cli.ts",
    outfile: "dist/vlint-linux-x64",
    embedsPlaywright: true,
  },
};

const name = process.argv[2];
const target = name === undefined ? undefined : targets[name];
if (target === undefined) {
  throw new Error(`Unknown build target: ${name ?? "<missing>"}`);
}

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: [target.entrypoint],
  compile: {
    target: "bun-linux-x64-baseline",
    outfile: target.outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  external: ["chromium-bidi/*"],
  plugins: target.embedsPlaywright ? [playwrightManifestPlugin] : [],
  define: { __VLINT_VERSION__: JSON.stringify(vlintPackage.version) },
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
