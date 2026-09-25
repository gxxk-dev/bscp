/* ===========================================================================
   画布
   ===========================================================================
   手指在一体机上做的事只有四件：拖一块、拖一组、双指缩放、空白处平移。
   这四件全在这一个组件里，且都不许「帮」操作者——没有吸附、没有对齐线、
   没有推荐位置。AI 从不摆放（ADR-0010），所以这里也没有任何相关代码。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { fitView } from "./model";
import type { Board, Region, View } from "./model";
import { SourceBadge, UnitTag } from "./ui";

const HANDLE = {
  nw: "-top-1.5 -left-1.5 cursor-nwse-resize",
  ne: "-top-1.5 -right-1.5 cursor-nesw-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-neswse-resize",
  se: "-bottom-1.5 -right-1.5 cursor-neswse-resize",
} as const;

export function Canvas(props: {
  board: Board;
  /** null = 适应画布；数字 = 固定缩放倍率 */
  zoom: number | null;
  /** 这一屏要不要把内容铺满。只在「只投一块出去」时为真。 */
  fill?: boolean;
  /** 每次 +1 就放弃操作者手动调过的视野，回到自动居中 */
  fitNonce: number;
  interactive: boolean;
  onBoard: (b: Board) => void;
  onSelect: (id: string | null) => void;
}) {
  const { board, zoom, fill, fitNonce, interactive, onBoard, onSelect } = props;
  const vp = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** 取当前两指的坐标；不足两指返回 null */
  const twoFingers = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? ([a, b] as const) : null;
  };
  const drag = useRef<null | {
    kind: "drag" | "pan";
    start: { x: number; y: number };
    from: View;
    parts: { id: string; x: number; y: number }[];
  }>(null);
  const pinch = useRef<{ dist: number; k: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  /* 正在被拖的块。拿起来要看得出来——没有这一层，手指和眼睛对不上，
     「手感」就无从谈起。不用缩放：缩放会让块的边跟着动，落点反而变难瞄。 */
  const [lift, setLift] = useState<string[]>([]);

  /* ---------- 相机 ----------
     相机的唯一所有者是操作者。早先这里把 board.regions 放进依赖里，
     于是拖一块 → regions 变 → 重新居中 → 每一帧画面都在手底下滑动。
     那不是手感问题，那是相机在跟操作者抢方向。

     所以自动取景只认两种触发：
       - 换屏（fitNonce 变）——演示脚手架切到另一条路径，等于换了一份资料
       - 按「适应画布」——操作者明确要求的
     拖动、投放、增删区域一律不动相机。 */
  const [fit, setFit] = useState<View>({ x: 0, y: 0, k: 1 });
  const [live, setLive] = useState<View | null>(null);
  const view = live ?? fit;

  useLayoutEffect(() => { setLive(null); }, [fitNonce]);
  useLayoutEffect(() => {
    const r = vp.current?.getBoundingClientRect();
    if (!r || !board.regions.length) return;
    setFit(fitView(board.regions, { w: r.width, h: r.height }, zoom, fill));
  }, [fitNonce, zoom, fill]);

  const onView = useCallback((v: View) => setLive(v), []);

  const toCanvas = useCallback(
    (x: number, y: number) => {
      const r = vp.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: (x - r.left - view.x) / view.k, y: (y - r.top - view.y) / view.k };
    },
    [view],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    vp.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const pair = twoFingers();
      if (!pair) return;
      pinch.current = {
        dist: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y),
        k: view.k,
      };
      return;
    }

    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (el?.dataset.id) {
      const r = board.regions.find((q) => q.id === el.dataset.id);
      if (!r) return;
      /* 整组拖动：拖组里任意一块 → 同组的一起走。组是「语义单元」，
         所以这一下带走的是「一道题的题干图选项」。 */
      const parts = r.unit ? board.regions.filter((q) => q.unit === r.unit) : [r];
      const p = toCanvas(e.clientX, e.clientY);
      drag.current = {
        kind: "drag", start: p, from: view,
        parts: parts.map((q) => ({ id: q.id, x: q.x, y: q.y })),
      };
      onSelect(r.id);
      setLift(parts.map((q) => q.id));
      return;
    }
    drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, from: view, parts: [] };
    onSelect(null);
    setGrabbing(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pair = twoFingers();
    if (pinch.current && pair) {
      const [a, b] = pair;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2,
        clamp(pinch.current.k * (d / pinch.current.dist)));
      return;
    }
    const g = drag.current;
    if (!g) return;

    if (g.kind === "pan") {
      onView({ ...g.from, x: g.from.x + (e.clientX - g.start.x), y: g.from.y + (e.clientY - g.start.y) });
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    /* 一次算清整组的位移再落盘，逐块累加的话组里第二块会吃到第一块
       刚写进去的坐标，拖得越多偏得越远。顺序保持不变——区域的绘制
       顺序要跟着模型走，不能因为谁被拖过就重排。 */
    const shift = new Map(g.parts.map((q) => [q.id, { x: q.x + dx, y: q.y + dy }]));
    onBoard({
      ...board,
      regions: board.regions.map((r) => {
        const s = shift.get(r.id);
        return s ? { ...r, x: s.x, y: s.y } : r;
      }),
      touched: [...new Set([...board.touched, ...g.parts.map((q) => q.id)])],
    });
  }

  function endPointer(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) { drag.current = null; setGrabbing(false); setLift([]); }
  }

  function zoomAt(cx: number, cy: number, k: number) {
    const r = vp.current?.getBoundingClientRect();
    if (!r) return;
    const p = { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    onView({ k, x: cx - r.left - p.x * k, y: cy - r.top - p.y * k });
  }
  const clamp = (k: number) => Math.min(4, Math.max(0.15, k));

  /* 滚轮必须 preventDefault 才能阻止页面跟着滚。React 把 onWheel 挂在根上
     且是 passive 的，处理器里调 preventDefault 不生效——所以这里手挂一个
     非 passive 的原生监听。 */
  useEffect(() => {
    const el = vp.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, clamp(view.k * Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomAt / clamp 每次渲染都是新引用，这里只关心「挂上时用的那套 view」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, view.k, view.x, view.y]);

  return (
    <div
      ref={vp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-id]")) setLive(null);
      }}
      className={`absolute inset-0 touch-none overflow-hidden
        ${interactive ? (grabbing ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`}
    >
      <div
        id="stage"
        className="absolute top-0 left-0 origin-top-left will-change-transform"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        {board.regions.map((r) => (
          <RegionBox
            key={r.id}
            r={r}
            selected={board.selected === r.id}
            pending={board.pending.includes(r.id)}
            grouped={board.groups && !!r.unit}
            badged={board.badges}
            handles={board.editing === r.id}
            lifted={lift.includes(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RegionBox(props: {
  r: Region;
  selected: boolean;
  pending: boolean;
  grouped: boolean;
  badged: boolean;
  handles: boolean;
  lifted: boolean;
}) {
  const { r, selected, pending, grouped, badged, handles, lifted } = props;
  /* general.md：同一属性不能挂两套互相覆盖的类。同一块若同时「未拍板」
     和「在某组里」，只画一层虚线，用颜色区分两种含义。 */
  const outline = grouped
    ? "outline-1 outline-dashed outline-emerald-400"
    : pending ? "outline-2 outline-dashed outline-neutral-400" : "";
  return (
    <div
      data-id={r.id}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      className={`region absolute rounded-(--radius) bg-white
        ${lifted ? "z-10 shadow-md" : "shadow-xs"}
        dark:bg-neutral-900 dark:shadow-none dark:inset-ring dark:inset-ring-white/5
        ${selected ? "ring-2 ring-emerald-600"
                  : "ring-1 ring-neutral-950/10 dark:ring-white/10"}
        ${pending ? "opacity-70" : ""} ${outline}`}
    >
      <div className="relative h-full overflow-hidden rounded-(--radius)">
        <div className="h-full p-3">{r.src ? <div className="h-full">{body(r)}</div> : body(r)}</div>
      </div>
      {handles &&
        Object.entries(HANDLE).map(([k, cls]) => (
          <span key={k} className={`absolute size-3.5 rounded-sm bg-white ring-1
            ring-emerald-600 dark:bg-neutral-900 ${cls}`} />
        ))}
      {grouped && r.unit && <UnitTag unit={r.unit} />}
      {badged && <SourceBadge page={r.page} />}
    </div>
  );
}

function body(r: Region) {
  if (r.src) {
    return <img src={r.src} alt="" className="size-full object-contain" draggable={false} />;
  }
  if (r.figure) {
    /* 图区不用图标充数：它代表的是原件里裁出来的一块图。
       画个大图标会让人误以为这块内容是我们生成的。 */
    return (
      <div className={`grid h-full place-items-center rounded-md border border-dashed
        border-neutral-950/15 text-neutral-400 dark:border-white/15 dark:text-neutral-600`}>
        <p className="text-sm">原件中的图</p>
      </div>
    );
  }
  if (r.table) {
    return (
      <>
        <p className="mb-1.5 text-balance text-sm font-semibold">{r.title}</p>
        <table className="w-full border-collapse text-[0.6875rem]">
          <tbody>
            {r.table.map((row, i) => (
              <tr key={i} className="border-t border-neutral-950/10 first:border-t-0
                dark:border-white/10">
                {row.map((cell, j) => (
                  <td key={j} className={`py-1 pr-2 tabular-nums
                    ${i === 0 ? "font-medium text-neutral-500 dark:text-neutral-400" : ""}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  return (
    <>
      <p className="mb-2 text-balance text-sm font-semibold">{r.title}</p>
      {r.opts?.map((t) => (
        <p key={t} className="text-pretty text-sm text-neutral-600 dark:text-neutral-400">{t}</p>
      ))}
      {r.bars?.map((w, i) => (
        <div key={i} className={`my-1.5 h-1.5 rounded-sm bg-neutral-950/10 dark:bg-white/10 ${w}`} />
      ))}
    </>
  );
}
