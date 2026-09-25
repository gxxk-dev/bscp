/* ===========================================================================
   PROTOTYPE 逻辑 —— 见 src/canvas-ui.html 顶部的说明。
   设计规则来源：~/.claude/skills/design/guidelines/
   =========================================================================== */

const ICONS = /*__ICONS__*/;

/* ---------- 图标 ----------
   icons.md：不手搓 SVG，一律来自官方 Heroicons Micro（16px → size-4）；
   实心图标用 fill-*，不用 text-* + currentColor。 */
function icon(name, cls = "icon-glyph") {
  const i = ICONS[name];
  if (!i) throw new Error("unknown icon: " + name);
  const paths = i.paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg viewBox="${i.viewBox}" aria-hidden="true" class="${cls}">${paths}</svg>`;
}

/* buttons.md：图标按钮，两种尺寸（28px / 36px，差 8px ≥ 6px）；
   48×48 命中区由 hit-expand 在粗指针设备上补足 */
function iconBtn(name, label, size = "sm", btnExtra = "", glyphCls = "icon-glyph") {
  const dim = size === "sm" ? "size-7" : "size-9";
  return `<button type="button" title="${label}" aria-label="${label}"
    class="icon-btn group ${dim} hover:bg-neutral-950/5 dark:hover:bg-white/10 ${btnExtra}">
    ${icon(name, glyphCls)}<span class="hit-expand" aria-hidden="true"></span></button>`;
}

/* ---------- 变体定义：结构差异，不是换皮 ---------- */
const VARIANTS = {
  A: { name: "角落裸图标", note: "无容器 · 28px · 常驻但不占面" },
  B: { name: "底部细条", note: "有容器 · 28px · 参考授课界面" },
  C: { name: "全净 + 径向", note: "常态零控件 · 长按唤出 · 细线选中" },
};
const ORDER = ["A", "B", "C"];

/* ---------- 示例内容 ----------
   标题与选项用真字；正文用灰条代表原始资料的裁切位图。 */
const REGIONS = [
  { id: "q1", x: 0, y: 0, w: 460, h: 250,
    title: "1. 下列说法正确的是（　）",
    opts: ["A. 物体速度为零时加速度一定为零",
           "B. 加速度减小时速度一定减小",
           "C. 速度变化越快加速度越大",
           "D. 加速度方向与速度方向总是相同"] },
  { id: "q2", x: 500, y: 0, w: 460, h: 250,
    title: "2. 如图所示，物块沿斜面下滑（　）",
    bars: ["w-[90%]", "w-[75%]", "w-[60%]"] },
  { id: "fig", x: 1000, y: 0, w: 300, h: 250, figure: true },
  { id: "q3", x: 0, y: 300, w: 700, h: 220,
    title: "3. 计算题：求物块在 3s 内通过的位移",
    bars: ["w-[90%]", "w-[75%]", "w-[60%]", "w-[45%]"] },
  { id: "ans", x: 750, y: 300, w: 550, h: 220,
    title: "参考答案", opts: ["1. C　　2. B　　3. 4.5 m"] },
  { id: "note", x: 0, y: 570, w: 400, h: 150,
    title: "本卷说明", bars: ["w-[90%]", "w-[75%]"] },
];

/* ---------- 画布状态（纯内存，ADR-0005） ---------- */
const viewport = document.getElementById("viewport");
const canvasEl = document.getElementById("canvas");
const radialEl = document.getElementById("radial");
const view = { x: 90, y: 108, k: 1 };
let selected = null;
let current = "A";
const regionEls = new Map();

/* general.md：动态值优先走 CSS 变量，而不是直接写死 style 属性 */
function applyView() {
  canvasEl.style.setProperty("--vx", view.x + "px");
  canvasEl.style.setProperty("--vy", view.y + "px");
  canvasEl.style.setProperty("--vk", view.k);
}
function setZoomLabel() {
  const z = document.getElementById("zoomLabel");
  if (z) z.textContent = Math.round(view.k * 100) + "%";
}

/* ---------- 区域渲染 ---------- */
const HANDLE_POS = {
  nw: "-top-1.5 -left-1.5 cursor-nwse-resize",
  ne: "-top-1.5 -right-1.5 cursor-nesw-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  se: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
};

function regionMarkup(r) {
  const bars = (r.bars || [])
    .map((w) => `<div class="my-1.5 h-1.5 ${w} rounded-sm bg-neutral-950/10 dark:bg-white/10"></div>`)
    .join("");
  const opts = (r.opts || [])
    .map((t) => `<p class="text-pretty text-sm text-neutral-600 dark:text-neutral-400">${t}</p>`)
    .join("");
  const body = r.figure
    ? `<div class="h-full rounded-md bg-neutral-950/5 ring-1 ring-neutral-950/5
         dark:bg-white/5 dark:ring-white/10"></div>`
    : `<p class="mb-2 text-balance text-sm font-semibold">${r.title}</p>${opts}${bars}`;

  const handles = Object.entries(HANDLE_POS)
    .map(([pos, cls]) =>
      `<span data-handle="${pos}" class="absolute hidden size-3.5 rounded-sm bg-white
        ring-1 ring-emerald-600 dark:bg-neutral-900 ${cls}"></span>`)
    .join("");

  return `<div data-id="${r.id}" class="region absolute left-(--x) top-(--y) w-(--w) h-(--h)
    rounded-(--radius) bg-white shadow-xs ring-1 ring-neutral-950/10
    dark:bg-neutral-900 dark:shadow-none dark:inset-ring dark:inset-ring-white/5">
    <div class="relative h-full overflow-hidden rounded-(--radius)">
      <div class="h-full p-3">${body}</div>
    </div>${handles}</div>`;
}

