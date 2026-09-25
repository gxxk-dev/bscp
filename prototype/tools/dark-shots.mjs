// 暗色模式抽查：design skill 的 dark-mode.md 要求暗色不是简单反色，
// 而是保持同样的对比度。这个脚本只截图，不做断言——暗色好不好看得用眼睛。
// 用法：node tools/dark-shots.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SHOTS = join(root, ".build", "shots");
const PORT = 4174;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort"],
  { cwd: root, stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  for (const [p, s] of [["scatter", 1], ["group", 0], ["confirm", 2], ["rerun", 1], ["cast", 1]]) {
    await page.goto(`${ORIGIN}/?path=${p}&step=${s}`);
    await page.screenshot({ path: join(SHOTS, `${scheme}-${p}-${s}.png`) });
  }
  /* 多资源投放：三份一起进来，画布上并排三块 */
  await page.goto(`${ORIGIN}/?path=drop&step=0`);
  const png = readFileSync(join(root, ".build", "fixtures", "月考卷.png"));
  const dt = await page.evaluateHandle((bytes) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(bytes)], "九月月考卷.png", { type: "image/png" }));
    d.items.add(new File([new Uint8Array(bytes)], "板书照片.png", { type: "image/png" }));
    d.items.add(new File([new Uint8Array(bytes)], "实验报告.pdf", { type: "application/pdf" }));
    return d;
  }, [...png]);
  await page.dispatchEvent("#app", "drop", { dataTransfer: dt });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${scheme}-multi-drop.png`) });
  await page.close();
}
await browser.close();
stop();
console.log(`截图已写入 ${SHOTS}`);
