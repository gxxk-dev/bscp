// ===========================================================================
// 真链路 e2e：真浏览器 → 真 FastAPI → 真文件字节。
// ===========================================================================
// 用法：cd prototype && bun run build && node tools/e2e.mjs
// 脚本自己起 uvicorn（--workers 1，BSCP_TEST_HOOKS=1），不需要先手动开服务。
//
// 与 `smoke.mjs` 的分工：那份守**评审脚手架**（12 条行为路径 × 两视口），
// 这份守**产品链路**。两者都必须绿，但它们打的是不同东西——demo 全绿推不
// 出产品投得出去，反之亦然。
//
// ---------------------------------------------------------------------------
// ## 三条让这份东西不退化成空过的规矩
//
// 1. **一个场景只 `page.goto` 一次。** goto 是整页刷新：一个有状态的服务端
//    上，64 次 goto 就是 64 个会话，而「投完文件再导航」的那几个用例画布
//    直接空掉——红起来时症状是「投放不生效」，跟真实故障长得一模一样。
//    这条不是靠自觉：`screen()` 会把 `page.goto` 封掉，第二次调用直接抛。
//
// 2. **每条「必须不存在 / 必须为零」配一条「大于零」的阳性对照。**
//    没有对照的零断言在类名改掉之后会一路空过，而且**绿得很有说服力**。
//    对照失效要报错，不能跳过——否则后面那些零断言全成了空话。
//
// 3. **凡 `Math.min` / `every` / `some` 驱动的断言，先断言被测集合非空。**
//    空数组上 `Math.min` 是 `Infinity`、`every` 恒真、`some` 恒假，三者
//    都不是「没发现问题」，而是「没看」。
//
// 另外：**不许 sleep。** 条件一律走 `waitForFunction` / `[data-ingest-state]`。
// 投放是异步的，「落定了没有」必须有一个能等的东西——而等中文文案
// 「投放中…」消失是脆的：410 那条路只存在几毫秒，轮询很容易整个错过它。

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const serverRoot = join(root, "..", "server");
const SHOTS = join(root, ".build", "e2e-shots");
const FIX = join(root, ".build", "e2e-fixtures");
const PORT = Number(process.env.BSCP_E2E_PORT ?? 8931);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** 产品路径只在 1440×900 验过；demo 那边才有双视口覆盖。 */
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(FIX, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- 结果收集

/* 每一段自己 try/catch 记一条，其余段照跑。整段 throw 会把后面所有断言
   一起吞掉，而冒烟最有价值的产出恰恰是「哪些过了、哪些没过」。 */
const fails = [];
const notes = [];
const check = (ok, what) => { if (!ok) fails.push(what); };
const note = (s) => notes.push(s);
const section = async (name, body) => {
  try { await body(); } catch (e) { fails.push(`${name} 整段抛异常：${e?.message ?? e}`); }
};

/** 规矩 3：被测集合非空。返回它，空的就记一条。 */
function nonEmpty(xs, what) {
  check(xs.length > 0, `${what}：被测集合是空的——「每一条都怎样」在空数组上恒真，这一段等于没看`);
  return xs;
}

// ---------------------------------------------------------------- 操作痕迹

/* 投屏态的「零操作痕迹」不是三四个 if，是**一张清单**。AC 点名了五个：
   提示条、底部控件、角标、分组标、选中框。清单只列 AC 点的那些——
   再往里塞「拖起来的阴影」之类，就会出现一条没有任何产品依据的断言，
   而它红的时候没人说得清该改哪边。 */
const TRACES = [
  { name: "提示条", sel: "#hint" },
  { name: "底部控件", sel: "#chrome" },
  { name: "来源角标", sel: ".src-badge" },
  { name: "分组标", sel: ".unit-tag" },
  { name: "选中框", sel: "[data-id].ring-2" },
];

const countAll = (page) => page.evaluate((sels) => {
  const out = {};
  for (const s of sels) out[s] = document.querySelectorAll(s).length;
  return out;
}, TRACES.map((t) => t.sel));

const fmtCounts = (c) => TRACES.map((t) => `${t.name} ${c[t.sel]}`).join("、");

// ---------------------------------------------------------------- 读画布

/* 相机比的是 matrix(a,b,c,d,e,f) 的六个**数值**，不是浏览器吐回来的原文：
   谁把 translate 换成 translate3d，字符串比较就恒失败，而现象看着完全
   不像「有人改了 transform 的写法」。 */
const view = (page) => page.locator("#stage").evaluate((el) => {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { x: 0, y: 0, k: 1 };
  const n = t.slice(t.indexOf("(") + 1, -1).split(",").map(Number);
  const six = n.length === 16 ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n.slice(0, 6);
  return { x: six[4], y: six[5], k: six[0] };
});

/* 一块在**画布坐标**下的位置与尺寸。读 style 而不是 getBoundingClientRect：
   后者带着 #stage 的 transform，缩放后就不是画布坐标了。 */
const boxes = (page) => page.locator("[data-id]").evaluateAll((els) =>
  els.map((e) => ({
    id: e.dataset.id,
    x: parseFloat(e.style.left), y: parseFloat(e.style.top),
    w: parseFloat(e.style.width), h: parseFloat(e.style.height),
  })));

/** 画布坐标 → 屏幕坐标。`camera.toCanvas` 的逆运算。
    有了它，「内容出现在松手光标处（±4px 内）」才能在 **k ≠ 1** 下断言——
    拿画布坐标直接跟 clientX 比，只在单位变换下成立。 */
const toScreen = (b, v, r) => ({ x: r.x + v.x + b.x * v.k, y: r.y + v.y + b.y * v.k });

/* 画布上**真的画出了位图**吗。

   曾经 13 段断言全部建立在 `boxes()`（读 `style.left/top/width/height`）上，
   而 `[data-id] img` 一次都没量过：把 `RegionImage` 改成什么都不渲染，
   盒子还在、四个值一字不变、`#stage` 不变，于是整份 e2e 全绿，而屏上只有
   几个空框——而这张票的全部内容就是「投得进、投得出」。服务端侧同理：
   `fetchRegionBitmap` 只判 `res.ok`，区域端点回 200 + 非图片字节时
   prefetch 照样 fulfilled。

   所以每次投放落定后都要过这一道：`complete && naturalWidth > 0`。
   它同时盖住三种故障——Canvas 忘了挂 RegionImage、prefetch 拿到坏字节、
   blob 被提前 revoke。 */
const painted = (page) => page.locator("[data-id] img").evaluateAll((els) =>
  els.map((e) => ({ w: e.naturalWidth, h: e.naturalHeight, complete: e.complete })));

/** 落定之后：画布上有几块，就该有几张**真的解码出来了**的图。 */
async function assertPainted(page, expected, where) {
  const shots = await painted(page);
  check(
    shots.length === expected,
    `${where}：画布上有 ${expected} 块，但只量到 ${shots.length} 张位图`,
  );
  check(
    shots.length > 0,
    `${where}：一张位图都没量到——「每张都解码成功」在空数组上恒真（规矩 3）`,
  );
  const broken = shots.filter((s) => !s.complete || !(s.w > 0));
  check(
    broken.length === 0,
    `${where}：${broken.length} 块的位图没解码出来（naturalWidth=${broken.map((b) => b.w)}）`,
  );
}

const appRect = (page) => page.locator("#app").boundingBox();
const bodyText = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
const chromeButtons = (page) => page.locator("#chrome button, #chrome label").allTextContents();
/** 整屏可见的 primary（实心 emerald 按钮）。一屏最多一个。 */
const primaries = (page) => page.locator("button.bg-emerald-600, label.bg-emerald-600").evaluateAll(
  (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).filter(Boolean));

// ---------------------------------------------------------------- 投放

/* 派到 #app 而不是 body：React 的事件树挂在 #root 里，事件往上冒不会往下
   钻进那棵树。派给 body 的话处理器根本不会被调用。 */
const dropDT = (page, dt, at) =>
  page.dispatchEvent("#app", "drop", { dataTransfer: dt, clientX: at.x, clientY: at.y });

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

const F = (name, mime, path) => ({ name, mime, path });

/* 本地闸门全拒时压根没有往返，这一屏**不会**经过 ingesting。
   所以「有没有收到响应」也是落定的一部分：先记下当前请求数，等它涨，
   再等 `data-ingest-state` 离开 ingesting 且位图归零。 */
async function dropAndSettle(page, at, action) {
  const posted = page.waitForResponse(
    (r) => r.url().includes("/api/") && r.request().method() === "POST",
    { timeout: 8000 },
  ).catch(() => null);
  await action();
  const res = await posted;
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#app");
      return el?.dataset.ingestState !== "ingesting" && el?.dataset.bitmapsPending === "0";
    },
    null, { timeout: 10000 },
  );
  return res;
}

const dropOne = (page, path, mime, name, at) =>
  dropAndSettle(page, at, () => dropFiles(page, [F(name, mime, path)], at));

// ---------------------------------------------------------------- 相机操作