function buildRegions() {
  for (const r of REGIONS) {
    const host = document.createElement("div");
    host.innerHTML = regionMarkup(r);
    const el = host.firstElementChild;
    el.style.setProperty("--x", r.x + "px");
    el.style.setProperty("--y", r.y + "px");
    el.style.setProperty("--w", r.w + "px");
    el.style.setProperty("--h", r.h + "px");
    canvasEl.appendChild(el);
    regionEls.set(r.id, el);
  }
}

function setRegionBox(r) {
  const el = regionEls.get(r.id);
  el.style.setProperty("--x", r.x + "px");
  el.style.setProperty("--y", r.y + "px");
  el.style.setProperty("--w", r.w + "px");
  el.style.setProperty("--h", r.h + "px");
}

/* 选中态：1px 中性环 → 2px 强调环；变体 C 用细线代替手柄 */
function setSelected(id) {
  for (const [k, el] of regionEls) {
    const on = k === id;
    el.classList.toggle("ring-2", on);
    el.classList.toggle("ring-emerald-600", on);
    el.classList.toggle("ring-1", !on);
    el.classList.toggle("ring-neutral-950/10", !on);
    el.classList.toggle("outline-2", on && current === "C");
    el.classList.toggle("outline-emerald-600", on && current === "C");
    el.querySelectorAll("[data-handle]").forEach((h) =>
      h.classList.toggle("hidden", !on || current === "C"));
  }
  selected = id;
}

/* ---------- 变体 A：角落裸图标（无容器，ghost 按钮） ---------- */
function buildChromeA() {
  const host = document.getElementById("chromeA");
  host.innerHTML = `<div class="flex flex-col gap-y-1">${
    ["hand-raised:移动", "scissors:裁切", "plus:添加",
     "arrow-uturn-left:撤销", "ellipsis-horizontal:更多"]
      .map((s) => iconBtn(...s.split(":"))).join("")}</div>`;
}

