/* ===========================================================================
   几何：摆放的全部算法。纯函数，输入输出都是数字。
   ===========================================================================
   这里只回答两个问题——「一份东西默认该多大」和「几份东西怎么摊开」。

   数字不是审美参数。按 1440×900 的视野复算 A4@300dpi（2480×3508）：
   SHARE.w = 0.42 给出 1041px 的上限、SHARE.h = 0.6 给出 540px 的上限，
   取小的等比收下就是 382×540；第一份的短边 382 乘 STEP_SHARE = 0.14
   是 53.5，收进 [28, 72] 里得 53。这三个数与 ADR-0017 那张表逐位吻合，
   改它们就是改一篇 accepted ADR 的论证基础。 */
import type { Bounds, Region, Size, View } from "./types";

/* 写这一层时踩到过的一个坑，与算法无关：Tailwind v4 的扫描器读的是**原始
   文本**，不是 AST。所以中文注释里一个孤立的英文单词会被当成工具类，真的
   生成一条 CSS 规则（还顺带拖进一串 @property）。眼下产物多出 1.2 kB 就是
   这么来的。往这几个文件写注释时，别留下裸露的英文类名。 */

/* ---------- 默认大小与摊开方式 ----------
   这两个参数一起决定「丢进来之后屏幕上是什么样」，不是审美偏好：1440×900
   的屏上并排放三份 1000×700 的纸，第一份占掉七成宽，第二、三份整个在
   屏外。操作者看到的是一张纸加一句「已投放 3 份」——那份回执是真的，
   屏上却没东西。 */

/** 一份资源默认最多占视野的多大一块。等比缩，字不会被拉变形。 */
export const SHARE = { w: 0.42, h: 0.6 };

/** 相邻两份错开的步长（相对第一份的短边），封在 28–72px。
    太小看不出是两份，太大后面几份就甩出屏外。 */
export const STEP_SHARE = 0.14;
export const STEP_MIN = 28;
export const STEP_MAX = 72;

/** 默认大小：等比缩到视野的一个份额以内，**不放大**。
    不放大是因为插值出来的字是糊的，而这份资料等下还要投到大屏上看——
    为了摆得好看先放大，等于提前毁掉它（ADR-0008）。 */
