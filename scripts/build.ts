// Builds the page into dist/: the bundle (esbuild), its fonts, the app mark's frames (AppMark loads them
// beside the bundle) and index.html. `--watch` rebuilds on change.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, "node_modules/@paperboatlab/ui/src/marks/malachite"), path.join(dist, "marks/malachite"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html>
<html lang="en" data-app="malachite">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Malachite</title>
<link rel="icon" href="marks/malachite/rest.webp">
<link rel="stylesheet" href="main.css">
</head>
<body><div id="root"></div><script type="module" src="main.js"></script></body>
</html>
`);
// About shows the version and, from a git checkout, the commit
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
let commit = "";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a checkout */ }
const options: esbuild.BuildOptions = {
  entryPoints: [path.join(root, "client/main.tsx")],
  bundle: true, format: "esm", outdir: dist, jsx: "automatic", target: "es2022", minify: !process.argv.includes("--watch"),
  sourcemap: true, loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" }, assetNames: "fonts/[name]-[hash]", logLevel: "warning",
  define: { __VERSION__: JSON.stringify(version), __COMMIT__: JSON.stringify(commit) },
};
if (process.argv.includes("--watch")) { await (await esbuild.context(options)).watch(); console.log("watching client/ → dist/"); }
else await esbuild.build(options);
