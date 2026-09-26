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

/* 派发到 #app 而不是 body：React 的事件树挂在 #root 里面，事件往上冒
   不会往下钻进那棵树。派给 body 的话处理器根本不会被调用。 */
const dropDT = (page, dt, at) =>
  page.dispatchEvent("#app", "drop", { dataTransfer: dt, clientX: at?.x, clientY: at?.y });

async function dropFiles(page, list, at) {
  const dt = await page.evaluateHandle((items) => {
    const d = new DataTransfer();
    for (const [bytes, type, filename] of items) {
      d.items.add(new File([new Uint8Array(bytes)], filename, { type }));
    }
    return d;
  }, list.map((f) => [[...readFileSync(f.path)], f.mime, f.name]));
  await dropDT(page, dt, at);
}
/* 现场画一张真的大 PNG。造这种文件不是为了看，是为了让 probeImage
   读到一个手机实拍照那个量级的自然尺寸（3000×2000）——按原尺寸摆的话
   一张图就把整块画布吞掉，第二份连落脚的缝都没有。 */
function bigPhotoDT(page) {
  return page.evaluateHandle(() => new Promise((res) => {
    const c = document.createElement("canvas");
    c.width = 3000; c.height = 2000;
    c.getContext("2d").fillRect(0, 0, 3000, 2000);
    c.toBlob((b) => {
      const d = new DataTransfer();
      d.items.add(new File([b], "板书实拍.png", { type: "image/png" }));
      res(d);
    }, "image/png");
  }));
}
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const F = (name, mime, path) => ({ name, mime, path });
const dropFile = (page, path, mime, name, at) =>
  dropFiles(page, [F(name, mime, path)], at);

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
/* 失败与观察都带上视口标签：同一屏在两个尺寸下可能一个过一个不过，
   没有标签就只能靠猜是哪边坏了。 */
let vpLabel = "";
const check = (cond, msg) => { if (!cond) fails.push(`[${vpLabel}] ${msg}`); };
const note = (msg) => notes.push(`[${vpLabel}] ${msg}`);

/* 每一段各自 try/catch，外加一个时间预算。一段崩了（等不到元素、超时、
   选择器写错）不该让后面十几段的结果一起拿不到——早先是一个异常直接掀翻
   整个脚本，而 fails/notes 只在文件末尾打印，于是「崩了」和「不过」看起来
   一模一样，而且一条已跑过的断言都看不见。
   预算不是可有可无的：try/catch 挡得住「抛异常」，挡不住「卡住不动」，
   而卡住是最难查的一种——脚本既不绿也不红，就在那儿耗着，等它的人只能
   靠猜。超了记一行「这段没在 N 秒内结束」继续往下，至少结果还能打出来。
   每段开工时往 stderr 打一行：整场要跑十几分钟，卡住时这一行是唯一的线索。 */
const SECTION_BUDGET_MS = 180_000;
const section = async (name, fn) => {
  process.stderr.write(`  … ${vpLabel} ${name}\n`);
  let timer;
  const budget = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`这一段 ${SECTION_BUDGET_MS / 1000}s 还没结束`)),
      SECTION_BUDGET_MS);
  });
  try { await Promise.race([fn(), budget]); }
  catch (e) {
    fails.push(`[${vpLabel}] 「${name}」这一段崩了：${String(e?.message ?? e).split("\n")[0]}`);
  }
  finally { clearTimeout(timer); }
};

/* 运行时错误收集器。**只在全脚本末尾断言一次**，而且只收三类：
     pageerror     —— 未捕获的 JS 异常（React 渲染炸掉也在内）
     requestfailed —— 请求压根没落地（连不上、被取消）
     HTTP >= 400   —— 服务端明说了不成功
   早先那版把**所有** error 级 console 日志也收进来，那是纯噪声：浏览器
   自己的抱怨、资源探测、devtools 提示都会混进断言，结果要么逼人加白名单，
   要么所有人开始习惯性无视这一条。
   代价是这一条特别容易 fail-open：监听器压根没接上时它恒为空，一路绿。
   所以第 0 段先跑一次阳性对照，故意制造两类错误，确认收得到。 */
const runtimeErrors = [];
let fatal = null;
let navCount = 0;

/* 目标屏是 1920×1080（ADR-0018），但这 32 屏断言是按 1440×900 桌面视口调的。
   两个都要跑，**不是二选一**：1440 验开发时的桌面，1920 验真正要投屏的那台机器。
   4K 不在这里跑——4K 的处理是根字号放大一档（ADR-0018），那要等实现阶段。
   放在 try 外面：finally 里那个 report() 要用它的长度与标签，而 try/finally
   各自是独立块作用域，写在 try 里 finally 看不见。 */
const VIEWPORTS = [
  { width: 1440, height: 900, label: "1440×900" },
  { width: 1920, height: 1080, label: "1920×1080" },
];

