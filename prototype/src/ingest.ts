/* ===========================================================================
   投放的落点计算：纯函数，没有网络、没有 DOM、没有 React。
   ===========================================================================
   分层是硬规矩：**网络往返在 api.ts，落点计算在这里。** 早先原型里两者
   混在一个 `ingestFiles` 里，于是「摆在哪」这件事没法单独验——只能拖一
   个真文件进浏览器看结果。分开之后这一层的每个数字都能被纯函数测试钉住。

   ## 两阶段：先量后摆

   边收边摆的话，第 i 份的落点依赖第 i-1 份的尺寸，而尺寸又随收拢结果变
   ——排到一半发现第一步收过头，后面全歪。所以先把整叠量出来（fitInto），
   再一次性定步长与收拢位移，最后才落坐标。

   这一层**不碰相机**。收拢只动新内容，相机只归操作者（不变量 #1）。 */
import { cascade, collapse, fitInto } from "./geometry";
import type { Bounds, Region, Size } from "./types";
import type { AcceptedItem } from "./types";

/** 一份可以摆放的收下项。`id` 已经是 `${artifactId}#${regionId}`。 */
export type Placed = {
  /** **服务端生成**，全画布唯一。绝不能是「第几次投放的第几块」——
      那样第二次投放就会撞出第二个 a1，key 重复、React 静默复用块、
      `[data-id="a1"]` 选中两个。 */
  id: string;
  /** 角标上的文件名（该资源首次登记时的名字，ADR-0015） */
  name: string;
  /** 页位图的自然像素尺寸。摆多大是 fitInto 按视野份额定的，不是它。 */
  pixel: Size;
  page: number;
  /** 区域位图的相对路径。物化成 blob: URL 是 RegionImage 的事。 */
  bitmapPath: string;
};

/** 从回执里挑出**真正要新摆**的那些。
    `alreadyPresent` 的跳过在这里，不在渲染层：同一份内容再投一次不新增
    区域、不移动已有区域（ADR-0015），而回执里已经说了「已在画布上」。 */
export function placable(items: AcceptedItem[]): Placed[] {
  return items
    .filter((it) => !it.alreadyPresent)
    .map((it) => ({
      id: it.region.id,
      name: it.displayName,
      pixel: it.region.pixel,
      page: it.region.page,
      bitmapPath: it.region.bitmapUrl,
    }));
}

/** 摆放。
    `anchor` = 松手那一刻光标所在的**画布坐标**（不是屏幕坐标）。
    `bounds` = 当前视野在画布坐标下的矩形；没有时不做收拢。

    多份**依次向右下角摊开**，像把一叠纸在桌面上错开：第 i 份比第 i-1 份
    右下各错开一个步长（ADR-0013）。错开之后每份都露出一角和角标上的
    文件名，一眼能数清投了几份、是哪几份；并排则永远只有第一份在屏内。

    收拢按**整叠**算，不按单份：单份收拢会把「依次错开」压回并排，恰好
    毁掉这一屏要证明的事。收拢只动新内容，绝不碰相机。 */
export function placeRegions(
  verdicts: Placed[],
  anchor: { x: number; y: number },
  bounds?: Bounds,
): Region[] {
  /* ---- 阶段一：量。整叠量完再谈落点。 */
  const sizes: Size[] = verdicts.map((v) => fitInto(bounds, v.pixel.w, v.pixel.h));

  /* 步长由**第一项收拢后的**短边算出并封顶在 28–72px（ADR-0013/0017）——
     第一份是操作者最先看到的，它决定了这个步长读起来是「错开」还是「乱堆」。 */
  const step = cascade(sizes[0]);
  const { dx, dy } = collapse(sizes, anchor, step, bounds);

  /* ---- 阶段二：摆。 */
  return verdicts.map((v, i) => {
    const s = sizes[i]!;
    return {
      id: v.id,
      x: anchor.x + i * step + dx,
      y: anchor.y + i * step + dy,
      w: s.w,
      h: s.h,
      page: v.page,
      /* 文件名是**显示属性**，不参与任何相等判断（ADR-0015） */
      artifact: v.name,
      /* 语义单元是 #8 的活。#4 的产品路径恒为 null——这里不许造。 */
      unit: null,
      bitmapPath: v.bitmapPath,
    } satisfies Region;
  });
}

/* ---------- 闸门（拖拽路径） ----------
   `accept="image/*"` **只影响选择器**：拖拽完全绕过它。所以闸门必须在
   drop 处理器里，picker 与 drop 两条路径共用同一个判断——否则「点一下选
   文件」和「拖进来」对同一个 .docx 给出两种不同的待遇。

   这里只镜像服务端**按扩展名**判的那一支（`ingest.py` 的 `_EXT_GATES`
   与 `.pdf` 那一支）。**刻意不按内容判**：一个叫 `截图` 的文件没有扩展名
   但内容是 PNG，客户端按扩展名拒它就是错判，而服务端 Pillow 探针会收下
   它。体积、像素数、损坏这些只有真读一遍文件才知道的，一律交给服务端。

   改这张表时同步改 `server/bscp/ingest.py` 的 `_EXT_GATES`，反之亦然。 */
const DOCX_EXT = /\.(docx?|rtf|wps|odt)$/i;

export type Gate =
  | { pass: true }
  | { pass: false; code: string; params: Record<string, string | number> };

export function clientGate(file: File): Gate {
  const name = file.name || "未命名";
  if (DOCX_EXT.test(name)) return { pass: false, code: "docx_not_supported", params: { filename: name } };
  if (/\.pdf$/i.test(name)) return { pass: false, code: "pdf_rasterizer_pending", params: { filename: name } };
  return { pass: true };
}

/** 本地闸门判掉的那些，**和**服务端回执里的拒收项，同一个形状。
    回执因此永远是「一次投放里逐个点名」，两条来源在渲染层没有区别。 */
export type LocalReject = { clientKey: string; code: string; params: Record<string, string | number>; bytes: number };

export function gateFile(file: File, key: string): LocalReject | null {
  const g = clientGate(file);
  return g.pass ? null : { clientKey: key, code: g.code, params: g.params, bytes: file.size };
}