/* 缩放到 k ≠ 1。用滚轮（鼠标那一条路）而不是直接改 store：改 store 就是
   在测一个操作者碰不到的状态。 */
async function zoomOut(page, deltaY) {
  const r = await appRect(page);
  const before = await view(page);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(0, deltaY);
  await page.waitForFunction(
    (k0) => {
      const el = document.querySelector("#stage");
      if (!el) return false;
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return false;
      const n = t.slice(t.indexOf("(") + 1, -1).split(",").map(Number);
      return Math.abs(n[0] - k0) > 1e-6;
    },
    before.k, { timeout: 4000 },
  );
  return view(page);
}

const castOn = async (page) => {
  await page.locator("#chrome button", { hasText: "投屏" }).click();
  await page.waitForFunction(() => !document.querySelector("#chrome"), null, { timeout: 4000 });
};
const castOff = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !!document.querySelector("#chrome"), null, { timeout: 4000 });
};

// ---------------------------------------------------------------- 起服务

/* --workers 1 是硬约束：会话在进程内存里（ADR-0014），多 worker 的故障表现
   是「健康检查正常、静态资源正常、随机 410」。BSCP_TEST_HOOKS=1 才有
   /api/_test/*，关掉时那些路由根本不注册。 */
const server = spawn("uv", [
  "run", "uvicorn", "--factory", "bscp.api:create_app",
  "--port", String(PORT), "--workers", "1", "--log-level", "warning",
], {
  cwd: serverRoot,
  stdio: "ignore",
  env: {
    ...process.env,
    BSCP_STATIC_DIR: join(root, "dist"),
    BSCP_TEST_HOOKS: "1",
    BSCP_WORKERS: "1",
  },
});
const stop = () => server.kill();
process.on("exit", stop);

/** 服务端起来了吗、是不是**我们**起的那一个。

    曾经这里只要 `/api/healthz` 返 200 就走人，于是三种情况全都测错了代码：
    上一轮崩溃残留在同一端口上的旧 uvicorn（它 serve 的是上一版 dist）、
    别人手开的 dev server、以及 `BSCP_E2E_PORT` 指过去的现成服务。
    症状是**全绿**——13 段全跑在旧构建上，报告照常打「✓ 全部通过」，
    而 `src/` 里刚改的东西一行都没被测到。

    所以这里钉两件事：
    - 端口**先占后起**。已经有人在听就直接失败，而不是让它 5 秒后 EADDRINUSE 退出、
      再由 `waitForServer` 打到那个旧进程上。
    - 起来之后断言 `/api/_test/diagnostics` 的 `testHooks === true`。真服务端
      必然开钩子；静态站与旧进程未必。 */
let serverReady = false;
server.on("exit", (code, signal) => {
  if (serverReady) return;
  fails.push(
    `uvicorn 起了又死（exit=${code} signal=${signal}）——端口 ${PORT} 上可能已经有别的服务` +
    `（旧 dist 的残留进程、别人的 dev server）。这轮结果不可信。`,
  );
});

async function portIsFree() {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const probe = net.connect({ port: PORT, host: "127.0.0.1" });
    probe.once("connect", () => { probe.destroy(); resolve(false); });
    probe.once("error", () => resolve(true));
  });
}