/* 结果**永远**要打印，哪怕脚本半路死了。这是 brief §7-7 指的那处伤：
   截图卡在字体加载时抛的是未捕获异常，而观察与失败清单原本只在正常路径
   的末尾打印，于是「所有断言都过了」和「一条都没跑」在输出上一模一样。 */
function report(fatal) {
  if (fatal) console.log(`\n!! 脚本没能跑完：${String(fatal?.stack ?? fatal).split("\n")[0]}`);
  console.log("—— 观察 ——");
  for (const n of notes) console.log("  " + n);
  console.log("\n—— 结果 ——");
  if (fails.length) {
    console.log(`✗ ${fails.length} 项不通过：`);
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log(`✓ 12 条路径 / ${ORDER.reduce((n, p) => n + STEPS[p], 0)} 屏 × `
    + `${VIEWPORTS.length} 个视口（${VIEWPORTS.map((v) => v.label).join("、")}）全部通过`);
}

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
/* 浏览器句柄放在 try 外面，理由与上面 VIEWPORTS 那条完全一样：finally 与
   try 是兄弟块，看不见写在 try 里的 let。

   写成 try 内部时，finally 里那行 `await browser?.close()` 拿到的是一个
   未声明标识符，抛 ReferenceError——而它外面正好套着一个空 catch，异常被
   静默吞掉，浏览器从头到尾没被关过。症状极具迷惑性：结果照常打印、
   `process.on("exit", stop)` 也照常跑，唯独进程永不退出。于是每一个跑
   冒烟的 agent 都要挂到工具超时才拿得到那行绿字，而挂着的那些 chrome
   还会一直占着内存。 */
let browser;

try {
await waitForServer();
mkdirSync(SHOTS, { recursive: true });

/* 收集器是全脚本一份，不随视口重置：末尾那一条「零运行时错误」要覆盖
   两个视口全部 90 次导航，per-viewport 的数组拼起来才有那个覆盖面。 */
const attachErrorCollectors = (pg, label) => {
  pg.on("pageerror", (e) => runtimeErrors.push(`[${label}] pageerror: ${e.message}`));
  pg.on("requestfailed", (r) => {
    /* ERR_ABORTED 是我们自己造成的：导航打断上一次请求、blob 撤销。
       把它算成失败，这条断言就只能在人不去点任何东西时才可能绿。 */
    const why = r.failure()?.errorText ?? "";
    if (why.includes("ERR_ABORTED")) return;
    runtimeErrors.push(`[${label}] 网络失败: ${why} ${r.url()}`);
  });
  pg.on("response", (r) => {
    if (r.status() >= 400) runtimeErrors.push(`[${label}] HTTP ${r.status()}: ${r.url()}`);
  });
};

browser = await chromium.launch();
/* go/boxes/cam 闭包引用 page，所以 page 是可变绑定而不是每次新建的局部量。 */
let page;

/* 等应用真的挂上，别用 sleep 赌首屏时序。waitUntil:"load" 只保证 load
   事件放行了，React 挂载与键盘监听器挂上还差几毫秒；早先 Esc 那条断言
   是在 goto 返回后**零延迟**按的，赌的就是那几毫秒——赌赢了是基线，
   任何改动首屏时序的代码都可能把它翻成输，而现象（没退出、URL 停在
   cast）看着像 Esc 逻辑坏了，排查极贵。#stage 是 Canvas 的根，它出现
   就意味着应用已经挂载。 */
const settled = () => page.waitForFunction(
  () => !!document.querySelector("#stage"), null, { timeout: 5000 });

const go = (path, step) => {
  navCount += 1;
  return page.goto(`${ORIGIN}/?path=${path}&step=${step}`, { waitUntil: "load" })
    .then(settled);
};
/* boxes() 读内联 style.left/top/width/height 而不是 getBoundingClientRect()，
   是刻意的：前者不受 #stage 的 transform 影响，所以测的是模型里的画布
   坐标而不是屏上像素。代价是它焊死了「坐标以 px 写在 style 上」这个
   实现形态——这是契约，不是巧合，改实现就要连同这里一起改。 */
const boxes = () => page.locator("[data-id]").evaluateAll((els) =>
  els.map((e) => ({
    id: e.dataset.id,
    x: parseFloat(e.style.left),
    y: parseFloat(e.style.top),
    w: parseFloat(e.style.width),
    h: parseFloat(e.style.height),
  })));
/* 相机的断言比的是 matrix(a,b,c,d,e,f) 的**六个数值**，不是浏览器吐回来
   的那串原文（brief §7-10）。字符串比较是 fail-closed 的：谁把 translate
   换成 translate3d，computed style 就变成 matrix3d(16 个数)，7 处相等
   比较一起恒失败，而差异看起来完全不像「有人改了 transform 的写法」。
   顺带把 matrix3d 折回它的 2D 仿射子式，所以换写法不会让断言翻脸，
   只会在 message 里显形。空画布时也读得到——投放那一屏恰恰没有区域，
   而那时 computed style 可能是 "none"，按单位阵处理。 */
const cam = () => page.locator("#stage").evaluate((el) => {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return "matrix(1,0,0,1,0,0)";
  const n = t.slice(t.indexOf("(") + 1, -1).split(",").map(Number);
  const six = n.length === 16
    ? [n[0], n[1], n[4], n[5], n[12], n[13]]
    : n.slice(0, 6);
  return `matrix(${six.map((v) => Math.round(v * 1000) / 1000).join(",")})`;
});

/* 叫 vpSize 不叫 vp：函数体里已经有一个 `const vp` 是 #app 的 boundingBox，
   同名会把循环变量遮蔽进暂时性死区。 */
for (const vpSize of VIEWPORTS) {
  vpLabel = vpSize.label;
  const shots = join(SHOTS, `${vpSize.width}x${vpSize.height}`);
  mkdirSync(shots, { recursive: true });
  page = await browser.newPage({ viewport: { width: vpSize.width, height: vpSize.height } });
  attachErrorCollectors(page, vpSize.label);
  const before = runtimeErrors.length;

  // ---------- 0. 错误收集器自检（阳性对照）----------
  /* 「全脚本零运行时错误」是最容易 fail-open 的一条：监听器没接上、事件名
     写错、Playwright 改了行为——任何一种都让它一路绿。所以先在一个一次性
     的页面上故意制造**三类**错误，确认收集器真的收得到，再把自检产生的条目
     从计数里摘掉。这一段自己 throw 的话不算失败。

     第三个探针（HTTP ≥ 400）以前没有，于是 `pg.on("response")` 那一支
     从头到尾没被正向打过：把 `>= 400` 改成 `>= 500`（或者 Playwright 哪个
     版本改了 response 事件的时机导致回调不触发），全脚本 168 次导航里任何
     一个 4xx/5xx 都不进数组，末尾照样打「✓ 全场零运行时错误（pageerror /
     网络失败 / HTTP≥400）」——而那句「HTTP≥400」是不成立的。 */
  await section("0. 错误收集器自检", async () => {
    const probe = await browser.newPage();
    const seen = [];
    attachErrorCollectors(probe, "自检");
    /* 造一个必定 500 的响应。`vite preview` 没有 4xx 路由（未知路径会走
       SPA 兜底回 200），所以用 `page.route` 拦一个本地路径造出来——它是
       确定性的，不依赖 preview 的兜底行为。 */
    await probe.route("**/smoke-selfcheck-500", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await probe.goto(`${ORIGIN}/?path=drop&step=0`, { waitUntil: "load" });
    await probe.evaluate(() => {
      setTimeout(() => { throw new Error("smoke 自检：故意抛的"); }, 0);
    });
    /* 连一个压根不存在的端口：ERR_CONNECTION_REFUSED 是确定的失败，
       而「请求一个不存在的路径」不一定（preview 可能有 SPA 兜底）。 */
    await probe.evaluate(() => { fetch("http://127.0.0.1:9/").catch(() => {}); });
    /* 第三个：一次 HTTP 500。走 page.evaluate 的 fetch 而不是 <img>，
       免得 500 的响应体影响别的东西。 */
    await probe.evaluate(() => { fetch("/smoke-selfcheck-500").catch(() => {}); });
    await probe.waitForTimeout(400);
    await probe.close();
    const gotPage = runtimeErrors.slice(before).some((e) => e.includes("smoke 自检"));
    const gotNet = runtimeErrors.slice(before).some((e) => e.includes("网络失败"));
    const gotHttp = runtimeErrors.slice(before).some((e) => e.includes("HTTP 500"));
    check(gotPage, "pageerror 收集器阳性对照失败 —— 「零运行时错误」这条断言会 fail-open");
    check(gotNet, "网络失败收集器阳性对照失败 —— 同上");
    check(gotHttp,
      "HTTP≥400 收集器阳性对照失败 —— 同上，而末尾那句「HTTP≥400」会是假的");
    runtimeErrors.length = before;      // 自检条目不进正式计数
    note("错误收集器阳性对照：故意抛的异常、一次连接失败、一次 HTTP 500 都被收到");
  });

  // ---------- 1. 每一屏都得能走到 ----------
  await section("1. 32 屏横扫", async () => {
    for (const p of ORDER) for (let s = 0; s < STEPS[p]; s++) await go(p, s);
    /* 这里原来顺手查了一次运行时错误。32 屏之后还有 90 次导航，那些全在
       监控之外——查得早等于没查。挪到全脚本末尾了。 */
    note(`横扫 ${ORDER.reduce((n, p) => n + STEPS[p], 0)} 屏，运行时错误留到末尾统一查`);
  });

  // ---------- 2. 投放：真拖一个文件进去，不许只是嘴上说说 ----------
  let acts;
  await section("2. 投放", async () => {
  await go("drop", 0);
  acts = await page.locator("#chrome button").allTextContents();
  check(acts.length === 0, `drop#0 画布空时不该有按钮，实际：${JSON.stringify(acts)}`);

/* 拖到屏幕任意位置都要有反应——投放区是整屏，不是一个小框 */
await go("drop", 0);
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

await dropFile(page, FIXTURES.docx, DOCX_MIME, "月考卷.docx");
await page.waitForTimeout(200);
const rej = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check(rej.includes("月考卷.docx") && rej.includes("另存为 PDF"),
  `拒收回执要同时说清文件名和出路，实际：${rej.slice(0, 200)}`);
check(rej.includes("首版不收 Word") || rej.includes("首版只支持图片和 PDF"),
  `拒收回执要说清原因，实际：${rej.slice(0, 200)}`);
note(`拒收 DOCX → ${rej.match(/月考卷\.docx[^\n]*/)?.[0]?.slice(0, 60) ?? "（无回执）"}`);

/* ---------- 2b. 一次投多份，混着收和拒 ----------
   只取 files[0] 的写法会把另外几份静默丢掉。操作者会以为都在。 */
await go("drop", 0);
const camAtDrop = await cam();
const vpDrop = await page.locator("#app").boundingBox();
await dropFiles(page, [
  F("卷子.pdf", "application/pdf", FIXTURES.pdf),
  F("板书.png", "image/png", FIXTURES.png),
  F("作业.docx", DOCX_MIME, FIXTURES.docx),
  F("讲解.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", FIXTURES.docx),
], { x: vpDrop.x + 300, y: vpDrop.y + 220 });
await page.waitForTimeout(300);
const multi = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check((await page.locator("[data-id]").count()) === 2,
  `一次投 4 份应收下 2 份（PDF + PNG），实际画布上 ${await page.locator("[data-id]").count()} 块`);
check(multi.includes("已投放 2 份"), `回执要一次说清收下几份，实际：${multi.slice(0, 200)}`);
check(multi.includes("卷子.pdf") && multi.includes("板书.png"),
  `收下的要逐个点名，实际：${multi.slice(0, 240)}`);
check(multi.includes("没收") && multi.includes("作业.docx") && multi.includes("讲解.pptx"),
  `拒的也要逐个点名，不能静默丢弃，实际：${multi.slice(0, 300)}`);
note(`混合投放 4 份 → ${multi.match(/已投放[^\n]*?。/)?.[0] ?? ""} 拒：作业.docx、讲解.pptx`);

/* 相机不动的前提下，新内容必须锚在**松手那一下的光标**上，并落进当前视野。
   掉在画布原点的话，1440px 的屏只看得到第一份的一角，操作者还得自己平移
   过去才能确认「到底收下了没有」——那比自动取景更糟。 */
const vpBox = await page.locator("#app").boundingBox();

/* 单独在指定位置投一次，验它落在光标上（上面那次混合投放的落点是 300,200）。
   y 取 100：PDF 占位纸 1000×700，按视野份额收过之后是 605×423，丢到
   y=260 正好贴住下沿、触发收拢——那是下面那条边缘测试要验的事，这条只验
   「没该收拢时别乱收」。 */
await go("drop", 0);
const camAnchor = await cam();
const at = { x: vpBox.x + 420, y: vpBox.y + 100 };
await dropFile(page, FIXTURES.pdf, "application/pdf", "锚点测试.pdf", at);
await page.waitForTimeout(250);
const px = await page.locator('[data-id]').first().boundingBox();
check(Math.abs(px.x - at.x) < 4 && Math.abs(px.y - at.y) < 4,
  `投放的内容没锚在光标上：期望屏幕 (${at.x}, ${at.y})，实际 (${Math.round(px.x)}, ${Math.round(px.y)})`);
check(px.x >= vpBox.x - 2 && px.y >= vpBox.y - 2 && px.x < vpBox.x + vpBox.width,
  `投放的内容没落在当前视野里：第一块屏幕 x=${Math.round(px.x)}，视野 x=${Math.round(vpBox.x)}..${Math.round(vpBox.x + vpBox.width)}`);
check((await cam()) === camAnchor, "投放后相机动了 —— 内容该自己过来，不是视野该让路");
note(`投放内容锚在光标处（屏幕 ${Math.round(px.x)},${Math.round(px.y)}），相机纹丝不动`);

/* ---------- 2c. 默认大小受控，且多份依次向右下角摊开 ----------
   这两条是一件事的两个头：不控制大小，右边那份压根没地方摆；摊开而不
   控制大小，第三份的右下角已经在屏外了。 */

/* 头一：大图按视野份额收，不按自然尺寸。3000×2000 是手机实拍照的量级。 */
await go("drop", 0);
const vpBig = await page.locator("#app").boundingBox();
await dropDT(page, await bigPhotoDT(page), { x: vpBig.x + 80, y: vpBig.y + 80 });
await page.waitForTimeout(400);
const big = await page.locator("[data-id]").first().boundingBox();
check(big.width <= vpBig.width * 0.45,
  `大图按原尺寸摆出来了：3000px 的实拍照占 ${Math.round(big.width)}px 宽（视野只有 ${vpBig.width}px）`);
check(big.x + big.width <= vpBig.x + vpBig.width + 2 && big.y + big.height <= vpBig.y + vpBig.height + 2,
  `大图没收进视野：右边 ${Math.round(big.x + big.width - vpBig.width)}px、下边 ${Math.round(big.y + big.height - vpBig.height)}px 出界`);
note(`3000×2000 的实拍照 → 屏上 ${Math.round(big.width)}×${Math.round(big.height)}`);

/* 头二：小图不放大。放大出来的字是糊的，而这份资料等下要投到大屏上看。 */
await go("drop", 0);
await dropFile(page, FIXTURES.png, "image/png", "小图.png", { x: vpBox.x + 100, y: vpBox.y + 100 });
await page.waitForTimeout(250);
const small = await page.locator("[data-id]").first().boundingBox();
check(Math.round(small.width) === 100,
  `100px 的小图被放大到 ${Math.round(small.width)}px —— 放大出来的字是糊的`);
note(`100×100 的小图 → 原尺寸摆放，不放大`);

/* 头三：多份依次向右下角错开，每级步长相同，且整叠都在视野里。 */
await go("drop", 0);
const camCascade = await cam();
await dropFiles(page, [
  F("卷子.pdf", "application/pdf", FIXTURES.pdf),
  F("板书.png", "image/png", FIXTURES.png),
  F("实验报告.pdf", "application/pdf", FIXTURES.pdf),
], { x: vpBox.x + 140, y: vpBox.y + 120 });
await page.waitForTimeout(350);
const cas = (await boxes()).sort((a, b) => a.x - b.x);
check(cas.length === 3, `三份都该收下，实际 ${cas.length} 块`);
const sx = cas[1].x - cas[0].x, sy = cas[1].y - cas[0].y;
check(sx > 20 && sy > 20, `第二份没排在第一份的右下角：dx=${sx} dy=${sy}`);
check(cas[2].x - cas[1].x === sx && cas[2].y - cas[1].y === sy,
  `三份没排成一条等步长的对角线：${cas.map((b) => `${b.id}@${b.x},${b.y}`).join(" · ")}`);
const out = cas.filter((b) => b.x < vpBox.x - 2 || b.y < vpBox.y - 2
  || b.x + b.w > vpBox.x + vpBox.width + 2 || b.y + b.h > vpBox.y + vpBox.height + 2);
check(!out.length, `有 ${out.length} 份落在视野外：${out.map((b) => `${b.id}@${b.x},${b.y}`).join(" · ")}`);
check((await cam()) === camCascade, "摊开时相机动了 —— 相机只归操作者");
/* 错开之后每份只露出一角，认出「哪份是谁」的地方就只剩角标 */
const casBadges = await page.locator(".src-badge").allTextContents();
check(casBadges.length === 3 && casBadges.every((b) => /卷子|板书|实验/.test(b)),
  `三份都要带自己的来源角标，实际：${JSON.stringify(casBadges)}`);
note(`3 份依次向右下 ${sx}×${sy}px，整叠在视野内，相机不动，角标各带文件名`);
await page.screenshot({ path: join(shots, "drop-cascade.png") });

/* 补投不该抹掉已有的一批。抹掉等于逼人从头再来一遍。 */
await go("drop", 0);
await dropFile(page, FIXTURES.pdf, "application/pdf", "第一批.pdf", { x: vpBox.x + 100, y: vpBox.y + 100 });
await page.waitForTimeout(250);
await dropFile(page, FIXTURES.png, "image/png", "补投.png", { x: vpBox.x + 100, y: vpBox.y + 100 });
await page.waitForTimeout(250);
check((await page.locator("[data-id]").count()) === 2,
  `补投把第一批抹掉了：画布上应剩 2 块，实际 ${await page.locator("[data-id]").count()} 块`);
note("补投一份 = 接着摊，原有的一批不动");

/* 丢在右下角时要往回收，不然一半资料在屏幕外，操作者会以为没投进来 */
await go("drop", 0);
await dropFile(page, FIXTURES.pdf, "application/pdf", "靠边丢.pdf",
  { x: vpBox.x + vpBox.width - 30, y: vpBox.y + vpBox.height - 30 });
await page.waitForTimeout(250);
const edge = await page.locator('[data-id]').first().boundingBox();
check(edge.x + edge.width <= vpBox.x + vpBox.width + 2,
  `丢在右边缘时没收回来，右边超出 ${Math.round(edge.x + edge.width - vpBox.width)}px`);
check(edge.x >= vpBox.x - 2, `收回后反而跑到视野左边了（x=${Math.round(edge.x)}）`);
note(`丢在右下角自动收拢：右边界 ${Math.round(edge.x + edge.width)} ≤ 视野 ${Math.round(vpBox.x + vpBox.width)}`);

/* 每份资源的角标要写得出自己的文件名——多份资源时「卷 · p1」是废话 */
await go("cast", 0);
const badges = await page.locator(".src-badge").allTextContents();
check(badges.length === 6 && badges.every((b) => b.includes("p")),
  `样例资源的角标应带页码，实际：${JSON.stringify(badges)}`);

await go("drop", 1);
acts = await page.locator("#chrome button").allTextContents();
check(acts.includes("解析"), "drop#1 应出现「解析」");
  });

  // ---------- 3. DOCX 被拒：画布空 + 回执在 + 出路在 ----------
  await section("3. DOCX 被拒", async () => {
await go("reject", 1);
check((await page.locator("[data-id]").count()) === 0, "reject#1 画布应为空（被拒的文件没变成任何东西）");
const toast = page.locator("text=高一物理月考卷.docx");
check(await toast.isVisible(), "reject#1 应有回执");
const toastText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check(toastText.includes(".docx") && toastText.includes("PDF"), `回执应说清文件名与出路：${toastText.slice(0, 200)}`);
acts = await page.locator("#chrome button").allTextContents();
check(acts.some((t) => t.includes("另存为 PDF")), `reject#1 应给出路按钮，实际：${JSON.stringify(acts)}`);
note(`reject#1 底部 = ${JSON.stringify(acts)}`);
  });

  // ---------- 4. 碎开：位移看得见，且朝版面中心向外 ----------
  await section("4. 碎开", async () => {
await go("scatter", 0);
const home = await boxes();
await go("scatter", 1);
const scat = await boxes();
const deltas = home.map((h, i) => Math.hypot(scat[i].x - h.x, scat[i].y - h.y));
/* Math.min(...空数组) 是 Infinity，Infinity >= 12 恒真——被测集合空了这条
   断言就悄悄通过。先钉住集合非空（brief §7-6）。 */
check(deltas.length > 0, `碎开位移无从谈起：scatter#0 与 #1 上一块区域都没渲染出来（读到 ${deltas.length} 块）`);
check(deltas.length > 0 && Math.min(...deltas) >= 12, `碎开位移太小（最小 ${Math.min(...deltas).toFixed(1)}px），1440px 屏上看不见`);
note(`碎开位移 = ${deltas.map((d) => d.toFixed(1)).join(" / ")} px`);
const cx = 650, cy = 360;                       // 原始版面 1300×720 的中心
const outward = home.every((h, i) => {
  const d0 = Math.hypot(h.x + h.w / 2 - cx, h.y + h.h / 2 - cy);
  const d1 = Math.hypot(scat[i].x + scat[i].w / 2 - cx, scat[i].y + scat[i].h / 2 - cy);
  return d1 >= d0 - 0.5;
});
check(outward, "碎开必须朝版面中心向外散开");
  });

  // ---------- 5. 拍板：一屏最多一个 primary，画布不能被锁死 ----------
  await section("5. 拍板", async () => {
for (const s of [0, 1, 2, 3]) {
  await go("confirm", s);
  const n = await page.locator("#chrome button.bg-emerald-600").count();
  /* 「最多一个」在 n===0 时恒真。配一条同屏的阳性对照：这几屏本来就该
     各有一个 primary，0 个说明选择器或类名已经漂了（brief §7-6）。 */
  check(n === 1, `confirm#${s} 应恰好有一个 primary 按钮（规范：一屏最多一个），实际 ${n} 个`);
  const blocked = await page.locator("#chrome button.bg-emerald-600").first()
    .evaluate((el) => { const b = el.getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return t !== el && !el.contains(t); });
  check(!blocked, `confirm#${s} 按钮被热点层挡住了，这一屏正需要操作`);
}
  });

  // ---------- 6. 继续切碎：表格按行切，且能单独放满屏 ----------
  await section("6. 表格切碎", async () => {
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
  });

  // ---------- 7. 重跑：确认框必须真出现，数字是算出来的 ----------
  await section("7. 重跑", async () => {
/* 先去别的路径把 r1 挪走，再回来数——「你摆过几块」不能随切路径而变 */
await go("arrange", 1);
await go("rerun", 1);
check(await page.locator("[role=dialog]").isVisible(), "rerun#1 必须弹强确认框");
const body = (await page.locator("[role=dialog]").innerText()).replace(/\s+/g, " ").trim();
check(/2\s*块区域/.test(body), `确认框应数出 2 块被移动的区域（上一屏挪过 r1 也不该多算），实际：${body}`);
check(body.includes("覆盖") && !/确定吗/.test(body), "确认框要说清会丢什么，不做无脑确认");
/* 承诺过「可以回滚」比什么都不说更糟：操作者会为了保险先点一次试试，
   于是这个保底承诺本身把不可撤销变成了常态（ADR-0011） */
check(!/回滚/.test(body), `确认框还在承诺回滚：${body}`);
check(/不能撤销/.test(body), `确认框必须明说这一步不能撤销：${body}`);
/* 作用域是这一份资源：报整块画布的数，是在吓唬操作者（ADR-0012） */
check(/别的资源不动/.test(body), `确认框必须说清只覆盖这一份：${body}`);
check(!/整份编排/.test(body), `确认框还在说「整份编排」，那是画布级的说法：${body}`);
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
await page.locator('#chrome [aria-label="重跑这一份的解析"]').click();
await page.waitForTimeout(150);
const clean = (await page.locator("[role=dialog]").innerText()).replace(/\s+/g, " ").trim();
check(/还没有任何编排/.test(clean), `没摆过东西时确认框应说清楚，实际：${clean}`);
check(/不能撤销/.test(clean), `没摆过东西时也必须说清不能撤销，实际：${clean}`);
note(`碎开后直接点重跑 = ${clean.slice(0, 40)}…`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check(!(await page.locator("[role=dialog]").isVisible()), "Esc 应能关掉确认框");
  });

  // ---------- 8. 投屏：零操作痕迹，进出不改布局 ----------
  await section("8. 投屏", async () => {
await go("cast", 0);
check((await page.locator(".src-badge").count()) === 6, "cast#0 应有 6 个来源角标");
check(await page.locator("#hint").isVisible(), "cast#0 应有提示条");
/* 阳性对照：`.unit-tag` 与 `[data-id].ring-2` 这两条「必须消失」是类名
   耦合的（invariant 25），类名一改就恒为 0、恒通过。所以先在**同一屏的
   操作态**上确认它们确实存在——cast#0 的 board 明确 selected:"r1" 且
   groups:true，这两条断言才有被检验的资格（brief §7-6）。 */
check((await page.locator(".unit-tag").count()) > 0, "对照失效：cast#0 连一个分组标都没有，「分组标必须消失」无从谈起");
check((await page.locator("[data-id].ring-2").count()) > 0, "对照失效：cast#0 没有选中框，「选中框必须消失」无从谈起");

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

/* Esc 退投屏。这条以前是 goto 一返回就零延迟按的，赌键盘监听器已经挂上；
   现在 go() 里那一句 settled() 就是这个赌的替代品。 */
await go("cast", 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check((await page.locator(".src-badge").count()) === 6, "Esc 应能退出投屏并恢复操作态");
  });

  // ---------- 9. 控件顺序：重跑必须离手最远 ----------
  await section("9. 工具条", async () => {
await go("arrange", 2);
const labels = await page.locator("#chrome button").evaluateAll((els) =>
  els.map((e) => e.getAttribute("aria-label") ?? e.textContent.trim()));
check(labels.length >= 3, `arrange#2 底部控件太少：${JSON.stringify(labels)}`);
check(labels.at(-1) === "重跑这一份的解析", `重跑必须排在最右，实际：${JSON.stringify(labels)}`);
/* 产品没有回滚，所以工具条上不能有撤销——那个按钮从来没实现过，
   只弹一句演示提示，留着比没有更糟（ADR-0011） */
check(!labels.includes("撤销"), `工具条上不该有撤销：${JSON.stringify(labels)}`);
note(`arrange#2 底部 ${labels.length} 个控件 = ${labels.join(" · ")}`);

/* 间距量的是**渲染出来的位置**，不是类名。早先外层 gap-x-2 写在只有
   一个子元素的容器上，看着有间距，实际是 0，整条工具条靠 2px 撑着。 */
const bar = await page.locator("#chrome button, #chrome label, #chrome p").evaluateAll((els) =>
  els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, h: r.height }; }));
/* gap/pitch 从 Infinity 起算，bar 只有 0 或 1 个元素时循环体一次都不进，
   两条断言就都恒真。先钉住「量到了至少两个控件」（brief §7-6）。 */
check(bar.length >= 2, `量间距至少要两个控件，实际只量到 ${bar.length} 个：${JSON.stringify(labels)}`);
let gap = Infinity, pitch = Infinity;
for (let i = 1; i < bar.length; i++) {
  gap = Math.min(gap, bar[i].x - bar[i - 1].right);
  pitch = Math.min(pitch, bar[i].x - bar[i - 1].x);
}
check(gap >= 12, `底部控件之间只有 ${gap}px 间距，挤成一团（要 ≥12）`);
const hs = [...new Set(bar.map((b) => b.h))];
check(hs.length === 1, `底部控件高度不齐：${hs.join(" / ")}px`);
check(hs[0] >= 28 && hs[0] <= 38, `按钮总高 ${hs[0]}px 超出应用型界面的 28–38px`);
/* 48px 命中区是往上往下各探出 6px 的：相邻中心距不足 48，两颗按钮的
   命中区就互相压，触控上会出现「这一格归左边那颗」的盲区 */
check(pitch >= 48, `相邻控件中心距只有 ${pitch}px，48px 触控命中区会互相压`);
/* 分隔线只留一道，且在「投屏」之前。它曾经是两道硬编码的——多出来那道
   在窄工具条里显得吵，而破坏性已经被 primary 填充和红图标标过两遍。 */
const seps = await page.locator("#chrome span.w-px").count();
check(seps === 1, `底部应有且只有一道分隔线，实际 ${seps} 道`);
const sepBefore = await page.locator("#chrome > div > *").evaluateAll((els) => {
  const i = els.findIndex((e) => e.matches("span.w-px"));
  return i >= 0 ? els[i + 1]?.textContent?.trim() : null;
});
check(sepBefore === "投屏", `分隔线应隔开编排控件和「投屏」，实际它前面是 ${sepBefore}`);
note(`底部控件：间距 ${gap}px、高 ${hs.join("/")}px、相邻中心距 ${pitch}px，分隔线 1 道`);
  });

  // ---------- 10. 拖动真的能改位置，而且相机不许跟着动 ----------
  await section("10. 拖动与相机", async () => {
await go("arrange", 0);
const before = (await boxes()).find((b) => b.id === "r6").y;
const box = await page.locator('[data-id="r6"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
const camAtGrab = await cam();
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 - 90, { steps: 8 });
check((await cam()) === camAtGrab, "相机在拖动过程中动了 —— 手感就是被这个毁掉的");
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

/* ---------- 10b. 层次：拿起就前移，松手不退回去 ----------
   渲染顺序 = board.regions 的顺序，所以 z 序是模型里的一个事实，
   不是拖动期间的一句 CSS。断言看 DOM 顺序，也就是实际压在谁上面。 */
const zOrder = () =>
  page.locator("[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id));
const dragBy = async (id, dx, dy) => {
  const b = await page.locator(`[data-id="${id}"]`).boundingBox();
  await page.mouse.move(b.x + 60, b.y + 40);
  await page.mouse.down();
  await page.mouse.move(b.x + 60 + dx, b.y + 40 + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
};

await go("arrange", 0);
const z0 = await zOrder();
check(z0.join(",") === "r1,r2,r3,r4,r5,r6", `对照：初始渲染顺序应为 r1..r6，实际 ${z0.join(",")}`);
await dragBy("r3", 140, 300);
const z1 = await zOrder();
check(z1.at(-1) === "r3", `拿起的 r3 没有前移，松手后顺序 = ${z1.join(",")}`);
check(z1.length === 6 && new Set(z1).size === 6, `前移把块弄丢了：${z1.join(",")}`);

/* 松手之后再碰别的地方，不许把它压回底层 */
const vpZ = await page.locator("#app").boundingBox();
await page.mouse.click(vpZ.x + 20, vpZ.y + vpZ.height - 20);
await page.waitForTimeout(120);
const z2 = await zOrder();
check(z2.at(-1) === "r3", `点过空白处后层次被压回去了：${z2.join(",")}`);

/* 整组一起前移，组内相对顺序不变（r1、r2 同属 u1） */
await go("arrange", 0);
await dragBy("r2", 180, 240);
const z3 = await zOrder();
check(z3.slice(-2).join(",") === "r1,r2",
  `整组应一起前移且保持组内顺序，实际尾部 = ${z3.slice(-2).join(",")}（全序 ${z3.join(",")}）`);
note(`拿起 r3 → 前移到顶层并保持；整组 r1+r2 一起前移，组内顺序不变`);

/* 层次变了，位置不该跟着变——两件事互不相干 */
await go("arrange", 0);
const posBefore = new Map((await boxes()).map((b) => [b.id, `${b.x},${b.y}`]));
await dragBy("r3", 0, 260);
const nudged = (await boxes()).filter((b) => posBefore.get(b.id) !== `${b.x},${b.y}`).map((b) => b.id);
check(nudged.join(",") === "r3", `前移只该动层次，实际被挪动的是 ${nudged.join(",") || "（无）"}`);
await page.screenshot({ path: join(shots, "arrange-raised.png") });
  });

  // ---------- 截图 ----------
  await section("截图", async () => {
for (const [p, s] of [["drop", 0], ["drop", 1], ["reject", 1], ["scatter", 0], ["scatter", 1],
                      ["confirm", 1], ["confirm", 2], ["splitcut", 1], ["group", 0],
                      ["arrange", 2], ["reread", 1], ["reread", 2], ["rerun", 1],
                      ["cast", 0], ["cast", 1], ["nav", 0], ["nav", 1]]) {
  await go(p, s);
  await page.screenshot({ path: join(shots, `${p}-${s}.png`) });
}
  });

await page.close();
}   /* ← VIEWPORTS 循环到此为止 */

// ---------- 运行时错误：全脚本末尾，只查这一次 ----------
/* 原来这一条在 32 屏横扫之后就查了。此后还有 90 多次导航、几十次投放、
   一整段拖动与投屏进出——那之后的每一个 pageerror 都被监控之外地漏掉。
   挪到这里，它的覆盖面才是「整场」。第 0 段已经证明收集器不是摆设，
   所以这次的 0 是真的 0，不是没人监听。 */
if (runtimeErrors.length) {
  fails.push(`全场 ${runtimeErrors.length} 条运行时错误：\n    `
    + runtimeErrors.slice(0, 20).join("\n    "));
} else {
  note(`全场零运行时错误（pageerror / 网络失败 / HTTP≥400；${navCount} 次导航，${VIEWPORTS.length} 个视口）`);
}

} catch (e) {
  fatal = e;
} finally {
  try { await browser?.close(); } catch { /* 已经关了就算了 */ }
  stop();
  report(fatal);
}
