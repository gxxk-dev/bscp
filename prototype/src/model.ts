/* ===========================================================================
   模型：这一层全是纯函数和纯数据，不碰 DOM。
   ===========================================================================
   为什么要把「位置」和「谁被操作者动过」分成两样东西：

     解析完成会**碎开**——各块从版面中心向外轻轻挪一点。这是一次呈现，
     不是编排。操作者随后拖动块，才是编排。重跑解析会抹掉的是后者。

   所以 positions 里存碎开后的真实坐标，另用 touched 记「哪些块是操作者
   亲手动的」。确认框里那个「你挪动了 N 块」数的是 touched，不是 positions
   ——否则碎开会让它永远显示 6 块，或者（早先的写法）永远显示 0 块。
   两个数都不是人话，警告框就废了。 */
import type { ReactNode } from "react";

export type Region = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 来源页码，投屏前给操作者认「这块是哪来的」 */
  page: number;
  /** 这块来自哪个投放的文件。多资源时角标才带得上信息 */
  artifact?: string;
  /** 语义单元 id，null = 不属于任何一组 */
  unit: string | null;
  title?: string;
  opts?: string[];
  bars?: string[];
  figure?: boolean;
  table?: string[][];
  /** 真实投放进来的图片：块直接显示它，而不是示例内容 */
  src?: string;
  /** 由「继续切碎」派生出来的子块 */
  child?: boolean;
};

/* 每一屏叫什么。控件只认这个名字，不认别的——这让「这一屏在等什么」
   变成一处可查的清单，而不是散落在各处的 class 名。 */
export type Screen =
  | "empty" | "ready" | "rejected" | "parsing"
  | "cohesive" | "scattered" | "pending" | "pending-focus" | "editing"
  | "split" | "split-rows" | "one-block-full"
  | "selected" | "grouped" | "grouped-sel"
  | "moved-one" | "moved-group" | "arranged"
  | "operating" | "casting"
  | "zoom-out" | "zoom-in";

export type Dialog = {
  kind: "danger" | "info";
  title: string;
  body: ReactNode;
  cancel: string;
  confirm: string;
};

export type View = { x: number; y: number; k: number };

export type Board = {
  regions: Region[];
  /** 操作者亲手拖过的块 id。碎开不写这里。 */
  touched: string[];
  /** 还没拍板的块 id（虚线） */
  pending: string[];
  selected: string | null;
  /** 正在改框：那块显示四角手柄 */
  editing: string | null;
  /** 语义单元可见 */
  groups: boolean;
  /** 来源角标可见 */
  badges: boolean;
};

export type Scene = {
  screen: Screen;
  board: Board;
  /** null = 适应画布；数字 = 固定缩放倍率 */
  zoom: number | null;
  /** 这一屏要把内容铺满屏（只投一块出去时） */
  fill: boolean;
  /** 用户自己平移/缩放过之后接管 centering，直到换屏 */
  view: View | null;
  busy: boolean;
  dialog: Dialog | null;
  toast: string | null;
};

/* ---------- 示例内容 ----------
   标题与选项用真字，灰条代表原件裁切出来的正文。
   12 条路径共用这一份「试卷」：换资源就是换一批区域，路径本身不变。 */
export const SAMPLE: Region[] = [
  { id: "r1", x: 0, y: 0, w: 460, h: 250, page: 1, unit: "u1",
    title: "1. 下列说法正确的是（　）",
    opts: ["A. 物体速度为零时加速度一定为零",
           "B. 加速度减小时速度一定减小",
           "C. 速度变化越快加速度越大",
           "D. 加速度方向与速度方向总是相同"] },
  { id: "r2", x: 500, y: 0, w: 460, h: 250, page: 1, unit: "u1",
    title: "2. 如图所示，物块沿斜面下滑（　）",
    bars: ["w-[90%]", "w-[75%]", "w-[60%]"] },
  { id: "r3", x: 1000, y: 0, w: 300, h: 250, page: 1, unit: "u2", figure: true },
  { id: "r4", x: 0, y: 300, w: 700, h: 220, page: 2, unit: "u3",
    title: "3. 计算题：求物块在 3s 内通过的位移",
    bars: ["w-[90%]", "w-[75%]", "w-[60%]", "w-[45%]"] },
  { id: "r5", x: 750, y: 300, w: 550, h: 220, page: 2, unit: "u3",
    title: "参考答案", opts: ["1. C　　2. B　　3. 4.5 m"] },
  /* 高度按内容算，不是拍脑袋：表头 + 4 行 = 5 个 24px 行高，加上标题和
     内边距。写小了，切碎之前整张表最后一行就是被裁掉的——而那恰恰是
     评审者要看的「后排看不清」的那张表。 */
  { id: "r6", x: 0, y: 570, w: 400, h: 52 + 5 * 24, page: 3, unit: null,
    title: "考试成绩分布",
    table: [["分数段", "人数", "占比"],
            ["90 以上", "12", "24%"],
            ["70 – 89", "18", "36%"],
            ["60 – 69", "11", "22%"],
            ["60 以下", "9", "18%"]] },
];

