// 行为路径演示的冒烟测试：12 条路径 × 每一屏，逐一断言状态与控件。
// 原型是「跑一下就知道对不对」的东西，所以这些断言查的是**行为**——
// 区域摆在哪、有几个主按钮、确认框说的是不是真话、投屏时痕迹有没有清干净。
//
// 用法：bun run build && bun run smoke
// 脚本自己起 vite preview，不需要先手动开服务。
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SHOTS = join(root, ".build", "shots");
const FIX = join(root, ".build", "fixtures");
const ORIGIN = "http://localhost:4173";

/* 投放测试要真文件：只有真的 File 对象过一遍 MIME 判定，
   才测得到「这个格式收不收」这条闸门。 */
mkdirSync(FIX, { recursive: true });
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAWklEQVR4nO3QMQEAAAjDMMC/56EB" +
  "Xis4kj7dOQGAjQ4gm5ggEBAQEBAQEBAQEBAQEBAQEBB4AV0dAQFo6AABjZcNPAAAAAElFTkSuQmCC",
  "base64");
const FIXTURES = {
  png: join(FIX, "月考卷.png"),
  docx: join(FIX, "月考卷.docx"),
  pdf: join(FIX, "月考卷.pdf"),
};
writeFileSync(FIXTURES.png, PNG);
writeFileSync(FIXTURES.docx, Buffer.from("PK fake docx for the gate test"));
writeFileSync(FIXTURES.pdf, Buffer.from("%PDF-1.4\n% fake\n"));

async function dropFile(page, path, mime, name) {
  const buf = readFileSync(path);
  const dt = await page.evaluateHandle(([bytes, type, filename]) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(bytes)], filename, { type }));
    return d;
  }, [[...buf], mime, name]);
  /* 派发到 #app 而不是 body：React 的事件树挂在 #root 里面，事件往上冒
     不会往下钻进那棵树。派给 body 的话处理器根本不会被调用。 */
  await page.dispatchEvent("#app", "drop", { dataTransfer: dt });
}

const ORDER = [
  "drop", "reject", "parse", "scatter", "confirm", "splitcut",
  "group", "arrange", "reread", "rerun", "cast", "nav",
];
const STEPS = {
  drop: 2, reject: 2, parse: 2, scatter: 2, confirm: 4, splitcut: 3,
  group: 3, arrange: 3, reread: 3, rerun: 3, cast: 3, nav: 2,
};

const fails = [];
const notes = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };
const note = (msg) => notes.push(msg);

