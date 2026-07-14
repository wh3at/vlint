import { existsSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const sourceRoot = resolve(root, "src");
const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })].map((file) =>
  normalize(resolve(root, file)),
);
const fileSet = new Set(files);
const graph = new Map<string, string[]>();

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (fileSet.has(normalize(candidate)) || existsSync(candidate)) return normalize(candidate);
  }
  return null;
}

for (const file of files) {
  const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const dependency = resolveImport(file, statement.moduleSpecifier.text);
    if (dependency !== null && dependency.startsWith(sourceRoot)) dependencies.push(dependency);
  }
  graph.set(file, dependencies);
  if (relative(sourceRoot, file).startsWith(`contracts${process.platform === "win32" ? "\\" : "/"}`)) {
    for (const dependency of dependencies) {
      const path = relative(sourceRoot, dependency).replaceAll("\\", "/");
      if (!path.startsWith("contracts/")) {
        throw new Error(`Contract imports outward: ${relative(root, file)} -> ${relative(root, dependency)}`);
      }
    }
  }
}

const visited = new Set<string>();
const active = new Set<string>();
const stack: string[] = [];

function visit(file: string): void {
  if (active.has(file)) {
    const index = stack.indexOf(file);
    const cycle = [...stack.slice(index), file].map((item) => relative(root, item)).join(" -> ");
    throw new Error(`Dependency cycle: ${cycle}`);
  }
  if (visited.has(file)) return;
  active.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  active.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);
process.stdout.write(`architecture ok (${files.length} modules)\n`);