/* 原始版面。碎开、回滚、「你挪动了几块」全都以它为基准。 */
export const HOME = new Map(SAMPLE.map((r) => [r.id, { x: r.x, y: r.y }]));

/* ---------- 场景工厂 ---------- */
export function freshBoard(regions: Region[] = SAMPLE): Board {
  return {
    regions: regions.map((r) => ({ ...r, x: HOME.get(r.id)?.x ?? r.x, y: HOME.get(r.id)?.y ?? r.y })),
    touched: [], pending: [], selected: null, editing: null, groups: false, badges: false,
  };
}

export function freshScene(): Scene {
  return {
    screen: "empty", board: freshBoard(), zoom: null, fill: false, view: null,
    busy: false, dialog: null, toast: null,
  };
}

export function withScreen(s: Scene, screen: Screen, patch: Partial<Scene> = {}): Scene {
  return { ...s, screen, ...patch, view: null };
}

/* ---------- 碎开 ----------
   分离量不是一个绝对值。早期那版用 ±14px，在 1440px 的画布上根本看不出
   发生过什么，撞的是「碎开必须是看得见的变化」。真正的参数是两条比值：

     - 相对块的尺寸：分离量 << 块宽，否则块互相穿插、失去「块」的边界
     - 相对块之间的间距：分离量 ≳ 原间距，否则淹没在本来就有的留白里

   取短边的 8%，方向从版面中心向外。向外比随机散布更像「裂开」——随机
   散布会直接毁掉相对位置这条线索，而它正是摆块时唯一的参考。 */
export function scatter(regions: Region[]): Region[] {
  const b = boxOf(regions);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return regions.map((r) => {
    const home = HOME.get(r.id) ?? r;
    const amp = Math.min(r.w, r.h) * 0.08;
    const ang = Math.atan2(home.y + r.h / 2 - cy, home.x + r.w / 2 - cx) + jitter(r.id);
    return { ...r, x: home.x + Math.cos(ang) * amp, y: home.y + Math.sin(ang) * amp };
  });
}

/* 确定性扰动：同一个 id 每次碎开都往同一个方向偏一点点。
   用随机数的话，评审者来回切两次会以为碎开每次结果不同——那不是碎开，
   那是不确定性。 */
function jitter(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return ((h / 997) - 0.5) * 0.6;
}

/* ---------- 编排：只有操作者会调这个 ---------- */
export function moveRegion(b: Board, ids: string[], dx: number, dy: number): Board {
  const set = new Set(ids);
  return {
    ...b,
    touched: [...new Set([...b.touched, ...ids])],
    regions: b.regions.map((r) => (set.has(r.id) ? { ...r, x: r.x + dx, y: r.y + dy } : r)),
  };
}

/** 重跑解析会抹掉的东西：操作者亲手挪走、且现在确实不在原位的块。 */
export function movedCount(b: Board): number {
  return b.touched.filter((id) => {
    const r = b.regions.find((q) => q.id === id);
    const home = HOME.get(id);
    return !!r && !!home && (Math.abs(r.x - home.x) > 1 || Math.abs(r.y - home.y) > 1);
  }).length;
}

/* ---------- 继续切碎 ----------
   表格按**行**切，沿高度堆叠。切的方向必须跟阅读方向一致：按列切出来的
   东西没人读得下去。每一块带一份表头，因为它要能自己读懂。 */
export function derive(seedId: string, parts: number): Region[] {
  const src = SAMPLE.find((r) => r.id === seedId);
  if (!src) return [];

  if (src.table) {
    const [head, ...body] = src.table;
    const GAP = 14;
    const rowH = 24, chromeH = 52;          // 行高 / 内边距 + 标题 + 边框
    let y = src.y;
    return Array.from({ length: parts }, (_, i) => {
      const rows = body.slice(
        Math.round((body.length * i) / parts),
        Math.round((body.length * (i + 1)) / parts),
      );
      const h = chromeH + (rows.length + 1) * rowH;
      const child: Region = {
        ...src, id: `${seedId}${i}`, x: src.x, y, h,
        title: i === 0 ? src.title : "（续）",
        table: [head!, ...rows], child: true,
      };
      y += h + GAP;
      return child;
    });
  }

  let acc = 0;
  return Array.from({ length: parts }, (_, i) => {
    const w = Math.round(src.w * (1 / parts));
    const child: Region = {
      ...src, id: `${seedId}${i}`, x: src.x + Math.round(src.w * acc), w,
      title: i === 0 ? src.title : "（续）", child: true,
    };
    acc += 1 / parts;
    return child;
  });
}

/** 把 r4 换成它切出来的两块，其余不动。 */
export function replaceWith(regions: Region[], seedId: string, parts: number): Region[] {
  return regions.flatMap((r) => (r.id === seedId ? derive(seedId, parts) : [r]));
}

