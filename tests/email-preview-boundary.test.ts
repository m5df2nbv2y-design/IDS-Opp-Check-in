import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Follow local runtime imports, including re-exports, across the preview boundary. */
function dependencies(entry: string) {
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const name = relative(root, file).replaceAll("\\", "/");
    expect(name, `client runtime dependency ${name}`).not.toMatch(/^src\/server\//);
    expect(name).not.toMatch(/^src\/lib\/(env|db)(\.|\/)/);
    const source = readFileSync(file, "utf8");
    expect(source, `${name} must not read runtime secrets`).not.toMatch(/process\.env/);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function walk(node: ts.Node) {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const typesOnly = clause?.isTypeOnly ||
          (!clause?.name && bindings && ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly));
        if (!typesOnly) specifier = node.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      }
      if (specifier && (specifier.startsWith("@/") || specifier.startsWith("."))) {
        const base = specifier.startsWith("@/") ? resolve(root, "src", specifier.slice(2)) : resolve(dirname(file), specifier);
        const target = [base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")].find(existsSync);
        expect(target, `resolve ${specifier} from ${name}`).toBeDefined();
        if (target) visit(target);
      }
      ts.forEachChild(node, walk);
    }
    walk(ast);
  }
  visit(resolve(root, entry));
  return visited;
}

describe("personalized email preview runtime boundary", () => {
  it("keeps the complete local runtime import graph free of server integrations and secrets", () => {
    const visited = dependencies("src/components/admin/reviewed-email-preview.tsx");
    expect(visited.has(resolve(root, "src/lib/check-in-email.ts"))).toBe(true);
    expect(visited.size).toBeGreaterThan(3);
  });
});