/* ---------- 变体 B：底部细条 ---------- */
function buildChromeB() {
  const host = document.getElementById("chromeB");
  /* border-radius.md：容器声明 --radius/--padding，内部 calc 推出同心圆角
     navigation.md：横向菜单不得溢出父容器 → overflow-x-auto */
  const bar = `<div class="flex max-w-[calc(100dvw-1.5rem)] items-center gap-x-0.5
    overflow-x-auto rounded-(--radius) bg-white/85 p-(--padding) shadow-sm
    ring-1 ring-neutral-950/10 backdrop-blur-sm
    dark:bg-neutral-900/85 dark:shadow-none dark:ring-white/10
    [--radius:var(--radius-xl)] [--padding:--spacing(1.5)]">
    ${["arrows-pointing-out:全屏", "hand-raised:移动", "scissors:裁切",
       "plus:添加", "arrow-uturn-left:撤销", "ellipsis-horizontal:更多"]
      .map((s) => iconBtn(...s.split(":"))).join("")}
    <span class="mx-1 h-4 w-px shrink-0 bg-neutral-950/10 dark:bg-white/15"></span>
    <span class="flex shrink-0 items-center gap-x-0.5 px-1 tabular-nums text-sm
      text-neutral-600 dark:text-neutral-400">
      ${iconBtn("magnifying-glass-minus", "缩小")}
      <span id="zoomLabel" class="min-w-9 text-center">100%</span>
      ${iconBtn("magnifying-glass-plus", "放大")}
    </span></div>`;
  host.innerHTML = bar;
}

/* ---------- 变体 C：长按径向 ---------- */
const RADIAL_ITEMS = [
  ["scissors", "裁切", -90], ["hand-raised", "移动", -18],
  ["plus", "添加", 54], ["arrows-pointing-in", "适应", 126],
  ["arrow-uturn-left", "撤销", 198],
];
const RADIAL_R = 96;
const RADIAL_DEAD = 18;      /* 中心死区：小于此距离不选中任何楔子（取消手势） */
const LOCK_SLOP = 8;         /* 长按期间的抖动容差：位移不超过它就不算「在拖」 */
let radialTimer = null, radialArmed = false, hotWedge = null;
let radialOrigin = { x: 0, y: 0 };
let radialLock = { x: 0, y: 0 };
let panActive = false;

function armRadial(p) {
  clearTimeout(radialTimer);
  radialTimer = setTimeout(() => showRadial(p), 280);
}

function cancelRadialArm() {
  clearTimeout(radialTimer);
  radialTimer = null;
}

function showRadial(p) {
  radialArmed = true; radialOrigin = p; hotWedge = null; radialTimer = null;
  const wedges = RADIAL_ITEMS.map(([ico, label, deg]) => {
    const a = (deg * Math.PI) / 180;
    const wx = Math.cos(a) * RADIAL_R, wy = Math.sin(a) * RADIAL_R;
    /* interactivity.md：过渡动画只给位移/变换，颜色变化不加
       （注意别把类名字面量写进注释——Tailwind 扫描器会照字面编译出死规则） */
    return `<span data-deg="${deg}" data-label="${label}" style="--wx:${wx}px;--wy:${wy}px"
      class="absolute top-1/2 left-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2
      translate-x-(--wx) translate-y-(--wy) place-items-center rounded-full
      bg-white shadow-sm ring-1 ring-neutral-950/10
      dark:bg-neutral-800 dark:shadow-none dark:ring-white/10">
      ${icon(ico, "size-4 shrink-0 fill-neutral-600 dark:fill-neutral-300")}</span>`;
  }).join("");
  radialEl.innerHTML = `<span class="absolute top-1/2 left-1/2 grid size-8
    -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full
    bg-neutral-950 shadow-lg
    dark:bg-neutral-800 dark:shadow-none dark:inset-ring dark:inset-ring-white/5"
    >${icon("x-mark", "size-4 shrink-0 fill-white")}</span>${wedges}`;
  radialEl.style.setProperty("--rx", p.x + "px");
  radialEl.style.setProperty("--ry", p.y + "px");
  radialEl.classList.remove("hidden");
  radialEl.classList.add("block");
}

function hideRadial() {
  radialArmed = false; hotWedge = null;
  radialEl.classList.add("hidden");
  radialEl.classList.remove("block");
}

