/* ===========================================================================
   话术：拒收码 → 中文文案，以及一次回执的结构化渲染。
   ===========================================================================
   分工是服务端定规矩、前端写句子（`server/bscp/errors.py` 的 docstring）：
   **拒绝理由是格式决定**（服务端权威），**句子是 UI 副本**。所以这里只
   拿到 `code + params`，不猜服务端为什么拒。

   两个纯函数，没有 React、没有网络，所以能被任何一层直接调。

   ## 为什么要结构化

   AC 写的是「回执**逐个点名**收了哪些、拒了哪些，**附文件名与体积**」。
   原型那个 `ingestToast` 只给收下那批的**合计**体积，拒收项一个字都没有
   ——操作者既不知道拒的是哪一份，也不知道它多大。混着投的时候那正是最
   需要的信息：四份里收了两份，他要知道是哪两份被拒了。

   所以这里返回 `Receipt`（每项一行，带文件名与体积），由 ProductApp 决定
   怎么摆到屏上。渲染与计算分开，是为了「回执说什么」这件事能被单独验。 */
import type { AcceptedItem, RejectedItem, VerdictItem } from "./types";

/** 体积。字节 → 一句人话。低于 1KB 至少说 1 KB：说「0 KB」像是空文件。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "体积未知";
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* 拒收码与 `server/bscp/ingest.py` 的 `REJECT_CODES` 一一对应。
   新增一个码而这里没跟上时，`rejectCopy` 会退到「未知」那一支——
   那一条必须存在，否则服务端换个码前端就白屏。 */
export const REJECT_CODES = [
  "docx_not_supported",
  "not_image_or_pdf",
  "pdf_rasterizer_pending",
  "pixel_count_exceeded",
  "empty_file",
  "corrupt_image",
  "file_too_large",
  "session_budget_exceeded",
] as const;

export type RejectCopy = { /** 为什么不收 */ reason: string; /** 怎么办 */ remedy: string };

const COPY: Record<string, (p: Record<string, string | number>) => RejectCopy> = {
  docx_not_supported: (p) => ({
    reason: `${p.filename ?? "这份文件"} 是 Word 文档，首版不收 Word。`,
    remedy: "在希沃里另存为 PDF，或截图后直接投。",
  }),
  not_image_or_pdf: (p) => ({
    reason: `${p.filename ?? "这份文件"} 不是图片也不是 PDF，首版只收这两种。`,
    remedy: "截图成图片再投。",
  }),
  /* #4 唯一挡 PDF 的码。#5 接上 PyMuPDF 就删掉这一支。
     措辞要说清「不是不支持 PDF，是这一版还没接栅格化」——否则操作者
     会以为首版没有 PDF。 */
  pdf_rasterizer_pending: (p) => ({
    reason: `${p.filename ?? "这份文件"} 是 PDF，这一版还没接上 PDF 栅格化。`,
    remedy: "在希沃里翻页截图再投，或者导出成图片。",
  }),
  pixel_count_exceeded: (p) => ({
    reason: `${p.filename ?? "这份文件"} 是 ${p.width}×${p.height}，超过 ${p.pixels ?? "—"} 像素的上限。`,
    remedy: `缩小到 ${Math.sqrt(Number(p.limit ?? 0) / 4) | 0}×${Math.sqrt(Number(p.limit ?? 0) / 4) | 0} 上下再投，清晰度不受影响。`,
  }),
  empty_file: (p) => ({ reason: `${p.filename ?? "这份文件"} 是空的。`, remedy: "换一份有内容的。" }),
  corrupt_image: (p) => ({
    reason: `${p.filename ?? "这份文件"} 打不开，文件可能是截断或损坏了。`,
    remedy: "重新导出或另存一份再投。",
  }),
  file_too_large: (p) => ({
    reason: `${p.filename ?? "这份文件"} 超过单份 ${formatBytes(Number(p.limit ?? 0))} 的上限。`,
    remedy: "缩小或拆开之后再投。",
  }),
  /* 服务端那台机器一次只握得住这么多页位图，所以这一轮到此为止。 */
  session_budget_exceeded: (p) => ({
    reason: `${p.filename ?? "这份文件"} 放不下了：这一次的准备已经占了 ${formatBytes(
      Number(p.held ?? 0),
    )}。`,
    remedy: "先点「重新开始」清掉这一轮，再重新投。",
  }),
};

/** 兜底。服务端加码而前端还没跟上时，操作者至少看到「没投上」和
    「可以重投」，而不是一句 undefined。 */
const UNKNOWN: (p: Record<string, string | number>) => RejectCopy = (p) => ({
  reason: `${p.filename ?? "这份文件"} 没投上（${p.code ?? "服务端没给理由"}）。`,
  remedy: "换一份再试。",
});

export function rejectCopy(code: string, params: Record<string, string | number>): RejectCopy {
  return (COPY[code] ?? UNKNOWN)(params);
}

