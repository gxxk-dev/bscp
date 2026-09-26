/* ===========================================================================
   相机：全应用**唯一**一份「现在是哪块视野」。
   ===========================================================================
   为什么它不能是 Canvas 里的 useState：

   投放要知道「内容该放到哪」，于是 Canvas 得把视野告诉上层。早先这层
   通知是 `onViewChange` + 一个 `useEffect` 上报——两处病：

     1. **晚一帧。** useEffect 在提交之后才跑，「平移完立刻投放」这一下
        拿到的是上一帧的视野，锚点就偏了。投放是同步的：松手那一刻必须
        读得到当下这一刻的相机，不许有队列。
     2. **实际上从没接上。** App 一次都没传过这个 prop，所以 `view.current`
        恒为 `{0,0,1}`。±4px 锚点与边缘收拢这两条验收之所以在原型里过得了，
        纯粹是因为每次投放都从空画布起步、而空画布让取景 effect 提前
        return，把 fit 停在单位变换上。它是巧合，不是保证。

   所以相机是 store，Canvas 写、投放路径同步读——读的是同一个对象，
   不是一份上报的副本。

   自动取景仍然只认两个触发（换屏 / 「适应画布」），实现是 `live = null`
   让 `getView()` 退回 `fit`。**不要**把 regions 之类的东西接进取景的
   依赖：那不是「保证投进来可见」，那是相机跟操作者抢方向（不变量 #1）。 */
import type { Bounds, Rect, View } from "./types";

/* 身份视野。空画布下取景 effect 提前 return，fit 停在这里——所以这个
   初值必须与「什么都不做」在屏上完全一样。 */
const IDENTITY: View = { x: 0, y: 0, k: 1 };

/** 自动取景的结果：换屏或按「适应画布」时写。 */
let fit: View = IDENTITY;
/** 操作者手动调过的视野。非 null 时它盖住 fit。 */
let live: View | null = null;
/** 视口那个元素。量 rect 靠它——读的人要了才量。 */
let el: HTMLElement | null = null;

/* 相等就不写。视野在一帧里可能被反复 setLive（拖动、滚轮），
   相同的一律当无事发生，省掉下游的重新渲染。 */
const sameView = (a: View, b: View) => a.x === b.x && a.y === b.y && a.k === b.k;

/** 量视口矩形。**不缓存**。
    曾经缓存 + 挂一个窗口尺寸变化监听来作废它，两个理由都站不住：
      - 量 rect 是强制同步布局，而挂载那一刻正是首屏提交的关键路径，
        实测会把键盘监听器的挂上时刻从 ~4ms 推后一帧；
      - 读它的是投放，一次投放读两三次，不是每帧都读。缓存省不下什么，
        却要额外一个监听器去盯着它什么时候过期。
    所以：读的时候现量，量到的一定是当下的。 */
function measureRect(): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export const camera = {
  /** 当前生效的视野：操作者调过就用他的，没调过才用自动取景的结果。 */
  getView(): View {
    return live ?? fit;
  },

  /** 投放路径要的一把尺：视野 + 视口，同一个时刻的同一个对象。 */
  snapshot(): { view: View; rect: Rect | null } {
    return { view: live ?? fit, rect: measureRect() };
  },

  /** 自动取景。只由「换屏」和「适应画布」两个触发写。 */
  setFit(v: View): void {
    if (sameView(fit, v)) return;
    fit = v;
  },

  /** 操作者平移/缩放的结果。 */
  setLive(v: View): void {
    if (live && sameView(live, v)) return;
    live = v;
  },

  /** 放弃操作者手动调过的视野，退回自动取景。 */
  releaseLive(): void {
    if (!live) return;
    live = null;
  },

  /** 登记视口元素。量 rect 的时机由读的人决定，见 measureRect。 */
  attach(node: HTMLElement | null): void {
    el = node;
  },

  /** 屏幕坐标 → 画布坐标。没有视口矩形时（第一帧就投）退回 {0,0}：
      那时画布还没有原点可言，取整后的落点由 fitInto 的 Math.round 吸收。 */
  toCanvas(cx: number, cy: number): { x: number; y: number } {
    const r = measureRect();
    if (!r) return { x: 0, y: 0 };
    const v = live ?? fit;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  },

  /** 当前视野在画布坐标下的矩形——收拢的边界，不是内容包围盒。 */
  bounds(): Bounds | undefined {
    const r = measureRect();
    if (!r) return undefined;
    const v = live ?? fit;
    return {
      minX: -v.x / v.k,
      minY: -v.y / v.k,
      maxX: (r.width - v.x) / v.k,
      maxY: (r.height - v.y) / v.k,
    };
  },
};