/* ---------- 投放 ----------
   首版只收图片和 PDF（ADR-0009）。拒绝必须**当场说清**：哪个文件、为什么、
   怎么办。丢一个「失败」标签等于把问题推回给操作者自己猜。

   一次可以投多份。来源角标那条 user story（「知道一块来自哪份资源的
   哪一页」）只有在多资源下才成立——只有一份文件时角标永远写着 p1，
   那不是信息，是废话。而课前要摆的本来就不止一份：一份试卷卷子，
   加上单独拍的板书照片。

   这段闸门放在最前面是有意的：它必须是整条管线的唯一入口，
   后面每一处都只处理「已经收下的文件」。 */
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC = "application/msword";

export type Verdict =
  | { ok: true; kind: "image"; url: string }
  | { ok: true; kind: "pdf" }
  | { ok: false; reason: string };

export function judge(file: File): Verdict {
  const name = file.name;
  if (file.type === DOCX || file.type === DOC || /\.(docx?|rtf|odt)$/i.test(name)) {
    return { ok: false, reason: `${name} 是 Word 文档，首版不收 Word。` };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(name)) {
    /* PDF 在真产品里由服务端用 PyMuPDF 栅格化（ADR-0008）。原型里不栅格化，
       但**必须**在这里就把栅格化这一步标出来，否则评审者会以为
       「投进来就能拿到文字」——而那正是我们已经否掉的路。 */
    return { ok: true, kind: "pdf" };
  }
  if (file.type.startsWith("image/")) {
    return { ok: true, kind: "image", url: URL.createObjectURL(file) };
  }
  return { ok: false, reason: `${name} 不是图片也不是 PDF，首版只收这两种。` };
}

/** 读图片的真实尺寸。丢进来就按原比例摆，不拉伸——拉伸过的图投出去
    字是糊的，而「分辨率」恰恰是这个产品明确不打算解决的问题。 */
function probeImage(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1000, h: img.naturalHeight || 700 });
    img.onerror = () => resolve({ w: 1000, h: 700 });
    img.src = url;
  });
}

const SHEET = { w: 1000, h: 700 };          // PDF 还没栅格化时的占位尺寸
const GAP = 60;

export type Ingested = { regions: Region[]; rejected: string[]; bytes: number };

/** origin = 当前视野左上角对应的画布坐标。
    新内容落在**操作者正在看的地方**，而不是画布原点——相机一动不动，
    是东西自己走过来。掉在原点的话，1440px 的屏上只能看见第一份的
    一角，剩下几份全在屏幕外，而操作者还得自己把相机平移过去才能确认
    「到底收下了没有」。这比自动取景更糟。 */
export async function ingestFiles(files: File[], origin: { x: number; y: number }): Promise<Ingested> {
  const regions: Region[] = [];
  const rejected: string[] = [];
  let bytes = 0;
  let x = origin.x;

  for (const [i, file] of files.entries()) {
    const v = judge(file);
    if (!v.ok) { rejected.push(v.reason); continue; }
    const size = v.kind === "image" ? await probeImage(v.url) : SHEET;
    regions.push({
      id: `a${i + 1}`, x, y: origin.y, w: size.w, h: size.h,
      page: 1, unit: null, artifact: file.name,
      ...(v.kind === "image" ? { src: v.url } : { figure: true }),
    });
    x += size.w + GAP;
    bytes += file.size;
  }
  return { regions, rejected, bytes };
}

/** 一次投放的回执要一次说清：收下了什么、拒了什么。混着投递时
    静默丢掉拒收的那些，比明确报错更糟——操作者会以为都在。 */
export function ingestToast(ing: Ingested): string {
  const ok = ing.regions.length
    ? `已投放 ${ing.regions.length} 份（${mb(ing.bytes)}）：${ing.regions.map((r) => r.artifact).join("、")}。`
    : "";
  const no = ing.rejected.length
    ? `${ing.rejected.length ? "没收：" : ""}${ing.rejected.join("")}在希沃里另存为 PDF，或截图后直接投。`
    : "";
  return [ok, no].filter(Boolean).join("");
}

export const mb = (bytes: number) =>
  bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function boardFor(regions: Region[]): Board {
  return { ...freshBoard([]), regions };
}

export function readyScene(regions: Region[], toast: string): Scene {
  return { ...freshScene(), screen: "ready", board: boardFor(regions), toast };
}

/* ---------- 内容包围盒 ---------- */
export function boxOf(regions: Region[]) {
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
  const pad = 96, padTop = 60;
  const fit = Math.min((vp.w - pad * 2) / b.w, (vp.h - pad * 2 - padTop) / b.h);
  const k = zoom ?? (fill ? fit : Math.min(1, Math.max(0.2, fit)));
  return {
    k,
    x: (vp.w - b.w * k) / 2 - b.x * k,
    y: (vp.h - b.h * k) / 2 - b.y * k,
  };
}