/* 按方向挑最近扇区——以菜单中心为圆心，不依赖元素自身的 clickable 区域 */
function wedgeByDirection(dx, dy) {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  let best = null, bestDelta = Infinity;
  radialEl.querySelectorAll("[data-deg]").forEach((w) => {
    let delta = Math.abs(((Number(w.dataset.deg) - deg + 540) % 360) - 180);
    if (delta < bestDelta) { bestDelta = delta; best = w; }
  });
  return best;
}

function highlightWedge(dx, dy) {
  const best = wedgeByDirection(dx, dy);
  if (best !== hotWedge) {
    if (hotWedge) hotWedge.classList.remove("bg-emerald-600");
    if (best) best.classList.add("bg-emerald-600");
    hotWedge = best;
  }
}

/* 本原型不实现真实动作，只回执选中了什么，便于现场判断手感 */
function commitWedge(dx, dy) {
  const w = wedgeByDirection(dx, dy);
  if (!w) return;
  const tip = document.getElementById("radialTip");
  if (tip) { tip.textContent = "径向选中：" + w.dataset.label; tip.classList.remove("hidden"); }
}

/* ---------- 指针交互 ---------- */
const pointers = new Map();
let mode = null, drag = null, pinchStart = null;
const toCanvas = (p) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#switcher, #chromeA, #chromeB, #radial")) return;
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
    mode = "pinch"; return;
  }

  const handle = e.target.closest("[data-handle]");
  const regionEl = e.target.closest(".region");

  if (handle && regionEl) {
    const r = REGIONS.find((q) => q.id === regionEl.dataset.id);
    drag = { id: r.id, kind: "resize", pos: handle.dataset.handle,
             sx: r.x, sy: r.y, sw: r.w, sh: r.h, px: e.clientX, py: e.clientY };
    mode = "resize"; setSelected(r.id); return;
  }
  if (regionEl) {
    const r = REGIONS.find((q) => q.id === regionEl.dataset.id);
    const p = toCanvas({ x: e.clientX, y: e.clientY });
    drag = { id: r.id, kind: "drag", sx: r.x, sy: r.y, px: p.x, py: p.y };
    mode = "drag"; setSelected(r.id); return;
  }

  if (current === "C") {
    /* 长按唤出径向：与平移是同一根手指，所以必须等到动了才取消计时。
       抖动容差 LOCK_SLOP 之内的位移不算「移动」。 */
    const p = { x: e.clientX, y: e.clientY };
    radialLock = { x: p.x, y: p.y };
    armRadial(p);
  }
  mode = "pan";
  drag = { kind: "pan", vx: view.x, vy: view.y, px: e.clientX, py: e.clientY };
  setSelected(null);
  viewport.classList.add("cursor-grabbing");
});

viewport.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (mode === "pinch" && pointers.size >= 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2,
      Math.min(4, Math.max(0.15, pinchStart.k * (d / pinchStart.dist))));
    return;
  }

  /* 径向已唤出：以菜单中心为圆心做方向选择，忽略全局坐标的抖动 */
  if (radialArmed) {
    const dx = e.clientX - radialOrigin.x;
    const dy = e.clientY - radialOrigin.y;
    if (Math.hypot(dx, dy) >= RADIAL_DEAD) highlightWedge(dx, dy);
    return;
  }

  if (mode === "pan" && drag) {
    /* 只有在超过抖动容差时才算真的在平移；之前一直等长按计时 */
    if (!panActive) {
      const moved = Math.hypot(e.clientX - radialLock.x, e.clientY - radialLock.y);
      if (moved < LOCK_SLOP) return;      /* 还没动，让长按计时继续跑 */
      cancelRadialArm();                   /* 真的在拖了，长按作废 */
      panActive = true;
    }
    view.x = drag.vx + (e.clientX - drag.px);
    view.y = drag.vy + (e.clientY - drag.py);
    applyView();
    return;
  }
  if (mode === "drag" && drag) {
    const p = toCanvas({ x: e.clientX, y: e.clientY });
    const r = REGIONS.find((q) => q.id === drag.id);
    r.x = drag.sx + (p.x - drag.px);
    r.y = drag.sy + (p.y - drag.py);
    setRegionBox(r); return;
  }
  if (mode === "resize" && drag) {
    const r = REGIONS.find((q) => q.id === drag.id);
    const dx = (e.clientX - drag.px) / view.k;
    const dy = (e.clientY - drag.py) / view.k;
    const { sx, sy, sw, sh, pos } = drag;
    if (pos.includes("e")) r.w = Math.max(60, sw + dx); else r.w = sw;
    if (pos.includes("s")) r.h = Math.max(50, sh + dy); else r.h = sh;
    if (pos.includes("w")) { r.w = Math.max(60, sw - dx); r.x = sx + (sw - r.w); } else r.x = sx;
    if (pos.includes("n")) { r.h = Math.max(50, sh - dy); r.y = sy + (sh - r.h); } else r.y = sy;
    setRegionBox(r); return;
  }
});