const server = spawn("bunx", ["vite", "preview", "--port", "4173", "--strictPort"],
  { cwd: root, stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("preview server 没起来");
}
await waitForServer();
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const go = (path, step) =>
  page.goto(`${ORIGIN}/?path=${path}&step=${step}`, { waitUntil: "load" });
const boxes = () => page.locator("[data-id]").evaluateAll((els) =>
  els.map((e) => ({
    id: e.dataset.id,
    x: parseFloat(e.style.left),
    y: parseFloat(e.style.top),
    w: parseFloat(e.style.width),
    h: parseFloat(e.style.height),
  })));

// ---------- 1. 每一屏都不许有运行时错误 ----------
for (const p of ORDER) for (let s = 0; s < STEPS[p]; s++) await go(p, s);
check(errors.length === 0, "有运行时错误：\n  " + errors.join("\n  "));

// ---------- 2. 投放：真拖一个文件进去，不许只是嘴上说说 ----------
let acts;
await go("drop", 0);
acts = await page.locator("#chrome button").allTextContents();
check(acts.length === 0, `drop#0 画布空时不该有按钮，实际：${JSON.stringify(acts)}`);

/* 拖到屏幕任意位置都要有反应——投放区是整屏，不是一个小框 */
await page.goto(`${ORIGIN}/?path=drop&step=0`, { waitUntil: "load" });
const dt = await page.evaluateHandle(() => new DataTransfer());
await page.dispatchEvent("#app", "dragover", { dataTransfer: dt });
await page.waitForTimeout(80);
const overVisible = await page.locator("text=松手就投放").isVisible();
check(overVisible, "拖到画面上必须给出「可以放」的反馈，否则人不知道松手会发生什么");
note("dragover 铺满整屏并提示「松手就投放」");

await dropFile(page, FIXTURES.png, "image/png", "月考卷.png");
await page.waitForTimeout(200);
check((await page.locator("[data-id]").count()) === 1, "投放图片后画布上应出现一块");
check((await page.locator("[data-id] img").count()) === 1, "投放的图片应真的显示出来");
const afterDrop = await page.locator("body").innerText();
check(afterDrop.includes("月考卷.png"), `回执应带上文件名，实际片段：${afterDrop.slice(0, 120)}`);
check(afterDrop.includes("解析"), "投放成功后应出现「解析」");
note(`投放图片 → ${afterDrop.match(/已投放[^\n]*/)?.[0] ?? "（无回执）"}`);

await dropFile(page, FIXTURES.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "月考卷.docx");
await page.waitForTimeout(200);
const rej = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check(rej.includes("月考卷.docx") && rej.includes("另存为 PDF"),
  `拒收回执要同时说清文件名和出路，实际：${rej.slice(0, 200)}`);
check(rej.includes("首版只支持图片和 PDF") || rej.includes("首版不收 Word"),
  `拒收回执要说清原因，实际：${rej.slice(0, 200)}`);
note(`拒收 DOCX → ${rej.match(/月考卷\.docx[^\n]*/)?.[0]?.slice(0, 60) ?? "（无回执）"}`);

await go("drop", 1);
acts = await page.locator("#chrome button").allTextContents();
check(acts.includes("解析"), "drop#1 应出现「解析」");

// ---------- 3. DOCX 被拒：画布空 + 回执在 + 出路在 ----------
await go("reject", 1);
check((await page.locator("[data-id]").count()) === 0, "reject#1 画布应为空（被拒的文件没变成任何东西）");
const toast = page.locator("text=高一物理月考卷.docx");
check(await toast.isVisible(), "reject#1 应有回执");
const toastText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check(toastText.includes(".docx") && toastText.includes("PDF"), `回执应说清文件名与出路：${toastText.slice(0, 200)}`);
acts = await page.locator("#chrome button").allTextContents();
check(acts.some((t) => t.includes("另存为 PDF")), `reject#1 应给出路按钮，实际：${JSON.stringify(acts)}`);
note(`reject#1 底部 = ${JSON.stringify(acts)}`);

// ---------- 4. 碎开：位移看得见，且朝版面中心向外 ----------
await go("scatter", 0);
const home = await boxes();
await go("scatter", 1);
const scat = await boxes();
const deltas = home.map((h, i) => Math.hypot(scat[i].x - h.x, scat[i].y - h.y));
check(Math.min(...deltas) >= 12, `碎开位移太小（最小 ${Math.min(...deltas).toFixed(1)}px），1440px 屏上看不见`);
note(`碎开位移 = ${deltas.map((d) => d.toFixed(1)).join(" / ")} px`);
const cx = 650, cy = 360;                       // 原始版面 1300×720 的中心
const outward = home.every((h, i) => {
  const d0 = Math.hypot(h.x + h.w / 2 - cx, h.y + h.h / 2 - cy);
  const d1 = Math.hypot(scat[i].x + scat[i].w / 2 - cx, scat[i].y + scat[i].h / 2 - cy);
  return d1 >= d0 - 0.5;
});
check(outward, "碎开必须朝版面中心向外散开");

// ---------- 5. 拍板：一屏最多一个 primary，画布不能被锁死 ----------
for (const s of [0, 1, 2, 3]) {
  await go("confirm", s);
  const n = await page.locator("#chrome button.bg-emerald-600").count();
  check(n <= 1, `confirm#${s} 有 ${n} 个 primary 按钮（规范：一屏最多一个）`);
  const blocked = await page.locator("#chrome button.bg-emerald-600").first()
    .evaluate((el) => { const b = el.getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return t !== el && !el.contains(t); });
  check(!blocked, `confirm#${s} 按钮被热点层挡住了，这一屏正需要操作`);
}

// ---------- 6. 继续切碎：表格按行切，且能单独放满屏 ----------
await go("reread", 1);
const kids = await page.locator("[data-id]").evaluateAll((els) =>
  els.map((e) => ({ id: e.dataset.id, y: parseFloat(e.style.top),
                    h: parseFloat(e.style.height),
                    rows: e.querySelectorAll("tbody tr").length })));
const mine = kids.filter((k) => k.id.startsWith("r6"));
check(mine.length === 4, `reread#1 应切出 4 块，实际 ${mine.length}`);
check(mine.every((k) => k.rows === 2), `每块应只带表头 + 自己那 1 行，实际 ${mine.map((k) => k.rows)}`);
check(mine.every((k, i) => i === 0 || k.y > mine[i - 1].y), "表格必须沿高度按行堆叠，不能按列切");
check(new Set(mine.map((k) => k.h)).size === 1, "同一张表切出的块高应一致");
note(`reread#1 切成 ${mine.map((k) => `${k.id}@y${k.y}h${k.h}`).join(" ")}`);

await go("reread", 2);
const left = await page.locator("[data-id]").count();
check(left === 1, `reread#2 应只剩一块，实际 ${left}`);
const which = await page.locator("[data-id]").getAttribute("data-id");
check(which === "r60", `reread#2 剩的那块必须是表格切出来的 r60，实际是 ${which}`);
const cells = await page.locator("[data-id] tbody tr").count();
check(cells === 2, `reread#2 那块应只带表头 + 1 行，实际 ${cells} 行`);
const one = (await boxes())[0];
const k2 = await page.locator("[data-id]").evaluate((e) => e.getBoundingClientRect().width / parseFloat(e.style.width));
check(k2 > 1.5, `reread#2 应把一块放大到占满屏（实际缩放 ${k2.toFixed(2)}x）`);
note(`reread#2 = ${which}，放大到 ${k2.toFixed(2)}x，屏上占 ${Math.round(one.w * k2)}px 宽`);

// ---------- 7. 重跑：确认框必须真出现，数字是算出来的 ----------
/* 先去别的路径把 r1 挪走，再回来数——「你摆过几块」不能随切路径而变 */
await go("arrange", 1);
await go("rerun", 1);
check(await page.locator("[role=dialog]").isVisible(), "rerun#1 必须弹强确认框");
const body = (await page.locator("[role=dialog]").innerText()).replace(/\s+/g, " ").trim();
check(/2\s*块区域/.test(body), `确认框应数出 2 块被移动的区域（上一屏挪过 r1 也不该多算），实际：${body}`);
check(body.includes("覆盖") && !/确定吗/.test(body), "确认框要说清会丢什么，不做无脑确认");
note(`rerun#1 确认框 = ${body}`);

await go("rerun", 0);
const moved = await boxes();
check(moved.filter((b) => b.y === 770).length === 2, "rerun#0 应有两块被摆到预设位置");
/* 摆过的块不许压着别人——压住了评审者会以为是渲染错位，而不是「你摆的」 */
const overlap = moved.some((a, i) => moved.some((b, j) =>
  i !== j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
check(!overlap, `rerun#0 有块互相压住了：${moved.map((b) => `${b.id}@${b.x},${b.y}`).join(" | ")}`);
note(`rerun#0 块位置 = ${moved.map((b) => `${b.id}@${b.x},${b.y}`).join(" | ")}`);

await go("scatter", 1);
await page.locator('#chrome [aria-label="重跑解析"]').click();
await page.waitForTimeout(150);
const clean = (await page.locator("[role=dialog]").innerText()).replace(/\s+/g, " ").trim();
check(/还没有任何编排/.test(clean), `没摆过东西时确认框应说清楚，实际：${clean}`);
note(`碎开后直接点重跑 = ${clean.slice(0, 40)}…`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check(!(await page.locator("[role=dialog]").isVisible()), "Esc 应能关掉确认框");

// ---------- 8. 投屏：零操作痕迹，进出不改布局 ----------
await go("cast", 0);
check((await page.locator(".src-badge").count()) === 6, "cast#0 应有 6 个来源角标");
check(await page.locator("#hint").isVisible(), "cast#0 应有提示条");

await go("cast", 1);
check((await page.locator("#chrome").count()) === 0, "cast#1 底部控件必须整个消失");
check((await page.locator("#hint").count()) === 0, "cast#1 提示条必须消失");
check((await page.locator(".src-badge").count()) === 0, "cast#1 来源角标必须消失");
check((await page.locator(".unit-tag").count()) === 0, "cast#1 分组标必须消失");
check((await page.locator("[data-id].ring-2").count()) === 0, "cast#1 选中框必须消失");
const castPos = JSON.stringify(await boxes());
await go("cast", 0);
check(JSON.stringify(await boxes()) === castPos, "进出投屏位置必须一模一样");
note("cast#0 ↔ cast#1 位置逐块一致，操作痕迹全清");

await go("cast", 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check((await page.locator(".src-badge").count()) === 6, "Esc 应能退出投屏并恢复操作态");

// ---------- 9. 控件顺序：重跑必须离手最远 ----------
await go("arrange", 2);
const labels = await page.locator("#chrome button").evaluateAll((els) =>
  els.map((e) => e.getAttribute("aria-label") ?? e.textContent.trim()));
check(labels.length >= 4, `arrange#2 底部控件太少：${JSON.stringify(labels)}`);
check(labels.at(-1) === "重跑解析", `重跑必须排在最右，实际：${JSON.stringify(labels)}`);
note(`arrange#2 底部 ${labels.length} 个控件 = ${labels.join(" · ")}`);

// ---------- 10. 拖动真的能改位置，而且相机不许跟着动 ----------
/* 相机的 transform 就在 #stage 上。空画布时也得读得到——投放那一屏
   恰恰是没有区域的。 */
const cam = () => page.locator("#stage").evaluate((e) => getComputedStyle(e).transform);

await go("arrange", 0);
const before = (await boxes()).find((b) => b.id === "r6").y;
const box = await page.locator('[data-id="r6"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 - 90, { steps: 8 });
check((await cam()) === await cam(), "相机在拖动过程中动了 —— 手感就是被这个毁掉的");
check((await boxes()).find((b) => b.id === "r6").y !== before, "拖动 r6 应当改变它的位置");

/* 逐帧查：相机必须在整段拖动里纹丝不动 */
const frames = [];
await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 - 120, { steps: 4 });
for (let i = 0; i < 4; i++) {
  frames.push(await cam());
  await page.mouse.move(box.x + box.width / 2 + 200 + i * 30, box.y + box.height / 2 - 120, { steps: 2 });
}
check(new Set(frames).size === 1, `拖动全程相机变了 ${new Set(frames).size} 次：${[...new Set(frames)].join(" / ")}`);
await page.mouse.up();
note("拖动全程相机不动（transform 恒定），块本身在动");

/* 投放也不许动相机 */
await go("drop", 0);
const camBeforeDrop = await cam();
await dropFile(page, FIXTURES.png, "image/png", "月考卷.png");
await page.waitForTimeout(200);
check((await cam()) === camBeforeDrop, "投放文件后相机自己缩放/移动了 —— 落点应该由操作者自己平移");
note("投放后相机不动");

/* 操作者自己平移过之后，拖块也不能把它冲掉 */
await go("arrange", 0);
const vp = await page.locator("#app").boundingBox();
await page.mouse.move(vp.x + 40, vp.y + vp.height - 40);
await page.mouse.down();
await page.mouse.move(vp.x + 140, vp.y + vp.height - 90, { steps: 4 });
await page.mouse.up();
const panned = await cam();
const r6box = await page.locator('[data-id="r6"]').boundingBox();
await page.mouse.move(r6box.x + 40, r6box.y + 40);
await page.mouse.down();
await page.mouse.move(r6box.x + 100, r6box.y + 90, { steps: 4 });
check((await cam()) === panned, "拖块把手动平移的视野冲掉了");
await page.mouse.up();
note("手动平移后拖块，视野保持不动");

// ---------- 截图 ----------
for (const [p, s] of [["drop", 0], ["drop", 1], ["reject", 1], ["scatter", 0], ["scatter", 1],
                      ["confirm", 1], ["confirm", 2], ["splitcut", 1], ["group", 0],
                      ["arrange", 2], ["reread", 1], ["reread", 2], ["rerun", 1],
                      ["cast", 0], ["cast", 1], ["nav", 0], ["nav", 1]]) {
  await go(p, s);
  await page.screenshot({ path: join(SHOTS, `${p}-${s}.png`) });
}

await browser.close();
stop();

console.log("—— 观察 ——");
for (const n of notes) console.log("  " + n);
console.log("\n—— 结果 ——");
if (fails.length) {
  console.log(`✗ ${fails.length} 项不通过：`);
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log(`✓ 12 条路径 / ${ORDER.reduce((n, p) => n + STEPS[p], 0)} 屏全部通过`);
