import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(dir + "/" + entry.name) : [dir + "/" + entry.name]);
const paths = ["index.js", ...files("src"), ...files("test"), ...files("scripts")].filter(path => path.endsWith(".js"));
for (const path of paths) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
for (const path of ["index.js", ...files("src")]) {
  const text = readFileSync(path, "utf8");
  for (const pattern of [/\bpi\.on\s*\(/, /registerTool\s*\(/, /registerCommand\s*\(/, /setInterval\s*\(/,
    /node:(?:child_process|http|https|net|fs)/, /globalThis\.fetch\s*=/, /setGlobalDispatcher/, /readFile/]) {
    if (pattern.test(text)) throw new Error(path + " violates the lightweight boundary: " + pattern);
  }
}
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length) throw new Error("Runtime dependencies must be empty");
console.log("Syntax and zero-hook/zero-background/zero-dependency checks passed.");