export function fitInto(b: Bounds | undefined, w: number, h: number): Size {
  if (!b) return { w, h };
  const k = Math.min(1, ((b.maxX - b.minX) * SHARE.w) / w, ((b.maxY - b.minY) * SHARE.h) / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** 错开步长。取的是**第一个被收下的**的**收拢后**尺寸，不是自然尺寸，
    也不是最小的那一份——第一份是操作者最先看到的，它决定了这个步长读起来
    是「错开」还是「乱堆」。

    一份都没收下时返回 0：那时下面整叠收拢那一步什么都不用做。 */
export function cascade(first: Size | undefined): number {
  if (!first) return 0;
  return Math.min(STEP_MAX, Math.max(STEP_MIN, Math.round(Math.min(first.w, first.h) * STEP_SHARE)));
}

/** 整叠收拢：最右/最下那块出屏了，整叠一起退回来。**只动新内容，
    绝不碰相机**——相机只归操作者（不变量 #1）。

    边界按**整叠里最靠外的那一项**算，不是按最后那项。早先只看
    `sizes[sizes.length - 1]`，而异尺寸多份丢在边缘时最后那项往往最小：
    投 `[PDF(收后 605×423), 小图(100×100)]` 到 1440px 视野的 x=1300 处，
    那样算出来 right = 1300 + 59 + 100 = 1459、dx = -19，可第一份真正的
    右边缘是 1300 + 605 = 1905，收拢后仍有 446px 在屏外。丢了一半资料在
    屏幕外，操作者会以为没投进来——而回执明明写着收下了。

    `cascade` 的步长定义的正是这一叠的摊开形状，所以收拢必须按**同一个
    形状**算，不能只看其中一项。这个修复推迟到产品投放链路那一步（简报
    §4 步骤 5）单独落，好让「重构」和「改行为」不混进同一个 diff。 */
export function collapse(
  sizes: Size[],
  anchor: { x: number; y: number },
  step: number,
  bounds: Bounds | undefined,
): { dx: number; dy: number } {
  let dx = 0, dy = 0;
  if (bounds && sizes.length) {
    /* 右/下边界要按**整叠里最靠外的那一项**算，不是最后那项。
       异尺寸多份丢在边缘时，最后那项往往最小：投
       `[PDF(收后 605×423), 小图(100×100)]` 到 1440px 视野的 x=1300 处，
       只看最后一项会算 right = 1300 + 59 + 100 = 1459 得 dx = -19，
       而第一份真正的右边缘是 1300 + 605 = 1905，收拢后仍有 446px 在屏外。
       丢了一半资料在屏幕外，操作者会以为没投进来——而回执明明说收下了。

       所以取全部项的 max。`cascade` 的步长也正是「整叠的摊开形状」，
       收拢必须按同一个形状算。 */
    let right = anchor.x;
    let bottom = anchor.y;
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i]!;
      right = Math.max(right, anchor.x + i * step + s.w);
      bottom = Math.max(bottom, anchor.y + i * step + s.h);
    }
    if (right > bounds.maxX) dx = bounds.maxX - right;
    if (anchor.x + dx < bounds.minX) dx = bounds.minX - anchor.x;
    if (bottom > bounds.maxY) dy = bounds.maxY - bottom;
    if (anchor.y + dy < bounds.minY) dy = bounds.minY - anchor.y;
  }
  return { dx, dy };
}

/* ---------- 内容包围盒 ---------- */
export function boxOf(regions: Region[]): { x: number; y: number; w: number; h: number } {
  /* 空数组守卫。`Math.min()` 空数组给 Infinity，配上 `Math.max()` 的
     -Infinity，w/h 会算成 -Infinity —— 那是能一路传到 transform 里的
     一个数。取景 effect 恰好有一道 `!regions.length` 的提前 return 挡着，
     但那是调用点的一道 if，不该由数学函数自己不做。 */
  if (!regions.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = regions.map((r) => r.x), ys = regions.map((r) => r.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {
    x, y,
    w: Math.max(...regions.map((r) => r.x + r.w)) - x,
    h: Math.max(...regions.map((r) => r.y + r.h)) - y,
  };
}

/** 按**这一屏真正画了哪些块**算包围盒——切碎后的子块不在 SAMPLE 里。
 *
 *  zoom 为 null = 适应画布，且**不超过 1:1**。整份资料原样摆开时放大没有
 *  意义，1:1 就是它的上限。
 *
 *  fill = 铺满。用于「只投一块出去」：那一块就该占满整块屏，字不用拉伸
 *  就清楚了。早先这里只有 zoom 一个参数，单块那屏被 1:1 夹住，演示出来
 *  恰恰是这条论点的反例——一小块内容孤零零待在屏幕中间。 */
export function fitView(
  regions: Region[],
  vp: { w: number; h: number },
  zoom: number | null,
  fill = false,
): View {
  const b = boxOf(regions);
  /* 96 / 60 照抄，改成 rem 是 #12 的活（brief §8-6）。提前改会让那张
     diff 难审：现在要审的是「有没有人动过这个数」，不是「rem 换算对不对」。 */
  const pad = 96, padTop = 60;
  const fit = Math.min((vp.w - pad * 2) / b.w, (vp.h - pad * 2 - padTop) / b.h);
  const k = zoom ?? (fill ? fit : Math.min(1, Math.max(0.2, fit)));
  return {
    k,
    x: (vp.w - b.w * k) / 2 - b.x * k,
    y: (vp.h - b.h * k) / 2 - b.y * k,
  };
}
