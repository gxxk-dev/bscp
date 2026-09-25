/* 构建：把 Tailwind 编译结果与官方 Heroicons 路径内联进单个 HTML，
   产出的 canvas-ui.html 无依赖、可双击、离线可跑。
   运行：bun run build  */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const tmp = join(here, ".build");
mkdirSync(tmp, { recursive: true });

/* 1. Tailwind 编译 */
const cssOut = join(tmp, "tailwind.css");
const r = spawnSync(
  "bunx",
  ["@tailwindcss/cli", "-i", join(src, "input.css"), "-o", cssOut, "--minify"],
  { stdio: "inherit", cwd: here }
);
if (r.status !== 0) process.exit(r.status ?? 1);

/* 2. 组装 */
const css = readFileSync(cssOut, "utf8");
const icons = readFileSync(join(src, "heroicons.json"), "utf8").trim();
const js = readFileSync(join(src, "app.js"), "utf8").replace("/*__ICONS__*/", icons);
const shell = readFileSync(join(src, "canvas-ui.html"), "utf8");

const out = shell
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js);

const dest = join(here, "canvas-ui.html");
writeFileSync(dest, out);
console.log(`\n产出 ${dest}  （${(out.length / 1024).toFixed(1)} KB，零依赖）`);