function endPointer(e) {
  if (radialArmed) {
    /* 提交当前高亮的楔子（若指针正落在某个楔子上） */
    const dx = e.clientX - radialOrigin.x;
    const dy = e.clientY - radialOrigin.y;
    if (Math.hypot(dx, dy) >= RADIAL_DEAD) commitWedge(dx, dy);
    hideRadial();
  }
  cancelRadialArm();
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    mode = null; drag = null; panActive = false;
    viewport.classList.remove("cursor-grabbing");
  }
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY,
    Math.min(4, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015))));
}, { passive: false });

/* 右键菜单一律拦掉：画布上没有原生右键语义，弹出浏览器菜单只会打断手势。
   样式层面的禁选中在 input.css 的 #app 上；这里是行为层面。 */
document.addEventListener("contextmenu", (e) => e.preventDefault());

function zoomAt(cx, cy, k) {
  const p = toCanvas({ x: cx, y: cy });
  view.k = k;
  view.x = cx - p.x * k;
  view.y = cy - p.y * k;
  applyView();
  setZoomLabel();
}

viewport.addEventListener("dblclick", (e) => {
  if (e.target.closest(".region")) return;
  const k = Math.min(viewport.clientWidth / 1400, viewport.clientHeight / 900);
  view.k = k;
  view.x = (viewport.clientWidth - 1400 * k) / 2;
  view.y = (viewport.clientHeight - 900 * k) / 2;
  applyView();
  setZoomLabel();
});

/* ---------- 变体切换 ---------- */
function setVariant(v) {
  current = VARIANTS[v] ? v : "A";
  document.getElementById("chromeA").classList.toggle("hidden", current !== "A");
  document.getElementById("chromeB").classList.toggle("hidden", current !== "B");
  if (current !== "C") hideRadial();

  const m = VARIANTS[current];
  document.getElementById("vname").textContent = current;
  document.getElementById("vnote").textContent = m.name + " · " + m.note;

  setSelected(selected);
  setZoomLabel();

  const url = new URL(location.href);
  url.searchParams.set("variant", current);
  history.replaceState(null, "", url);
}

function step(d) {
  const i = ORDER.indexOf(current);
  setVariant(ORDER[(i + d + ORDER.length) % ORDER.length]);
}

function buildSwitcher() {
  /* 原型工具：不属于被评审的设计，故意用高对比黑胶囊把它和页面区分开 */
  const nav = "bg-white/10 text-white hover:bg-white/25 dark:bg-white/10";
  document.getElementById("switcher").innerHTML =
    `${iconBtn("chevron-left", "上一个变体", "sm", nav, "size-4 shrink-0 fill-white")}
     <span class="whitespace-nowrap"><b id="vname" class="font-semibold">A</b>
     <span id="vnote" class="text-neutral-400"></span></span>
     ${iconBtn("chevron-right", "下一个变体", "sm", nav, "size-4 shrink-0 fill-white")}`;
  const btns = document.getElementById("switcher").querySelectorAll("button");
  btns.forEach((b, i) => (b.onclick = () => step(i === 0 ? -1 : 1)));
}

addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

/* ---------- 启动 ---------- */
buildRegions();
buildChromeA();
buildChromeB();
buildSwitcher();
applyView();
setVariant(new URLSearchParams(location.search).get("variant") || "A");
