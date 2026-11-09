// Resolves every import in the given files (default: every changed or untracked .ts/.tsx/.mjs/.js) the way tsconfig's
// "paths" do, CSS included. tsc never checks a side-effect import such as `import "x.css"`, which is how
// "@/app/editor/mobile-modal.css" broke the Next build on 2026-10-30 (docs/change_management.md, incident 1).
// Prints each import that resolves to no file; exit 1 if any.
// Usage: node scripts/check-imports.mjs [file ...]
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
// The most specific alias wins, as tsc and Turbopack pick it: "@/components/x" before "@/x".
const paths = Object.entries(ts.compilerOptions.paths)
  .map(([k, v]) => [k.replace(/\*$/, ""), v.map((t) => t.replace(/\*$/, ""))])
  .sort((a, b) => b[0].length - a[0].length);
const EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const found = (p) => EXT.some((e) => existsSync(p + e));

function resolves(spec, from) {
  if (spec.startsWith(".")) return found(resolve(dirname(from), spec));
  for (const [prefix, targets] of paths) {
    if (spec.startsWith(prefix)) return targets.some((t) => found(join(ROOT, t + spec.slice(prefix.length))));
  }
  // A package: it resolves when node_modules has it.
  const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  return isBuiltin(spec) || existsSync(join(ROOT, "node_modules", pkg));
}

let files = process.argv.slice(2);
if (!files.length) {
  const out = execSync("git status --porcelain --untracked-files=all", { cwd: ROOT, encoding: "utf8" });
  files = out.split("\n").map((l) => l.slice(3).trim())
    .filter((f) => /\.(tsx?|mjs|jsx?)$/.test(f) && !f.includes("__tests__") && existsSync(join(ROOT, f)));
}
let bad = 0;
const RE = /(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
for (const f of files) {
  const abs = resolve(ROOT, f);
  // Comments out first (a "//" or "/*" that starts a line or follows a space), so an import named in one is no import.
  const code = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  for (const m of code.matchAll(RE)) {
    const spec = m[1] ?? m[2];
    if (!resolves(spec, abs)) { bad++; console.log(`UNRESOLVED ${f}: ${spec}`); }
  }
}
console.log(`${files.length} files, ${bad} unresolved`);
process.exit(bad ? 1 : 0);