/** `pixel_count_exceeded` 没带 filename（服务端那几个 params 只有尺寸），
    所以名字要由客户端那份 clientKey → File 的对应关系补上。 */
export function itemName(item: VerdictItem, local?: Map<string, string>): string {
  if (item.status === "accepted") return item.displayName;
  const p = item.params.filename;
  return (typeof p === "string" && p) || local?.get(item.clientKey) || "这份文件";
}

export type ReceiptLine = {
  /** 回执顺序即投放顺序 */
  key: string;
  name: string;
  bytes: number;
  ok: boolean;
  /** 这一份发生了什么。**不含文件名与体积**——那两样由 `name` / `bytes`
      单独给出，渲染时各出现一次。早期把三者拼进一句话，界面上又拼一遍，
      于是「月考卷.png 38 KB 月考卷.png（38 KB）」在屏上出现了两遍名字，
      而第四份那份完全看不出是哪一份被拒。 */
  text: string;
  /** 拒收时的出路。收下时为 null。 */
  remedy: string | null;
};

export type Receipt = {
  lines: ReceiptLine[];
  /** 这一批里**新摆上去**的份数。 */
  placed: number;
  /** 内容已在画布上、所以一块也没多的份数（ADR-0015）。
      **它不算「已投放」**：操作者看到「已投放 2 份」会以为画布上多了两块，
      而屏上那块一个像素都没动。两者混进同一个数，这张回执就在说谎。 */
  duplicates: number;
  rejected: number;
  /** 新摆上去那批的合计。与每项的体积一起给：合计回答「投了多少」，
      逐项回答「投的是哪几份」。重复的那几份不计入——它们的字节数描述的是
      一份**已经在那儿**的资源，不是这一批新增的。 */
  placedBytes: number;
};

function line(item: VerdictItem, local?: Map<string, string>): ReceiptLine {
  const name = itemName(item, local);
  if (item.status === "accepted") {
    /* 同一份内容再投一次：不新增区域、不移动已有区域（ADR-0015）。
       「已在画布上」要说出口——操作者看到「已投放 1 份」会以为多了一份，
       而屏上那块一个像素都没动。 */
    return {
      key: item.clientKey,
      name,
      bytes: item.bytes,
      ok: true,
      text: item.alreadyPresent
        ? "已在画布上，与已投的是同一份内容，没有新增"
        : "已投放",
      remedy: null,
    };
  }
  const { reason, remedy } = rejectCopy(item.code, item.params);
  return {
    key: item.clientKey,
    name,
    bytes: item.bytes,
    ok: false,
    /* reason 自带文件名（`pixel_count_exceeded` 那几个码没有，那时由
       `name` 补上），这里**剥掉**它——面板上那一份名字只出现一次。 */
    text: stripName(reason, name),
    remedy,
  };
}

/** reason 里那句「X 是 Word 文档」与 `name` 是同一份名字。面板上已经有
    `name` 了，重复一遍会让「哪一份被拒」更难读。 */
function stripName(reason: string, name: string): string {
  return reason.startsWith(name) ? reason.slice(name.length) : reason;
}

/** 把一次回执拆成逐项的清单。**不做任何取舍**——收下的和拒的都在里面，
    顺序就是投放顺序。 */
export function buildReceipt(items: VerdictItem[], local?: Map<string, string>): Receipt {
  const lines = items.map((it) => line(it, local));
  return {
    lines,
    placed: items.filter((it) => it.status === "accepted" && !it.alreadyPresent).length,
    duplicates: items.filter((it) => it.status === "accepted" && it.alreadyPresent).length,
    rejected: lines.filter((l) => !l.ok).length,
    placedBytes: items.reduce(
      (n, it) => (it.status === "accepted" && !it.alreadyPresent ? n + it.bytes : n),
      0,
    ),
  };
}

/** 收下那批的区域。**按回执顺序**——ADR-0013 规定摊开序列是有序的，
    页与多份投放共用同一条规则，所以顺序不能自己重排。 */
export function acceptedItems(items: VerdictItem[]): AcceptedItem[] {
  return items.filter((it): it is AcceptedItem => it.status === "accepted");
}

export function rejectedItems(items: VerdictItem[]): RejectedItem[] {
  return items.filter((it): it is RejectedItem => it.status === "rejected");
}

/** 一行摘要，给屏上放不下逐项清单时用。**不含拒收项的体积**——
    要体积就去读 `buildReceipt` 的 `lines`，别从这里凑。 */
export function receiptHeadline(r: Receipt): string {
  const parts: string[] = [];
  if (r.placed) parts.push(`已投放 ${r.placed} 份（${formatBytes(r.placedBytes)}）`);
  if (r.duplicates) parts.push(`另有 ${r.duplicates} 份已在画布上，没有新增`);
  if (r.rejected) parts.push(`没投上 ${r.rejected} 份`);
  return parts.join("，") || "一份也没投上";
}
