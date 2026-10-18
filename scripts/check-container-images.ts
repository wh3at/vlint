import { resolve } from "node:path";
import ts from "typescript";

const digestPattern = /@sha256:[a-f0-9]{64}$/;
const booleanOptions = new Set(["--rm", "--detach", "-d", "--interactive", "-i", "--tty", "-t", "-it", "--init", "--privileged", "--read-only"]);
const valueOptions = new Set(["--name", "--env", "-e", "--volume", "-v", "--mount", "--network", "--user", "-u", "--workdir", "-w", "--platform", "--entrypoint", "--tmpfs", "--publish", "-p", "--cap-add", "--security-opt", "--shm-size"]);

export function containerImageFailures(path: string, source: string): string[] {
  const failures: string[] = [];
  const report = (line: number, image: string) => failures.push(`${path}:${line}: container image must use @sha256:<64 lowercase hex digits>: ${image}`);
  const localImages = new Set<string>();
  const checkRun = (args: readonly (string | null)[], line: number) => {
    let index = 0;
    while (index < args.length) {
      const word = args[index];
      if (word === "--") {
        index++;
        break;
      }
      if (word === undefined || word === null || !word.startsWith("-")) break;
      if (booleanOptions.has(word)) index++;
      else if (valueOptions.has(word)) index += 2;
      else if (word.startsWith("--") && valueOptions.has(word.split("=")[0]!)) index++;
      else {
        failures.push(`${path}:${line}: unsupported docker run option: ${word}`);
        return;
      }
    }
    const image = args[index];
    if (image === undefined || image === null || (!localImages.has(image) && !digestPattern.test(image))) report(line, image ?? "<unresolved image>");
  };
  if (path.endsWith(".ts")) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.Expression>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        constants.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
    const literal = (node: ts.Node | undefined): string | null => {
      if (node !== undefined && ts.isStringLiteralLike(node)) return node.text;
      if (node !== undefined && ts.isIdentifier(node)) {
        const value = constants.get(node.text);
        if (value !== undefined && ts.isStringLiteralLike(value)) return value.text;
      }
      return null;
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        if (ts.isIdentifier(node.expression) && node.expression.text === "docker" && literal(node.arguments[0]) === "run") {
          checkRun(node.arguments.slice(1).map(literal), line);
        }
        const command = node.arguments[0];
        if (command !== undefined && ts.isArrayLiteralExpression(command) && literal(command.elements[0]) === "docker" && literal(command.elements[1]) === "run") {
          checkRun(command.elements.slice(2).map(literal), line);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  } else {
    const stages = new Set<string>();
    for (const [index, line] of source.split("\n").entries()) {
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      const assignment = /^\s*(?:export\s+)?BASE_IMAGE=['"]?([^'"\s]+)/.exec(line);
      const image = from?.[1] ?? assignment?.[1];
      if (image !== undefined && image !== "scratch" && !stages.has(image.toLowerCase()) && !digestPattern.test(image)) report(index + 1, image);
      if (from?.[2] !== undefined) stages.add(from[2].toLowerCase());
    }
    if (path.endsWith(".sh")) {
      const shell = source.replace(/\\\r?\n/g, " ");
      const variables = new Map<string, string>();
      for (const match of shell.matchAll(/^\s*(?:export\s+)?(\w+)=['"]?([^'"\s]+)/gm)) variables.set(match[1]!, match[2]!);
      for (const match of shell.matchAll(/\bdocker\s+build[^\n]*\s(?:-t|--tag)\s+["']?\$\{?(\w+)\}?/g)) {
        const image = variables.get(match[1]!);
        if (image !== undefined) localImages.add(image);
      }
      for (const match of shell.matchAll(/\bdocker\s+run\s+([^\n]*)/g)) {
        const lineStart = shell.lastIndexOf("\n", match.index) + 1;
        if (shell.slice(lineStart, match.index).trimStart().startsWith("#")) continue;
        const words = match[1]!.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
        const args = words.map(word => {
          const value = word.replace(/^['"]|['"]$/g, "");
          const variable = /^\$\{?(\w+)\}?$/.exec(value);
          return variable === null ? value : variables.get(variable[1]!) ?? null;
        });
        checkRun(args, shell.slice(0, match.index).split("\n").length);
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
  const paths = new Set<string>();
  for (const pattern of ["{scripts,tests}/**/*.{ts,sh}", "**/Containerfile*", "**/Dockerfile*"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      if (!path.split("/").some(part => ["node_modules", ".git", ".pi", "dist"].includes(part))) paths.add(path);
    }
  }
  const failures: string[] = [];
  for (const path of [...paths].sort()) failures.push(...containerImageFailures(path, await Bun.file(resolve(root, path)).text()));
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`container image pins ok (${paths.size} files)`);
  }
}
