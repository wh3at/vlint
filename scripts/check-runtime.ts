import pkg from "../package.json";

if (Bun.version !== pkg.engines.bun) {
  console.error(`Bun version mismatch: expected ${pkg.engines.bun}, running ${Bun.version}. Run mise install, then retry with mise exec -- bun <command>.`);
  process.exit(1);
}