async function waitForServer() {
  if (!(await portIsFree())) {
    throw new Error(
      `端口 ${PORT} 已经被占用了。先杀掉那个进程再跑 e2e —— ` +
      `否则脚本会把它当成这次的服务端，13 段全绿却一行新代码都没测到。`,
    );
  }
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/healthz`, { signal: AbortSignal.timeout(1000) });
      if (!r.ok) throw new Error("还没好");
      /* 确认是**带钩子**的那个进程，而不只是「某个进程在监听」。 */
      const d = await fetch(`${ORIGIN}/api/_test/diagnostics`, { signal: AbortSignal.timeout(2000) });
      if (!d.ok) throw new Error("healthz 有响应但 /api/_test/diagnostics 没有——这不是本脚本起的那个服务端");
      const diag = await d.json();
      if (diag.testHooks !== true) throw new Error("服务端的测试钩子没开");
      serverReady = true;
      return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("uvicorn 没起来");
}

/** `dist/` 是不是比 `src/` 新。旧了就当场说「先 build」——
    脚本自己不会 build，而它打的就是构建产物。 */
async function assertDistIsFresh() {
  const { statSync, readdirSync } = await import("node:fs");
  const distIndex = join(root, "dist", "index.html");
  let newestSrc = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else newestSrc = Math.max(newestSrc, statSync(p).mtimeMs);
    }
  };
  walk(join(root, "src"));
  let builtAt;
  try {
    builtAt = statSync(distIndex).mtimeMs;
  } catch {
    throw new Error("dist/index.html 不存在——先跑 `bun run build`");
  }
  if (builtAt < newestSrc) {
    throw new Error(
      "dist/ 比 src/ 旧——e2e 测的是构建产物。先跑 `bun run build` 再跑这份脚本，" +
      "否则它会全绿而一行新代码都没测到。",
    );
  }
}

// ---------------------------------------------------------------- 屏

/* 一个「屏」= 一个全新的 context + page + **一次** goto。
   隔离靠新 context，不靠刷新：刷新是有状态服务端上的第二份代价。 */
let screenNo = 0;
async function screen(q = "") {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  const rec = { no: ++screenNo, api: [], bad: [], errors: [] };

  /* 规矩 1 的执行处：把 goto 封掉，第二次调用直接抛。 */
  const realGoto = page.goto.bind(page);
  let gotos = 0;
  page.goto = (...args) => {
    if (++gotos > 1) throw new Error("一个场景只允许一次 page.goto（规矩 1）");
    return realGoto(...args);
  };

  page.on("pageerror", (e) => rec.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") rec.errors.push(`console: ${m.text()}`); });
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    if (why.includes("ERR_ABORTED")) return;
    rec.errors.push(`网络失败: ${why} ${r.url()}`);
  });
  page.on("request", (r) => { if (r.url().includes("/api/")) rec.api.push(r.url()); });
  /* 4xx/5xx 连同 content-type 一起记：「会话没了」那一条要验的就是
     状态码是 410 **且** content-type 是 application/json。 */
  page.on("response", (r) => {
    if (r.status() >= 400) {
      rec.bad.push({ status: r.status(), url: r.url(), ct: r.headers()["content-type"] ?? "" });
    }
  });

  await page.goto(`${ORIGIN}/${q}`, { waitUntil: "load" });
  /* #stage 出现 = React 已挂上。不用 sleep 赌首屏时序。 */
  await page.waitForFunction(() => !!document.querySelector("#stage"), null, { timeout: 8000 });
  rec.close = () => ctx.close();
  rec.q = q;
  return { page, rec };
}

const noErrors = (rec, what) =>
  check(rec.errors.length === 0, `${what}：${rec.errors.length} 条运行时错误：${rec.errors.slice(0, 4).join(" | ")}`);

/* ---------- 浏览器句柄放在 try 外面 ----------
   finally 与 try 是兄弟块，看不见写在 try 里的 let。写成 try 内部时，
   finally 那行拿到未声明标识符、抛 ReferenceError，而外面套着的空 catch
   会把它静默吞掉——结果照常打印，浏览器从头到尾没被关过，进程永不退出。 */
let browser;

try {
  /* 先确认 `dist/` 是新的：这份脚本打的是**构建产物**，而它自己不 build。
     dist 旧了它照样全绿——测的是上一版，一行新代码都没碰到。 */
  await assertDistIsFresh();
  await waitForServer();
  browser = await chromium.launch();

  const { paths, report } = await buildFixtures(browser, FIX);
  note(report);

  const PNG = "image/png";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  /** 视口内的一个点。#app 是 fixed inset-0，所以 r.x / r.y 恒为 0，
      但仍然从 boundingBox 取——写死 0 的话哪天加了外边距就全错位了。 */
  const atIn = async (page, dx, dy) => {
    const r = await appRect(page);
    return { x: r.x + dx, y: r.y + dy };
  };

  // =====================================================================
  // A. 围栏：产品路径下评审脚手架根本不存在
  // =====================================================================
  await section("A. 围栏", async () => {
    /* 阳性对照先行：同一个 build，带 ?path= 时那些东西**确实存在**。
       没有这一条，下面每一条「必须不存在」都会在类名改掉之后 fail-open，
       而且绿得很有说服力。 */
    const demo = await screen("?path=drop&step=0");
    const hasProto = await demo.page.locator("text=PROTOTYPE").count();
    const hasTop = await demo.page.locator("header").count();
    check(hasProto > 0, "对照失效：带 ?path= 时连 PROTOTYPE 红标都没有，「产品路径下不该有它」无从谈起");
    check(hasTop > 0, "对照失效：带 ?path= 时连顶部导航都没有，「产品路径下不该有它」无从谈起");
    await demo.rec.close();

    const { page, rec } = await screen();
    const noProto = await page.locator("text=PROTOTYPE").count();
    const noTop = await page.locator("header").count();
    const noHint = await page.locator("#hint").count();
    check(noProto === 0, `产品路径下出现了 PROTOTYPE 红标（${noProto} 处）`);
    check(noTop === 0, `产品路径下出现了顶部导航（${noTop} 处）`);
    check(noHint === 0, `产品路径下出现了提示条（${noHint} 处）`);
    /* 也不能有撤销（ADR-0011）与语义单元（#8 才有）。 */
    const acts = await chromeButtons(page);
    check(!acts.some((a) => /撤销/.test(a)), `产品路径下出现了「撤销」：${JSON.stringify(acts)}`);
    check((await page.locator(".unit-tag").count()) === 0, "产品路径下出现了分组标");
    noErrors(rec, "A 围栏");
    await rec.close();
    note(`围栏：对照 ?path= 下 PROTOTYPE ${hasProto}/header ${hasTop}；` +
      `产品路径下 0/0/0、撤销 0、分组标 0，工具条 = ${JSON.stringify(acts)}`);
  });

  // =====================================================================
  // B. 操作痕迹清单的阳性对照（同一份 build）
  // =====================================================================
  /* 规矩 2 的校准段。`TRACES` 里那五个选择器，必须先在一个**真的同时摆着
     它们全部**的屏上逐个 > 0，否则后面「投屏态全为 0」是空过。

     为什么阳性对照取自 demo 而不是产品路径：产品路径**结构上**不可能出现
     `#hint`（评审脚手架才有提示条）与 `.unit-tag`（#4 的 `unit` 恒为 null，
     分组是 #8 的活）。要在产品屏上凑齐这两个，就等于先造出一个产品里
     不存在的状态。折中办法是让对照来自同一个 build 的另一条路径，并在
     报告里写明每一条的对照来自哪一屏——这样「选择器死了」仍然会让整段红。 */
  await section("B. 痕迹清单的阳性对照", async () => {
    const demo = await screen("?path=cast&step=0"); // 操作态：groups + badges + selected
    const counts = await countAll(demo.page);
    for (const t of TRACES) {
      check(counts[t.sel] > 0,
        `对照失效：「${t.name}」(${t.sel}) 在操作态一处都没命中——选择器已死，` +
        "后面「投屏态必须为零」会一路空过");
    }
    const sels = (await primaries(demo.page));
    check(sels.length <= 1, `对照屏上出现了 ${sels.length} 个 primary：${JSON.stringify(sels)}`);
    await demo.rec.close();
    note(`痕迹清单对照（?path=cast&step=0）：${fmtCounts(counts)}；primary ${JSON.stringify(sels)}`);
  });

  // =====================================================================
  // C. 锚点：k = 1 与 k ≠ 1 各验一遍
  // =====================================================================
  /* 「内容出现在松手光标处（±4px 内）」是**屏幕**坐标上的话。早先的 e2e
     拿画布坐标直接跟 clientX 比——那只在相机恰好是单位变换时成立。而
     空画布上取景会提前 return，恰好把相机钉在 {0,0,1}：所以那条断言
     一直绿，却从来没有在真正缩放过的画布上验过。这里两档都跑。 */
  await section("C. 锚点", async () => {
    const anchorCheck = async (label, screenRef) => {
      const { page, rec } = screenRef;
      const r = await appRect(page);
      const v = await view(page);
      const vBefore = v;
      const target = { x: r.x + 700, y: r.y + 400 };
      await dropOne(page, paths.exam, PNG, "月考卷.png", target);

      const bs = nonEmpty(await boxes(page), `${label} 锚点：画布上应当有 1 块`);
      await assertPainted(page, bs.length, `C 锚点 ${label}`);
      const got = toScreen(bs[0], v, r);
      check(Math.abs(got.x - target.x) < 4 && Math.abs(got.y - target.y) < 4,
        `${label}：没锚在松手光标上。期望 (${target.x}, ${target.y})，实际 (${got.x.toFixed(2)}, ${got.y.toFixed(2)})`);
      /* 相机只归操作者：投放不动它。 */
      const vAfter = await view(page);
      check(Math.abs(vAfter.k - vBefore.k) < 1e-9 && vAfter.x === vBefore.x && vAfter.y === vBefore.y,
        `${label}：投放后相机动了 ${JSON.stringify(vBefore)} → ${JSON.stringify(vAfter)}（相机只归操作者）`);
      /* 角标带文件名：多份时角标是「这一块来自哪份」的唯一出口。 */
      const badges = await page.locator(".src-badge").allTextContents();
      check(badges.length === 1 && badges[0].includes("月考卷"),
        `${label}：来源角标应带文件名，实际 ${JSON.stringify(badges)}`);
      noErrors(rec, `C 锚点 ${label}`);
      await rec.close();
      return { bs, v, badges };
    };

    const flat = await screen();
    const a = await anchorCheck("k=1", flat);
    const flatRect = { x: 0, y: 0 };
    note(`锚点 k=1：光标 (700,400) → 内容屏上 (${toScreen(a.bs[0], a.v, flatRect).x.toFixed(2)},` +
      `${toScreen(a.bs[0], a.v, flatRect).y.toFixed(2)})，相机不动，角标 ${JSON.stringify(a.badges)}`);

    const zoomed = await screen();
    const v = await zoomOut(zoomed.page, 600);
    /* 阳性对照：确认真的缩放了。k 仍等于 1 的话下面整套锚点断言全部无意义。 */
    check(Math.abs(v.k - 1) > 1e-3, `对照失效：缩放没生效，k 仍是 ${v.k}——下面的锚点断言只在单位变换下成立`);
    check(Math.abs(v.k - 0.4066) < 0.01, `缩放倍率与预期不符：k=${v.k}（滚轮 -600 应给 ≈0.407）`);
    const b = await anchorCheck(`k=${v.k.toFixed(3)}`, zoomed);
    note(`锚点 k=${v.k.toFixed(3)}：相机 (${v.x.toFixed(1)}, ${v.y.toFixed(1)})@${v.k.toFixed(3)}，` +
      `内容仍落在松手光标 ±4px 内`);
  });

  // =====================================================================
  // D. 默认大小：按视野份额等比收，小图不放大
  // =====================================================================
  await section("D. 默认大小", async () => {
    const { page, rec } = await screen();
    const r = await appRect(page);
    const p = await atIn(page, 80, 80);
    await dropOne(page, paths.photo, PNG, "板书实拍.png", p);
    const bs = nonEmpty(await boxes(page), "D 大图：应当有 1 块");
    await assertPainted(page, bs.length, "D 大图");
    const b = bs[0];
    /* **定值**，不是上界。曾经这里只有 `b.w <= r.width * 0.42`，于是把
       `SHARE.w` 改成 0.20 一样全绿——3000×2000 收成 288×192，落屏宽 288
       远小于 605.8，等比、出界、步长全过。操作者投一份 A4 扫描件得到一张
       邮票，没有一条断言会响。 */
    check(Math.abs(b.w - 605) <= 1 && Math.abs(b.h - 403) <= 1,
      `视野份额收错了：3000×2000 在 ${r.width}×${r.height} 下应当收成 605×403` +
      `（宽 42% / 高 60% 取小的那个），实际 ${b.w}×${b.h}`);
    check(b.w <= r.width * 0.42 + 1,
      `3000px 的实拍照按原尺寸摆出来了：占 ${b.w}px 宽（视野份额上限 ${(r.width * 0.42).toFixed(0)}px）`);
    check(Math.abs(b.w / b.h - 3000 / 2000) < 0.01,
      `等比收被破坏了：${b.w}×${b.h} 与 3000×2000 的比例对不上`);
    check(b.x + b.w <= r.x + r.width + 2 && b.y + b.h <= r.y + r.height + 2,
      `大图没收进视野：右边出界 ${(b.x + b.w - r.x - r.width).toFixed(1)}px、下边出界 ${(b.y + b.h - r.y - r.height).toFixed(1)}px`);

    /* **竖向**素材：高 60% 那一半只有在「高是紧的那个约束」时才被执行到。
       8 份 fixture 全是横向或正方（3000×2000 / 1200×800 / 640×480 /
       500×400 / 100×100 / 1×1），所以把 `SHARE.h` 改成 0.05 一样全绿——
       一次都没被算过。 */
    const t = await screen();
    await dropOne(t.page, paths.tall, PNG, "竖版讲义.png", await atIn(t.page, 80, 80));
    const tb2 = nonEmpty(await boxes(t.page), "D 竖图：应当有 1 块");
    await assertPainted(t.page, tb2.length, "D 竖图");
    check(Math.abs(tb2[0].h - r.height * 0.6) <= 1,
      `竖向素材没有被高的那份份额收住：实际高 ${tb2[0].h}px，应当是视野高的 60% = ${(r.height * 0.6).toFixed(0)}px`);
    check(Math.abs(tb2[0].w / tb2[0].h - 800 / 3000) < 0.01,
      `竖图等比被破坏了：${tb2[0].w}×${tb2[0].h} 与 800×3000 的比例对不上`);
    await t.rec.close();
    await rec.close();

    /* 小图**不放大**。1×1 的图上屏就该是 1×1——fitInto 的 k 恒 min(1, …)，
       而这一条在原型里是纯断言：插值出来的字是糊的，插值出来的图同理。 */
    const s2 = await screen();
    await dropOne(s2.page, paths.tiny, PNG, "像素.png", await atIn(s2.page, 400, 300));
    const tb = nonEmpty(await boxes(s2.page), "D 小图：应当有 1 块");
    check(tb[0].w === 1 && tb[0].h === 1,
      `1×1 的图被放大了：屏上 ${tb[0].w}×${tb[0].h}，应当是 1×1（默认大小只收不放）`);
    noErrors(s2.rec, "D 默认大小");
    await s2.rec.close();
    note(`默认大小：3000×2000 → ${b.w}×${b.h}（视野 ${r.width}×${r.height} 的份额内，等比）；1×1 → ${tb[0].w}×${tb[0].h} 不放大`);
  });

  // =====================================================================
  // E. 边缘收拢：异尺寸多份，整叠右边界不超视野
  // =====================================================================
  /* 这是 geometry.ts 里 collapse() 那个行为修复的回归网。旧算法只看**最后
     一项**的右边缘，而异尺寸多份里最后那项往往最小：把
     [实拍照(收后 1487×991), 小图(100×100)] 丢到右缘，旧算法算出来的
     right 是 anchor + step + 100，收拢之后**第一份仍有几百 px 在屏外**。
     丢了一半资料在屏幕外，操作者会以为没投进来——而回执明明写着收下了。

     阳性对照：同尺寸的三份。max 落在最后一项上，新旧算法给同一个结果，
     所以这一条**恒真**——它证明的是「真的在断言边界」，不是「碰巧过了」。 */
  const edgeCase = async (label, same, atScreenX) => {
    const { page, rec } = await screen();
    let v = await view(page);
    if (v.k === 1) v = await zoomOut(page, 600);
    const r = await appRect(page);
    const target = { x: r.x + atScreenX, y: r.y + 100 };
    const list = same
      ? [["同尺寸一.png", paths.same1], ["同尺寸二.png", paths.same2], ["同尺寸三.png", paths.same3]]
      : [["板书实拍.png", paths.photo], ["小图.png", paths.small]];
    await dropAndSettle(page, target, () => dropFiles(page, list.map(([n, p]) => F(n, PNG, p)), target));

    const bs = nonEmpty(await boxes(page), `${label}：画布上应当有 ${list.length} 块`);
    await assertPainted(page, bs.length, label);
    check(bs.length === list.length,
      `${label}：${list.length} 份都该收下，实际 ${bs.length} 块 —— 字节撞了会被 ADR-0015 去重，这段就废了`);
    /* 视野边界落在屏上就是 r.x / r.y+r.width。**先断言集合非空**再取
       最靠外的那一项（空数组上 Math.max 给 -Infinity，那是「没看」）。 */
    const rights = bs.map((b) => toScreen(b, v, r).x + b.w * v.k);
    const worst = Math.max(...rights);
    check(worst <= r.x + r.width + 2,
      `${label}：整叠没收回来，最靠外的一块右缘在 ${worst.toFixed(1)}px，` +
      `视野右边在 ${(r.x + r.width).toFixed(1)}px（出界 ${(worst - r.x - r.width).toFixed(1)}px）`);
    const view2 = await view(page);
    check(Math.abs(view2.k - v.k) < 1e-9 && view2.x === v.x && view2.y === v.y,
      `${label}：收拢时相机动了 —— 收拢只动新内容`);
    noErrors(rec, label);
    await rec.close();
    return { n: bs.length, worst, span: r.width, k: v.k };
  };

  await section("E. 边缘收拢", async () => {
    /* 先补投的正对照：没投进去的用例，任何收拢断言都是空过。fixtures.mjs
       已经在构建时按 sha256 撞过一遍，这里再确认服务端真的认得出 N 份。 */
    const { page, rec } = await screen();
    const r = await appRect(page);
    const target = { x: r.x + 1400, y: r.y + 100 };
    await dropAndSettle(page, target, () => dropFiles(page, [
      F("板书实拍.png", PNG, paths.photo), F("小图.png", PNG, paths.small),
    ], target));
    const plain = nonEmpty(await boxes(page), "E k=1 异尺寸");
    await assertPainted(page, plain.length, "E k=1 异尺寸");
    const vv = await view(page);
    const rights0 = plain.map((b) => toScreen(b, vv, r).x + b.w * vv.k);
    const worst0 = Math.max(...rights0);
    const span = r.width;
    check(plain.length === 2, `E k=1：异尺寸两份都该收下，实际 ${plain.length} 块`);
    check(worst0 <= r.x + r.width + 2,
      `E k=1：整叠没收回来，最靠外的右缘 ${worst0.toFixed(1)}px 超出视野右边 ${(r.x + r.width).toFixed(1)}px`);
    await rec.close();

    const het = await edgeCase("E k≠1 异尺寸 [1487×991, 100×100]", false, 1400);
    const same = await edgeCase("E k≠1 同尺寸 [500×400]×3（阳性对照）", true, 1400);

    /* 「收拢**只动新内容**」这半句：先摆一份，**记下它的位置**，再往右缘
       投一份触发收拢，收拢后逐字段比那一分。

       曾经这一整类情形在 e2e 里一次都没出现：E 段三种情形全都从**空画布**
       起步（收拢发生时画布上除了这一批没有第二块），F 段的 3 份摊在 (140,120)
       算下来右缘 851 < 1440 根本不触发收拢，H 段走 alreadyPresent 不新摆。
       于是把 `regions: [...b.regions, ...regions]` 改成拿整块 board 一起过
       一遍 placeRegions/collapse（一个「顺手统一摆位」的改法）时 E/F/H/I 全绿
       ——而操作者会发现第二次投放在动他上个月摆好的东西。
       `smoke.mjs:418` 那条「补投不该抹掉已有的一批」只数了块数（=== 2），
       没比位置，同样抓不到。 */
    const keep = await screen();
    const page2 = keep.page;
    const rr = await appRect(page2);
    const first = await atIn(page2, 200, 120);
    await dropOne(page2, paths.exam, PNG, "月考卷.png", first);
    const before = nonEmpty(await boxes(page2), "E 只动新内容：先摆的那一份");
    const beforeId = before[0].id;

    const right = { x: rr.x + 1400, y: rr.y + 100 };
    await dropAndSettle(page2, right, () => dropFiles(page2, [
      F("板书实拍.png", PNG, paths.photo), F("小图.png", PNG, paths.small),
    ], right));

    const after = nonEmpty(await boxes(page2), "E 只动新内容：收拢之后");
    await assertPainted(page2, after.length, "E 只动新内容");
    const kept = after.find((b) => b.id === beforeId);
    /* 阳性对照：那一批**确实**是新的、且确实落在了光标附近——
       否则「位置没变」可能只是因为后面那批压根没投进来。 */
    check(after.length === 3,
      `E 只动新内容：先摆 1 份再补 2 份，画布上应当有 3 块，实际 ${after.length} 块`);
    check(kept !== undefined, `E 只动新内容：先摆的那一块（${beforeId}）不见了`);
    if (kept) {
      check(kept.x === before[0].x && kept.y === before[0].y
        && kept.w === before[0].w && kept.h === before[0].h,
        `E 只动新内容：收拢把已经摆好的那一块也挪了 —— ` +
        `(${before[0].x},${before[0].y},${before[0].w},${before[0].h}) → ` +
        `(${kept.x},${kept.y},${kept.w},${kept.h})`);
    }
    const newcomers = after.filter((b) => b.id !== beforeId);
    /* 阳性对照：补投的那一批**确实**落在了右缘（比先摆的那一份靠右得多）。
       没有它，「位置没变」可能只是因为后面那批压根没投进来。量「靠右」而
       不是「贴着光标」——收拢本来就要把它们从松手点往回拉，那正是被验的行为。 */
    const rightOfFirst = newcomers.filter((b) => b.x > before[0].x + 200);
    check(newcomers.length === 2,
      `对照失效：补投应当是 2 块，实际 ${newcomers.length} 块（字节撞了会被去重，这段就废了）`);
    check(rightOfFirst.length === newcomers.length,
      `对照失效：补投的那 ${newcomers.length} 块没有落在右缘（先摆的在 x=${before[0].x}），收拢可能压根没触发`);
    noErrors(keep.rec, "E 只动新内容");
    await keep.rec.close();
    note(`边缘收拢：k=1 异尺寸 ${plain.length} 块，最靠外右缘 ${worst0.toFixed(1)}px；` +
      `k=${het.k.toFixed(3)} 异尺寸 ${het.n} 块，最靠外右缘 ${het.worst.toFixed(1)}px；` +
      `同尺寸对照 ${same.n} 块，最靠外 ${same.worst.toFixed(1)}px。视野宽 ${span}px；` +
      `「只动新内容」：先摆 1 份再往右缘补 2 份，原来那一份位置一字未动`);
  });

  // =====================================================================
  // F. 摊开：等步长、封顶、都在视野里、相机不动
  // =====================================================================
  await section("F. 摊开", async () => {
    const { page, rec } = await screen();
    const r = await appRect(page);
    const vBefore = await view(page);
    const target = { x: r.x + 140, y: r.y + 120 };
    await dropAndSettle(page, target, () => dropFiles(page, [
      F("月考卷.png", PNG, paths.exam), F("讲义.png", PNG, paths.handout), F("小图.png", PNG, paths.small),
    ], target));
    const cas = nonEmpty(await boxes(page), "F 摊开：应当有 3 块").sort((a, b) => a.x - b.x);
    await assertPainted(page, cas.length, "F 摊开");
    check(cas.length === 3, `三份都该收下，实际 ${cas.length} 块`);
    if (cas.length === 3) {
      const sx = cas[1].x - cas[0].x, sy = cas[1].y - cas[0].y;
      check(sx > 0 && sy > 0, `第二份没排在第一份的右下角：dx=${sx} dy=${sy}`);
      check(cas[2].x - cas[1].x === sx && cas[2].y - cas[1].y === sy,
        `三份没排成等步长的对角线：${cas.map((b) => `${b.id}@${b.x},${b.y}`).join(" · ")}`);
      /* 步长由**第一项收拢后的**短边算，并封顶在 28–72px（ADR-0013/0017）。 */
      const want = Math.min(72, Math.max(28, Math.round(Math.min(cas[0].w, cas[0].h) * 0.14)));
      check(sx === want, `步长 ${sx}px 与「第一项短边 × 0.14 并封顶 28–72」算出来的 ${want}px 不符（ADR-0017）`);
      check(sx <= 72, `步长 ${sx}px 超过了 72px 的封顶（ADR-0013）`);
    }
    const vAfter = await view(page);
    check(vAfter.k === vBefore.k && vAfter.x === vBefore.x && vAfter.y === vBefore.y,
      "摊开时相机动了 —— 相机只归操作者");
    noErrors(rec, "F 摊开");
    await rec.close();
    note(`摊开：3 份等步长向右下，步长落在 ADR-0017 的窗口内，整叠在视野内，相机不动`);
  });

  // =====================================================================
  // G. 混着收与拒：回执逐个点名，附文件名与体积
  // =====================================================================
  await section("G. 混着收与拒", async () => {
    const { page, rec } = await screen();
    const target = await atIn(page, 140, 120);
    await dropAndSettle(page, target, () => dropFiles(page, [
      F("月考卷.png", PNG, paths.exam),
      F("作业.docx", DOCX, paths.docx),
      F("讲义.pdf", "application/pdf", paths.pdf),
      F("坏图.png", PNG, paths.broken),
    ], target));
    const t = await bodyText(page);
    const n = await page.locator("[data-id]").count();
    check(n === 1, `四份里只应收下 1 份（PNG），实际画布上 ${n} 块`);
    /* 每一份都要被点名，一个都不许静默丢掉。 */
    for (const name of ["月考卷.png", "作业.docx", "讲义.pdf", "坏图.png"]) {
      check(t.includes(name), `回执漏了 ${name}：${t.slice(0, 300)}`);
    }
    /* AC：附文件名与**体积**。原型的 ingestToast 只给合计，拒收项一个字都没有。 */
    check(/\d+(\.\d+)?\s*(KB|MB)/.test(t), `回执里没有任何体积：${t.slice(0, 300)}`);
    /* 同一份名字不许在**回执面板里**出现两遍（早期把名字拼进了 text 又在
       面板拼一遍，屏上就成了「月考卷.png 38 KB 月考卷.png（38 KB）」）。
       量的是面板不是整页：画布上的来源角标也写着文件名，拿整页 innerText
       去数必然数出两次，而那不是这条要治的病。 */
    const panel = (await page.locator("#receipt").innerText()).replace(/\s+/g, " ");
    const dup = ["月考卷.png", "作业.docx", "讲义.pdf", "坏图.png"].filter((f) => {
      const m = panel.match(new RegExp(f.replace(".", "\\."), "g"));
      return (m?.length ?? 0) > 1;
    });
    check(dup.length === 0, `回执面板里这几份名字各出现了不止一次：${JSON.stringify(dup)} —— ${panel.slice(0, 300)}`);
    check(t.includes("另存为") && /PDF|截图/.test(t),
      `DOCX 的回执没给出路「另存为 PDF 或截图再投」：${t.slice(0, 300)}`);
    check(t.includes("首版不收"), `DOCX 的回执没说清为什么不收：${t.slice(0, 300)}`);
    check(t.includes("PDF"), `PDF 的回执没点名：${t.slice(0, 300)}`);
    check(/损坏|截断/.test(t), `坏图的回执没说清是文件本身坏了：${t.slice(0, 300)}`);
    noErrors(rec, "G 混收拒");
    await page.screenshot({ path: join(SHOTS, "mixed-receipt.png") });
    await rec.close();

    /* **全拒**那一类：空画布上只丢一份 .docx。
       曾经这一整类情形一个断言都没有：G 段是 4 份里 1 份成功，
       `gotSomething` 为真 → 屏态落到 `ready` → 回执照常显示。而一份都没
       收下时 `screen` 被设成 `empty`，回执又只挂在 `screen === "ready"`
       上，于是 `#receipt` 根本不存在：操作者丢完文件，屏上毫无变化，
       既不知道被拒了也不知道该怎么办——而入口文案恰恰在邀请他投 PDF。 */
    const only = await screen();
    const ot = await atIn(only.page, 400, 300);
    await dropAndSettle(only.page, ot, () => dropFiles(only.page, [F("作业.docx", DOCX, paths.docx)], ot));
    const state = await only.page.locator("#app").getAttribute("data-ingest-state");
    const receiptCount = await only.page.locator("#receipt").count();
    check(receiptCount === 1,
      `空画布上只投一份被拒的文件，屏上没有任何回执（data-ingest-state="${state}"）：` +
      `操作者丢完文件看不到任何反应`);
    if (receiptCount === 1) {
      const panel2 = (await only.page.locator("#receipt").innerText()).replace(/\s+/g, " ");
      check(panel2.includes("首版不收"), `全拒时的话术没说清为什么不收：${panel2.slice(0, 200)}`);
      check(/另存为/.test(panel2), `全拒时的话术没给出路「另存为 PDF」：${panel2.slice(0, 200)}`);
      note(`全拒：空画布投一份 .docx → 屏态 ${state}，回执照样出现并给出出路`);
    }
    check(await only.page.locator("[data-id]").count() === 0,
      "被拒的文件在画布上变成了区域");
    noErrors(only.rec, "G 全拒");
    await only.rec.close();
    note(`混投 4 份 → 画布 ${n} 块；回执 ${t.match(/已投放[^\n]{0,60}/)?.[0] ?? "（无）"}`);
  });

  // =====================================================================
  // H. 内容哈希身份：同一份再投一次不新增区域（ADR-0015）
  // =====================================================================
  await section("H. 内容哈希身份", async () => {
    const { page, rec } = await screen();
    const p1 = await atIn(page, 200, 150);
    await dropOne(page, paths.exam, PNG, "月考卷.png", p1);
    const first = nonEmpty(await boxes(page), "H 第一次投放");
    check(first.length === 1, `第一次应得 1 块，实际 ${first.length}`);

    /* 换了个名字、同一份内容。同屏投放——不刷新，刷新会作废这一轮。 */
    const p2 = await atIn(page, 200, 150);
    await dropOne(page, paths.exam, PNG, "月考卷最终版.png", p2);
    const second = nonEmpty(await boxes(page), "H 重投");
    check(second.length === 1, `同一份内容换个名字重投不该新增区域，实际 ${second.length} 块`);
    check(JSON.stringify(second) === JSON.stringify(first),
      `重投把原来那块移动了：${JSON.stringify(first)} → ${JSON.stringify(second)}`);
    const t = await bodyText(page);
    check(/已在画布上/.test(t), `回执该说「已在画布上」，实际：${t.slice(0, 300)}`);
    /* 区域 id 是服务端生成的 `${artifactId}#${regionId}`，不是「第几次投放的第几块」。 */
    check(second[0].id.startsWith("sha256:") && second[0].id.includes("#"),
      `区域 id 应是服务端生成的 \`\${artifactId}#\${regionId}\`，实际 ${JSON.stringify(second[0].id)}`);
    noErrors(rec, "H 内容哈希");
    await rec.close();
    note(`同内容改名重投 → 仍 ${second.length} 块、位置未动、id ${second[0].id.slice(0, 24)}…、回执说明了原因`);
  });

  // =====================================================================
  // I. 投屏：零操作痕迹 + in-place 往返 + 零网络
  // =====================================================================
  /* 往返必须在**同一个 page 实例内**做。早先的 `smoke.mjs:415-417` 比的是
     「两次独立 build 的结果相同」——那是两屏，不是状态往返；而
     `casting` 这一态如果重渲染时重建了 board，两屏当然一样，一样的东西
     恰恰说明不了「进出会不会动」。这里逐块比 style 的四个值，再比
     #stage 的 transform 六个数值，全部按**数值**比。 */
  await section("I. 投屏", async () => {
    const { page, rec } = await screen();
    const r = await appRect(page);
    const target = await atIn(page, 300, 200);
    await dropAndSettle(page, target, () => dropFiles(page, [
      F("月考卷.png", PNG, paths.exam), F("讲义.png", PNG, paths.handout),
    ], target));
    await assertPainted(page, 2, "I 投屏前");
    const before = await (async () => {
      /* 阳性对照：先把一块选中，让选中框也进屏。**必须在取 before 之后
         才断言**——选中会把那一块前移到数组末尾（层次就是 regions 的顺序），
         所以快照要取在点击之后，否则下面那次逐块比较比的根本不是同一层。

         点的是**左上角附近**而不是元素中心：几份是向右下错开摊在桌上的，
         第一份的中心被第二份盖住了，点中心会被 Playwright 判成
         「subtree intercepts pointer events」而一直重试。错开的步长封顶
         72px，所以 8px 处一定是露着的。 */
      await page.locator("[data-id]").first().click({ position: { x: 8, y: 8 } });
      await page.waitForFunction(() => document.querySelectorAll("[data-id].ring-2").length > 0,
        null, { timeout: 4000 });
      return boxes(page);
    })();
    nonEmpty(before, "I 投屏前");
    check(before.length === 2, `投屏前应有 2 块，实际 ${before.length}`);
    const vBefore = await view(page);

    const opCounts = await countAll(page);
    for (const [name, sel] of [["底部控件", "#chrome"], ["来源角标", ".src-badge"], ["选中框", "[data-id].ring-2"]]) {
      check(opCounts[sel] > 0, `对照失效：操作态下「${name}」一处都没有，「投屏必须撤掉它」无从谈起`);
    }
    check((await page.locator("#chrome").count()) === 1, "对照失效：操作态没有底部控件");

    /* 投屏那一刻的 /api/* 计数：位图早就是 blob: URL 了。 */
    const mark = rec.api.length;
    await castOn(page);
    const castReqs = rec.api.slice(mark);

    const castCounts = await countAll(page);
    for (const t of TRACES) {
      check(castCounts[t.sel] === 0, `投屏态仍有「${t.name}」(${t.sel}) ${castCounts[t.sel]} 处`);
    }
    check(castReqs.length === 0, `投屏期间发了 ${castReqs.length} 个 /api/* 请求：${castReqs.join(" · ")}`);
    /* 画面上不许摆退出口。 */
    check((await page.locator("#chrome button").count()) === 0,
      "投屏态画面上出现了按钮（退出口必须在系统级动作上）");
    /* 热点层不许盖住正需要操作的按钮——这一屏是 0 个按钮，**所以这条要拿到
       操作态去验**（见下面 J）。 */

    /* 逐块比 style 的四个值。 */
    const during = nonEmpty(await boxes(page), "I 投屏中");
    /* 投出去的那几块必须**真的有图**。这一条不许省：投屏是一道渲染门，
       而渲染门之后「屏上有没有内容」正是这张票的全部内容。 */
    await assertPainted(page, during.length, "I 投屏中");
    check(during.length === before.length,
      `进出投屏块数变了：${before.length} → ${during.length}`);
    for (const b of before) {
      const d = during.find((x) => x.id === b.id);
      if (!check(!!d, `投屏后不见了 ${b.id}`)) continue;
      const same = ["x", "y", "w", "h"].every((k) => d[k] === b[k]);
      check(same, `${b.id} 进出投屏位置/尺寸变了：` +
        `${["x", "y", "w", "h"].map((k) => `${k} ${b[k]}→${d[k]}`).join("，")}`);
    }
    /* 再比 #stage 的 transform 六个数值——布局一样而相机偷偷动过，
       上面的逐块比较是看不见的。 */
    const vDuring = await view(page);
    check(vDuring.x === vBefore.x && vDuring.y === vBefore.y && vDuring.k === vBefore.k,
      `投屏时相机动了：${JSON.stringify(vBefore)} → ${JSON.stringify(vDuring)}`);

    await page.screenshot({ path: join(SHOTS, "casting.png") });

    /* Esc = 希沃遥控的系统级退出键。 */
    await castOff(page);
    const after = nonEmpty(await boxes(page), "I 退出投屏");
    check(JSON.stringify(after) === JSON.stringify(before),
      `退出投屏后布局没原样回来：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const vAfter = await view(page);
    check(vAfter.x === vBefore.x && vAfter.y === vBefore.y && vAfter.k === vBefore.k,
      `退出投屏后相机变了：${JSON.stringify(vBefore)} → ${JSON.stringify(vAfter)}`);
    const backCounts = await countAll(page);
    check(backCounts["#chrome"] > 0, "退出投屏后底部控件没回来");
    check(backCounts[".src-badge"] > 0, "退出投屏后来源角标没回来");
    check(backCounts["[data-id].ring-2"] > 0, "退出投屏后选中框没回来——「退出即回到操作态，布局不丢」");
    const afterExitReqs = rec.api.length - mark - castReqs.length;
    check(afterExitReqs === 0, `退出投屏之后又发了 ${afterExitReqs} 个 /api/* 请求`);
    noErrors(rec, "I 投屏");
    await rec.close();
    note(`投屏往返（同一 page 内 in-place）：操作态 ${fmtCounts(opCounts)}；` +
      `投屏态 ${fmtCounts(castCounts)}；逐块 style 四值与 transform 六值全程不变；` +
      `/api/* 请求 ${castReqs.length} + ${afterExitReqs} 个`);
  });

  // =====================================================================
  // J. 工具条：唯一 primary、热点层不挡按钮
  // =====================================================================
  await section("J. 工具条", async () => {
    const { page, rec } = await screen();
    const empty = await chromeButtons(page);
    check(!empty.some((b) => b.includes("投屏")), `画布空时不该有「投屏」：${JSON.stringify(empty)}`);
    const emptyPrim = await primaries(page);
    check(emptyPrim.length === 0, `空画布上不该有 primary：${JSON.stringify(emptyPrim)}`);

    await dropOne(page, paths.exam, PNG, "月考卷.png", await atIn(page, 300, 200));
    const ps = await primaries(page);
    check(ps.length === 1 && ps[0].includes("投屏"),
      `有内容后「投屏」应是本屏唯一的 primary，实际 ${JSON.stringify(ps)}`);

    /* 热点层不许盖住正需要操作的按钮。product-smoke 从没验过这条：
       拿按钮自己的中心点问 document.elementFromPoint，答出来的必须
       是这个按钮自己或它的后代。 */
    const cast = page.locator("#chrome button", { hasText: "投屏" });
    const hit = await cast.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { ok: el.contains(top) || el === top, tag: top?.tagName ?? "无", id: top?.id ?? "" };
    });
    check(hit.ok, `「投屏」按钮的中心点被 ${hit.tag}#${hit.id} 盖住了 —— 热点层不许盖住正需要操作的按钮`);
    noErrors(rec, "J 工具条");
    await rec.close();
    note(`工具条：空画布 ${JSON.stringify(empty)}（无 primary）；有内容后 primary = ${JSON.stringify(ps)}；` +
      `按钮中心点的命中元素就是它自己`);
  });

  // =====================================================================
  // K. 第二条投放路径：文件选择器，连投同一个文件
  // =====================================================================
  await section("K. 文件选择器", async () => {
    const { page, rec } = await screen();
    const target = await atIn(page, 200, 200);
    await dropOne(page, paths.exam, PNG, "月考卷.png", target);
    check((await page.locator("[data-id]").count()) === 1, "经拖拽投放后应有 1 块");

    /* setInputFiles 直接走 input 的 change 事件。第二次**选同一个文件**：
       处理器里没把 e.target.value 清空的话，change 根本不触发——而
       「同一份内容再投一次」正是 ADR-0015 明写要支持的动作。 */
    const posted = page.waitForResponse(
      (r) => r.url().includes("/api/") && r.request().method() === "POST", { timeout: 8000 },
    ).catch(() => null);
    await page.setInputFiles("#chrome input[type=file]", paths.exam);
    check(!!(await posted), "第二次选文件没有发出任何 /api/* POST —— e.target.value 很可能没被清空");
    await page.waitForFunction(
      () => document.querySelector("#app")?.dataset.ingestState !== "ingesting", null, { timeout: 8000 });
    const t = await bodyText(page);
    check(/已在画布上/.test(t), `第二次选同一份文件应有「已在画布上」的回执，实际：${t.slice(0, 240)}`);
    check((await page.locator("[data-id]").count()) === 1, "重投不该新增区域");
    noErrors(rec, "K 选择器");
    await rec.close();
    note(`选择器投放 + 连投同一个文件 → 回执 ${t.match(/已在画布上[^\n]{0,40}/)?.[0] ?? "（无）"}`);
  });

  // =====================================================================
  // L. 会话没了：410 + application/json + 看得懂的中文 + 重新开始
  // =====================================================================
  /* 这一段**故意**造一个 410，所以「零运行时错误」必须在它之前收口，
     否则「有错误」反而是它证明成功了。 */
  await section("L. 会话没了", async () => {
    const { page, rec } = await screen();
    const netMark = rec.api.length;
    const target = await atIn(page, 200, 200);
    await dropOne(page, paths.exam, PNG, "月考卷.png", target);
    const ids = nonEmpty(await boxes(page), "L 投放").map((b) => b.id);
    check(ids.length === 1 && ids[0].startsWith("sha256:") && ids[0].includes("#"),
      `区域 id 应是服务端生成的 \`\${artifactId}#\${regionId}\`，实际 ${JSON.stringify(ids)}`);
    check((await page.evaluate(() => Object.keys(localStorage).length)) === 0,
      "产品路径往 localStorage 写了东西 —— 会话 id 不许落盘（ADR-0014）");
    check(rec.errors.length === 0,
      `L 造 410 之前就有 ${rec.errors.length} 条运行时错误：${rec.errors.slice(0, 4).join(" | ")}`);

    /* 会话 id 从**网络侧**摸：区域位图的 URL 里带着它，而 ProductApp
       不把它存进任何可读的地方。这正是 ADR-0014 想要的结果。 */
    const sid = rec.api.slice(netMark)
      .map((u) => u.match(/\/api\/sessions\/([^/]+)\//)?.[1]).find(Boolean);
    check(!!sid, `从网络记录里没摸到本次投放的会话 id（新增 ${rec.api.length - netMark} 条 /api/*）`);

    /* expire 是把 last_seen 拨到过去，**不是删掉**——所以下一个请求拿到
       的是 session_expired（见过、现已不在），那才是操作者真会撞上的码。
       用 reset 的话拿到的是 session_unknown，测的是另一条路。 */
    const badMark = rec.bad.length;
    if (sid) {
      const r = await fetch(`${ORIGIN}/api/_test/expire?sessionId=${encodeURIComponent(sid)}`, { method: "POST" });
      check(r.ok, `expire 钩子没通（HTTP ${r.status}）——下面「会话没了」那条会变成空过`);
    }
    await dropOne(page, paths.handout, PNG, "讲义.png", await atIn(page, 300, 250));

    /* 阳性对照：410 **真的发生了**。不确认这一条，下面「界面显示得对」
       就没有被验证的对象。 */
    const got410 = rec.bad.slice(badMark).filter((b) => b.url.includes("/api/"));
    check(got410.length > 0, "没观察到任何 4xx/5xx —— 会话没被真的作废，下面几条断言全是空的");
    const is410 = got410.filter((b) => b.status === 410);
    check(is410.length > 0,
      `观察到的错误不是 410：${got410.map((b) => `${b.status} ${b.url.split("/api/")[1]}`).join(" · ")}`);
    /* 状态码对了还不够——**content-type 必须是 JSON**。拿到 HTML 时
       `res.json()` 抛 SyntaxError，那正是 spec 明令禁止的白屏。 */
    check(is410.every((b) => /application\/json/.test(b.ct)),
      `410 的 content-type 不是 application/json：${is410.map((b) => b.ct || "（空）").join(" · ")}`);

    const t = await bodyText(page);
    check(await page.locator("#error-screen").isVisible(), "没有出现错误屏");
    check(await page.locator("#error-screen[role=alert]").count() === 1, "错误屏缺 role=alert");
    check(!/SyntaxError|Unexpected token|is not valid JSON/.test(t), "拿到非 JSON 时白屏了");
    /* 画布不该整个消失。这不是「错误屏该不该挡住画布」的美学问题：
       整个 React 树炸掉时浏览器会留下一个空 body，而空 body 与
       「有一屏明确的错误」在截图上一模一样。 */
    check((await page.locator("#stage").count()) === 1, "画布不该整个消失（白屏）");

    /* 「看得懂」这半句。**比 message 那一段，不是比整页。**
       原来的正则 `/不在服务端|已经不在|重新开始|会话/` 里 `重新开始` 是
       ErrorScreen 那个按钮的固定文案，而上一行刚断言过 `#error-screen` 可见
       ——所以只要错误屏在，这条必然过，屏上写的是哪句话完全没被验。把
       `message` 换成「出错了。」、`detail` 换成 `session_expired` 原文，
       它照样全绿。 */
    const code = await page.locator("#error-screen [data-problem-code]").getAttribute("data-problem-code");
    check(code === "session_expired",
      `错误屏上的 data-problem-code 应当是 session_expired，实际「${code}」`);
    const msg = await page.locator("#error-screen p").first().innerText();
    check(/释放|不在|没了/.test(msg),
      `「会话没了」给操作者的那句话没说出发生了什么：「${msg.trim()}」`);
    check(!/session_expired|SyntaxError|undefined|\[object/.test(msg),
      `那句话里漏出了码或技术术语：「${msg.trim()}」`);

    /* 错误屏接管焦点。**比身份，不比文字。**
       曾经这里量的是 `document.activeElement?.textContent`——没有任何元素
       持有焦点时那是 `<body>` 的全文，而 body 的 textContent 包含那颗按钮
       上的「重新开始」，于是 `/重新开始/.test(focused)` 恒为真：把
       ErrorScreen 里那个 focus 的 useEffect 删掉，这一条一条都不会红。 */
    const focusOk = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement
        && el.tagName === "BUTTON"
        && el === document.querySelector("#error-screen button");
    });
    check(focusOk,
      "错误屏没有接管焦点（焦点应当落在「重新开始」那颗 button 上，"
      + `当前是 ${await page.evaluate(() => document.activeElement?.tagName ?? "（无）")}）`);
    /* 一屏最多一个 primary。 */
    const errPrim = await primaries(page);
    check(errPrim.length === 1 && errPrim[0].includes("重新开始"),
      `错误屏上应当只有「重新开始」一个 primary，实际 ${JSON.stringify(errPrim)}`);
    /* 会话没了之后这一轮已经结束（ADR-0014），画布上剩的是没有出处的空壳，
       不许还能投出去。 */
    const errChrome = await chromeButtons(page);
    check(!errChrome.some((b) => b.includes("投屏")),
      `会话没了之后不该还能投屏：${JSON.stringify(errChrome)}`);
    /* 持久：再投一次（照样 410），错误屏必须还在。
       早先这里是 `waitForSelector(#error-screen)`，而它**本来就在屏上**——
       等一个已经为真的条件恒真，等于什么都没验。原型那个 20s 自动消失的
       toast 正是栽在「不自动消失」这一条上。 */
    await dropOne(page, paths.small, PNG, "小图.png", await atIn(page, 500, 300));
    check((await page.locator("#error-screen").count()) === 1,
      "再失败一次之后错误屏不见了 —— 它必须持久，不许自动消失");
    check((await page.locator("#stage").count()) === 1, "第二次失败之后画布也不该整个消失");
    await page.screenshot({ path: join(SHOTS, "session-gone.png") });

    /* 「重新开始」是真能用的：回到空画布，服务端那份也放掉了。

       **数请求条数不够**——ProductApp 的 restart 对 DELETE 挂着
       `.catch(() => {})`，请求发出去了而服务端回 500 时这条照样过。

       但**也不能断言 DELETE 返回 204**：这一屏上会话早就没了。`SessionStore.get`
       在惰性过期时就把那条从表里摘掉再抛 410，所以错误屏出现的那一刻
       服务端已经不再持有这个会话，DELETE 拿到 410 是**正确**的——它说的正是
       「这一份已经放掉了」。断言 204 会把正确行为判成失败。

       所以钉的是那条真正要保的东西：**重启之后服务端确实不再有这个会话**，
       页位图没有白占 30 分钟（ADR-0014）。直接问它。 */
    const delMark = rec.api.length;
    const delResponse = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.url().includes("/api/sessions/"),
      { timeout: 8000 },
    ).catch(() => null);
    await page.locator("#error-screen button", { hasText: "重新开始" }).click();
    const del = await delResponse;
    await page.waitForFunction(
      () => !document.querySelector("#error-screen") &&
        document.querySelector("#app")?.dataset.ingestState === "empty", null, { timeout: 6000 });
    check((await page.locator("[data-id]").count()) === 0, "重新开始之后画布应当是空的");
    check(rec.api.length > delMark, "重新开始没有向后端发释放请求");
    check(del !== null, "没观察到 DELETE /api/sessions 的响应");
    check(del?.status() === 204 || del?.status() === 410,
      `「重新开始」的 DELETE 既没成功也没「已经不在」（HTTP ${del?.status() ?? "（无响应）"}）`);

    if (sid) {
      const after2 = await fetch(`${ORIGIN}/api/sessions/${encodeURIComponent(sid)}`);
      check(after2.status === 410,
        `重新开始之后服务端仍然认得这个会话（HTTP ${after2.status}）：` +
        "页位图会继续在内存里挂满 30 分钟 TTL（ADR-0014）");
      check(/application\/json/.test(after2.headers.get("content-type") ?? ""),
        "那个 410 的 content-type 不是 JSON");
    }
    await rec.close();
    note(`会话没了 → 410（${is410[0]?.ct}）；错误屏说：${t.match(/这一次的准备[^。]*。/)?.[0] ?? "（没找到那句）"}；` +
      `「重新开始」回到空画布并释放了服务端会话`);
  });

  // =====================================================================
  // M. 端到端：单张图片走零模型短路径，落在 5s 内
  // =====================================================================
  /* **这个数字对 #6 零证据力。** #6 问的是「解析的延迟与内存预算」，
     那是多页 PDF + 视觉模型的账；这里量的是「一张图 + 一次往返 + 一次
     位图抓取」，两者不是一回事。ADR-0019 也不要拿它来校准。
     它在这里的作用只有一个：抓住「链路里多了一次不该有的往返」这种
     量级上的回归。 */
  await section("M. 5s 预算", async () => {
    const { page, rec } = await screen();
    const target = await atIn(page, 400, 300);
    const t0 = process.hrtime.bigint();
    await dropOne(page, paths.exam, PNG, "月考卷.png", target);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const n = await page.locator("[data-id]").count();
    check(n === 1, `预算这一段没投上（画布 ${n} 块），计时没有意义`);
    await assertPainted(page, n, "M 5s 预算");
    check(ms <= 5000, `单张图片的端到端用了 ${ms.toFixed(0)}ms，超过 5s 的预算`);
    const state = await page.locator("#app").getAttribute("data-ingest-state");
    check(state === "ready", `落定后屏态应是 ready，实际 ${state}`);

    /* 「**零模型**」这半句此前一个断言都没有——`ms <= 5000` 只量了后半。
       在单图路径里插一次模型探测（哪怕 no-op、哪怕被短路），延迟从 111ms
       涨到 900ms，这条照样过，ADR-0019 明写「这条路必须是零模型」没有网。

       这里从**请求序列**证明：这条短路上只该有 3 个 /api/* 往返——
       建会话、投一份、每块一次位图。多出第四次就说明链路里多了东西。 */
    const kinds = rec.api.map((u) => {
      if (/\/api\/sessions$/.test(u)) return "POST /api/sessions";
      if (/\/artifacts$/.test(u)) return "POST …/artifacts";
      if (/\/regions\//.test(u)) return "GET …/regions/{id}";
      if (/\/api\/sessions\/[^/]+$/.test(u)) return "GET/DELETE /api/sessions/{id}";
      return `多余：${u}`;
    });
    const expected = ["POST /api/sessions", "POST …/artifacts", "GET …/regions/{id}"];
    check(kinds.length === expected.length && kinds.every((k, i) => k === expected[i]),
      `单图短路径上应当恰好 3 个往返（建会话 / 投一份 / 取一次位图），实际：${kinds.join(" · ")}`);

    noErrors(rec, "M 5s");
    await rec.close();
    note(`单张图片端到端 ${ms.toFixed(0)}ms（预算 5000ms；对 #6 零证据力，别拿它校准 ADR-0019）；` +
      `零模型由往返序列钉住：${kinds.join(" · ")}`);
  });

  // =====================================================================
  // N. 一次瞬时失败不许把这一轮锁死
  // =====================================================================
  /* 「投屏」是这一轮**唯一**的主动作，所以它在任何一次瞬时失败之后都必须
     能恢复。曾经 pending 只在 ingest 那一刻算一次、之后谁都不回写，于是
     拦掉第一次区域位图请求就会得到：位图明明在屏上画得好好的，
     `data-bitmaps-pending` 恒为 "1"，「投屏」停在 secondary 且按下去什么
     都不发生——唯一出路是刷页面，而那会丢掉全部编排。任何一次网络抖动、
     一次服务端重启、一次位图端点的 500 都足以触发。

     真实修法：pending 存键的集合而不是一个只写一次的计数，
     RegionImage 在**真的拿到字节**时回报，那一块才被划掉。 */
  await section("N. 瞬时失败后能恢复", async () => {
    const { page, rec } = await screen();
    /* 只让**第一次**区域位图请求失败，其余放行。 */
    let seen = 0;
    await page.route("**/regions/**", async (route) => {
      if (seen === 0) { seen += 1; await route.abort("failed"); return; }
      await route.continue();
    });

    const target = await atIn(page, 400, 300);
    /* 这一段**故意**制造一次失败，所以不能直接用 `noErrors`——那会把
       我们自己造的这条算进去。这里记下起点，只允许那一次。 */
    const errMark = rec.errors.length;
    await dropAndSettle(page, target, () => dropFiles(page, [F("月考卷.png", PNG, paths.exam)], target));

    check(seen > 0, "对照失效：第一次区域位图请求根本没被拦下来，这段什么都没验");
    const pending = await page.locator("#app").getAttribute("data-bitmaps-pending");
    check(pending === "0",
      `重试已经成功了，位图也在屏上，但「投屏」还被锁着：data-bitmaps-pending="${pending}"。` +
      "一次瞬时失败把这一轮的主动作永久锁死了");
    /* 阳性对照：那块位图**真的**画出来了（否则 pending=0 可能只是因为
       画布上压根没有块）。 */
    await assertPainted(page, 1, "N 瞬时失败后恢复");
    const cast = page.locator("#chrome button", { hasText: "投屏" });
    check(await cast.evaluate((el) => el.className.includes("bg-emerald-600")),
      "位图补回来之后「投屏」没有恢复成 primary —— 操作者按下去不会有任何反应");
    /* 恢复之后不许有**别的**错误：除了我们故意拦的那一次。 */
    const unexpected = rec.errors.slice(errMark)
      .filter((e) => !/ERR_FAILED|net::ERR_FAILED/.test(e));
    check(unexpected.length === 0,
      `除了故意制造的那一次失败，还冒出 ${unexpected.length} 条：${unexpected.slice(0, 3).join(" | ")}`);
    await rec.close();
    note(`瞬时失败：拦掉第一次位图请求（共拦 ${seen} 次）后重试成功，` +
      `pending 归零、「投屏」恢复成 primary，位图真的画出来了`);
  });

  await section("O. 手势归属", async () => {
    const { page, rec } = await screen();

    /* 三条断言各配一条阳性对照。**没有对照的 `=== 'none'` 是恒过的写法**：
       选择器改名、类名被 Tailwind 扫掉、或者 `getComputedStyle` 在某个平台
       返回常量——三种情况都会让它照样绿。对照的作用是把「读到了东西」和
       「读对了」分开验。 */
    const touchOf = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).touchAction : "(元素不存在)";
    }, sel);

    const canvas = await touchOf("#canvas");
    const chrome = await touchOf("#chrome");
    const root = await touchOf("#app");

    /* 对照：读到的值确实随元素而变。#app 与 #canvas 必须不同，否则
       「=== 'none'」只是把同一个常量又比了一遍。 */
    check(root !== canvas,
      `对照失效：#app 与 #canvas 的 touch-action 读出来是同一个值 "${root}"——` +
      "这条读法根本没在区分元素，后面的相等比较全是空过");

    check(canvas === "none",
      `画布容器的 touch-action 应当是 none（双指缩放已接管成拖/缩放/平移），实际 "${canvas}"`);
    check(chrome === "manipulation",
      `工具条的 touch-action 应当是 manipulation（去掉双击缩放与 300ms 延迟，但保留平移），实际 "${chrome}"`);

    /* 对照：viewport meta 真被读到，且不是空串。 */
    const meta = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "");
    check(meta.includes("width=device-width"),
      `对照失效：viewport meta 的 content 读出来是 "${meta}"，连 width 都读不到`);
    check(/user-scalable=no/.test(meta),
      `viewport meta 缺 user-scalable=no（浏览器会自己捏合缩放整页，与画布的双指缩放抢同一次手势），实际 "${meta}"`);
    check(/maximum-scale=1/.test(meta),
      `viewport meta 缺 maximum-scale=1（同上），实际 "${meta}"`);

    note(`手势归属：#canvas=${canvas}、#chrome=${chrome}、#app=${root}；viewport meta = ${meta}`);
    await rec.close();
  });

} catch (e) {
  fails.push(`脚手架整段抛出：${e?.stack ?? e}`);
} finally {
  await browser?.close();
  stop();
}

// ---------- 报告 ----------
for (const n of notes) console.log(`  ${n}`);
console.log(`\n—— 结果 ——`);
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 条（共开 ${screenNo} 屏）`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ 产品链路全通过（${screenNo} 屏、${notes.length} 条观察）`);
