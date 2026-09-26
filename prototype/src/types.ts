/* ===========================================================================
   类型：模型的词汇表。纯类型，一个运行时值都没有。
   ===========================================================================
   为什么单独一份，而不是留在 model.ts：

   `Dialog.body` 以后要能渲染**服务端返回的结构化载荷**（拒收码 → 文案 → 出路），
   而那个形状是数据不是 React 元素。早先 model.ts 第 13 行 `import type
   { ReactNode } from "react"` 把整个模型层绑死在 React 上，于是「能不能描述一
   次服务端回执」这个问题最后变成了「这个类型文件引了哪个 UI 框架」。

   所以这里的规矩是：**types.ts 不许 import 任何东西**，尤其不许 import
   react。评审脚手架要用的 ReactNode 类型（Dialog、Screen）留在 demo 侧的
   model.ts，不许顺着 import 爬回来。 */

/* 相机：画布坐标 → 屏幕像素的仿射变换。translate 后再 scale，scale 原点是
   视口左上角（#stage 上的 origin-top-left）。 */
export type View = { x: number; y: number; k: number };

/** 矩形。取 DOMRect 的四个字段而不是 DOMRect 本身：投放路径要读它，
    而它必须能在没有 DOM 的地方（纯函数测试、未来的服务端）被构造出来。 */
export type Rect = { left: number; top: number; width: number; height: number };

/** 尺寸。像素（px），不是字节，也不是比例。 */
export type Size = { w: number; h: number };

/** 裁切框，相对**页位图**的左上角，单位是页位图的像素。
    #4 里区域恒等于整页，所以它恒为 {0,0,W,H}；#5 起服务端才真裁。 */
export type Crop = { x: number; y: number; w: number; h: number };

/** 当前视野在**画布坐标**下的矩形，不是内容包围盒。
    写成内容 bbox 的话「丢在右边缘自动收拢」就等于什么都不做——收拢的
    目标是把东西推进**看得见的范围**，而看得见的范围由相机和视口决定。 */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type Region = {
  /** 全画布唯一。#4 里由服务端生成 `${artifactId}#${regionId}`——
      绝不能是「第几次投放的第几块」，那第二次投放就会撞出第二个 a1。 */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 来源页码，投屏前给操作者认「这块是哪来的」 */
  page: number;
  /** 这块来自哪个投放的文件。多资源时角标才带得上信息 */
  artifact?: string;
  /** 语义单元 id，null = 不属于任何一组。#4 的产品路径恒为 null；
      分组是 #8 的活，#4 只保留「按 r.unit 决定整组还是单块」这个形状。 */
  unit: string | null;
  title?: string;
  opts?: string[];
  bars?: string[];
  figure?: boolean;
  table?: string[][];
  /** 真实投放进来的图片：块直接显示它，而不是示例内容。
      产品路径的位图是服务端返回的**裁切位图**（#4 = 整页，#5 起 = 裁过的），
      由 RegionImage 立刻 fetch 成 Blob 再物化成 blob: URL——投屏期间
      /api/* 的请求数必须是 0（见 brief §7-12）。 */
  src?: string;
  /** 服务端回执里的区域位图**相对**路径。RegionImage 拿它（连同 `id`
      这个 `${artifactId}#${regionId}` 的缓存键）在 ingest 响应回来时就把
      位图 fetch 成 Blob 物化成 blob: URL——**投屏期间 /api/* 的请求数
      必须是 0**。demo 路径不给它：那边 `src` 直接就是本地 File 的
      object URL，没有任何网络。 */
  bitmapPath?: string;
  /** 由「继续切碎」派生出来的子块 */
  child?: boolean;
};

export type Board = {
  /** 数组顺序**就是** z 序。不另设 z-index 通道：同一个属性两套真相，
      迟早出现「松手掉回底层」那种前后不一。 */
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

/* ---------- 服务端回执 ----------
   照 `server/bscp/ingest.py` 的产出抄的。**投放端点恒 200**，混着收与拒靠
   `items[]` 逐项表达——批次级 4xx 会吞掉同一批里其它文件的回执，恰好毁掉
   「一次回执逐个点名」。所以这些形状是数据，不是异常。

   放在这里而不是 api.ts：这个文件是「模型层的词汇表」，而回执正是模型层
   要描述的东西；它也不引 react，仍然满足本文件「不许 import 任何东西」。 */

export type RegionBitmap = {
  /** 全画布唯一的区域 id：`${artifactId}#${regionId}`。服务端生成。 */
  id: string;
  page: number;
  crop: Crop;
  pixel: Size;
  /** 区域位图的**相对**路径。物化成 object URL 是 RegionImage 的事。 */
  bitmapUrl: string;
};

export type AcceptedItem = {
  clientKey: string;
  status: "accepted";
  artifactId: string;
  /** 该资源**首次登记时**的文件名。重投同一份内容回的是这个（ADR-0015）。 */
  displayName: string;
  bytes: number;
  pageCount: number;
  /** 同一份内容已经在画布上了：不新增资源、不新增区域、不移动。 */
  alreadyPresent: boolean;
  region: RegionBitmap;
};

export type RejectedItem = {
  clientKey: string;
  status: "rejected";
  /** 拒收码。**句子由 messages.ts 按 code + params 渲染**——
      拒绝理由是格式决定（服务端权威），句子是 UI 副本。 */
  code: string;
  params: Record<string, string | number>;
  bytes: number;
};

export type VerdictItem = AcceptedItem | RejectedItem;

export type ArtifactReceipt = {
  items: VerdictItem[];
  expiresAt: string;
};
