/* ===========================================================================
   画布
   ===========================================================================
   手指在一体机上做的事只有四件：拖一块、拖一组、双指缩放、空白处平移。
   这四件全在这一个组件里，且都不许「帮」操作者——没有吸附、没有对齐线、
   没有推荐位置。AI 从不摆放（ADR-0010），所以这里也没有任何相关代码。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { camera } from "./camera";
import { fitView } from "./geometry";
import type { Board, Region, View } from "./types";
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
}) {
  const { board, zoom, fill, fitNonce, interactive, onBoard } = props;
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
     「手感」就无从谈起。不用 z-10：层次已经由 board.regions 的顺序
     管住了（拿起即前移），这里再叠一套 z-index 就是同一个属性两套真相，
     迟早又出现「松手掉回底层」那种前后不一。 */
  const [lift, setLift] = useState<string[]>([]);

  /* ---------- 相机 ----------
     相机的唯一所有者是操作者。早先这里把 board.regions 放进依赖里，
     于是拖一块 → regions 变 → 重新居中 → 每一帧画面都在手底下滑动。
     那不是手感问题，那是相机在跟操作者抢方向。

     所以自动取景只认两种触发：
       - 换屏（fitNonce 变）——演示脚手架切到另一条路径，等于换了一份资料
       - 按「适应画布」——操作者明确要求的
     拖动、投放、增删区域一律不动相机。

     相机本体在 camera.ts，投放路径同步读那一份。这里是它唯一的写者。

     渲染用的这份 view 留在组件状态里，**每次写 store 的同一个地方一起写
     它**。曾经试过 useSyncExternalStore 直接订阅 store：语义更干净，但它
     把首屏的副作用时机推后了一帧——React 的订阅检查排在一次独立的调度
     任务里，于是「导航刚结束就按 Esc」时按键落在监听器挂上之前，退不出
     投屏（冒烟第 8 段红，实测监听器挂上从 ~4ms 推到 7–17ms）。改成
     在同一批处理器里同步写两份，渲染时序回到改动前，投屏路径读到的仍然
     是同一个 store 对象、不晚一帧。 */
  const [view, setView] = useState<View>(camera.getView());
  /** 写相机：store 与渲染状态在同一步里落，不存在一边新一边旧的中间态。 */
  const publish = (v: View) => { camera.setLive(v); setView(v); };

  /* 取景要读 regions，但依赖里**不许**有它。ref 让体内能读到最新一次，
     依赖表保持 [fitNonce, zoom, fill] —— 那三个是操作者（或换屏）明确
     要求的取景触发，regions 变不是。真接服务端后投放要等一次网络往返，
     很容易顺手把 regions 塞进依赖「保证投进来可见」：那就是自动取景、
     相机抢方向，AC 直接红。 */
  const regionsRef = useRef(board.regions);
  useLayoutEffect(() => { regionsRef.current = board.regions; });

  /* 自动取景这两步都只认 fitNonce/zoom/fill 三个触发。写完 store 要把
     渲染状态拨到 store 当前的值——releaseLive 可能让生效的视野从手动
     退回自动，而 setFit 又可能把自动那份换掉，两者都只改 store。 */
  useLayoutEffect(() => { camera.releaseLive(); }, [fitNonce]);
  useLayoutEffect(() => {
    const r = vp.current?.getBoundingClientRect();
    if (r && regionsRef.current.length) {
      camera.setFit(fitView(regionsRef.current, { w: r.width, h: r.height }, zoom, fill));
    }
    setView(camera.getView());
  }, [fitNonce, zoom, fill]);

  /* 把视口元素登记给 camera，量 rect 的时机由读的人决定（见 camera.ts）。
     投放路径读的就是这个元素，不缓存、不监听尺寸变化。 */
  useEffect(() => {
    camera.attach(vp.current);
    return () => camera.attach(null);
  }, []);

  /* 画布不可操作时把手上的块撤掉。早先 lift 只在 pointerup 清，于是投屏
     或对话框把画布锁住之后，先前拿起的那块还挂着 shadow——投屏态要求零
     操作痕迹，那道阴影就是痕迹。

     lift.length 那道守卫是为了不在挂载时就调一次没用的 setState（投屏态
     挂载时 lift 本来就是空的）。顺带说一句：它**不是**「Esc 退不出投屏」
     那个故障的修法——实测单独加它没有任何用，那条路径的问题在上面的
     相机订阅时机上。留它是因为清一次空数组没好处。 */
  useEffect(() => {
    if (!interactive && lift.length) setLift([]);
  }, [interactive, lift]);

  const toCanvas = camera.toCanvas;

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    vp.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const pair = twoFingers();
      if (!pair) return;
      /* 第二根手指落下时，之前那次拖动就此结束。
         早先不清的后果有两条，都很隐蔽：
           1. 那块既被算进拖动又被算进双指缩放；缩放收尾只剩一根手指时
              drag 还指着它，操作者「缩放完了」手一移就把那块甩走。
           2. 更糟的是那次 pointerdown 已经把 board.regions 的顺序改过了
              （拿起即前移）——以块为起点的双指缩放会**永久**改掉层次，
              而画面上没有任何东西提示为什么。
         lift 不用在这里清：pointerup 时指针数归零会顺带清掉。 */
      drag.current = null;
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
      /* 拿起哪一块，哪一块就前移，而且**留着**。
         层次就是 board.regions 的渲染顺序，所以把这几块挪到数组末尾
         就是抬到最上层——写在模型里，不写在 CSS 里。

         早先只有拖动期间的一句 z-10，松手就撤：块按下去浮起来，一松
         又沉回原来的层次，底下压着的还是刚才那块。看着像橡皮筋回弹，
         实际上手已经把它放到上面去了，两者对不上，下一次拖别的块时
         视觉上就错了。层次要么不临时变，要么别变。

         选中写进同一次 onBoard。早先选中走的是第二条通道 onSelect，
         而它读的是本次事件之前的 board 快照——同一点击里后写的把先
         写的重排整个盖掉，层次于是纹丝不动。 */
      const ids = new Set(parts.map((q) => q.id));
      onBoard({
        ...board,
        selected: r.id,
        regions: [...board.regions.filter((q) => !ids.has(q.id)), ...parts],
      });
      setLift(parts.map((q) => q.id));
      return;
    }
    drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, from: view, parts: [] };
    onBoard({ ...board, selected: null });
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
      publish({ ...g.from, x: g.from.x + (e.clientX - g.start.x), y: g.from.y + (e.clientY - g.start.y) });
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    /* 一次算清整组的位移再落盘，逐块累加的话组里第二块会吃到第一块
       刚写进去的坐标，拖得越多偏得越远。层次在拿起时就定了（见
       onPointerDown），拖动过程只改坐标，不再动顺序。 */
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
    publish({ k, x: cx - r.left - p.x * k, y: cy - r.top - p.y * k });
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
        if (!(e.target as HTMLElement).closest("[data-id]")) { camera.releaseLive(); setView(camera.getView()); }
      }}
      id="canvas"
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
        ${lifted ? "shadow-md" : "shadow-xs"}
        dark:bg-neutral-900 dark:shadow-none dark:inset-ring dark:inset-ring-white/5
        ${selected ? "ring-2 ring-emerald-600"
                  : "ring-1 ring-neutral-950/10 dark:ring-white/10"}
        ${pending ? "opacity-70" : ""} ${outline}`}
    >
      <div className="relative h-full overflow-hidden rounded-(--radius)">
        {/* 真实投放进来的位图**直接铺满 rect**，不套 p-3。
            区域是服务端裁出来的一块图（#4 恒等于整页，#5 起才是裁过的），
            裁切框就是它的全部内容；四周再留 12px 内边距等于在告诉评审者
            「这一块还有一部分没投出来」，而实际上没有。文字与表格分支
            仍然留 p-3——那些是示例排版，内边距是它们的一部分。 */}
        {r.src
          ? <img src={r.src} alt="" className="size-full" draggable={false} />
          : <div className="h-full p-3">{body(r)}</div>}
      </div>
      {handles &&
        Object.entries(HANDLE).map(([k, cls]) => (
          <span key={k} className={`absolute size-3.5 rounded-sm bg-white ring-1
            ring-emerald-600 dark:bg-neutral-900 ${cls}`} />
        ))}
      {grouped && r.unit && <UnitTag unit={r.unit} />}
      {badged && <SourceBadge artifact={r.artifact} page={r.page} />}
    </div>
  );
}

function body(r: Region) {
  /* 位图那一支已经上移到 RegionImage：它铺满 rect，不进 body 的排版分支。
     曾经 body 里有这一支、外层还包了一层 p-3，两处各画一次「图片怎么
     放进区域」的答案。 */
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
