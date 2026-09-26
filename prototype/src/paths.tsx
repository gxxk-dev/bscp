/* ===========================================================================
   12 条行为路径 —— spec「行为路径表」的可执行版本
   ===========================================================================
   表说「2 步内完成」，这里就得真的 2 步走完；走不完就是表写错了。

   每一步是「从零开始构造这一屏」的纯函数，**不接受也不保留上一屏的状态**。
   这不是洁癖：早先的版本把状态放在全局变量里，切个路径就改变了对
   「你摆过什么」的判断——重跑对话框里那个数字会跟着你点过的路径变。
   现在每一步都从 freshScene() 起算，顺序无关。 */
import {
  derive, freshBoard, freshScene, movedCount, moveRegion, replaceWith, scatter, withScreen,
} from "./model";
import type { Board } from "./types";
import type { Scene } from "./model";

export type Step = { hint: string; build: () => Scene };
export type Path = {
  no: number;
  name: string;
  /** 表上写的步数目标 */
  budget: string;
  entry: string;
  fallback: string;
  /** 这一条路径要证明的事 */
  claim: string;
  steps: Step[];
};

/* 反复出现的三段式：摆好、碎开、按需打开某一层。 */
function laid(): Board {
  const b = freshBoard();
  return { ...b, regions: scatter(b.regions) };
}
/** 模拟「你已经干了一会儿活」：把几块挪到明显不同于原位的地方。
    位移刻意比碎开的分离量大，否则评审者分不清「这是你摆的」和「这是抖动」。
    落点选在版面下方的空白里——压着别的块会让人以为是渲染错位，
    而这一屏要证明的恰恰是「你摆的」和「自动的」分得开。 */
function worked(): Scene {
  const b = laid();
  const [r1, r2] = b.regions;
  const BELOW = 770;                          // r6 底边 570+172 之下，留一点空
  let board = moveRegion({ ...b, groups: true }, ["r1"], 0 - r1!.x, BELOW - r1!.y);
  board = moveRegion(board, ["r2"], 500 - r2!.x, BELOW - r2!.y);
  return { ...freshScene(), screen: "arranged", board };
}

export const PATHS: Record<string, Path> = {
  drop: {
    no: 1, name: "投放资源", budget: "1 步 · 拖入即投放",
    entry: "常驻但不显眼；整屏都是投放区",
    fallback: "失败给明确错误，画布不动",
    claim: "别的什么都不用做",
    steps: [
      { hint: "整屏都是投放区。拖进来 → 立刻就是下一步。",
        build: () => withScreen({ ...freshScene(), board: freshBoard([]) }, "empty") },
      { hint: "投放完成。原件只服务这一轮管线，不留下来。现在可以解析了。",
        build: () => withScreen(freshScene(), "ready") },
    ],
  },

  reject: {
    no: 2, name: "DOCX 被拒", budget: "1 步 · 立刻回话",
    entry: "同一个投放区",
    fallback: "不静默失败——说清哪个文件、为什么、怎么办",
    claim: "被拒的文件不变成任何东西，出路是可走的",
    steps: [
      { hint: "投一个 DOCX 试试。",
        build: () => withScreen({ ...freshScene(), board: freshBoard([]) }, "empty") },
      { hint: "拒绝是当场说清的：哪个文件、为什么不收、怎么办。画布保持空——不摆一份「假如收下了会长什么样」的预览，那会让人以为已经投进去了。",
        build: () => withScreen(
          { ...freshScene(), board: freshBoard([]) }, "rejected",
          { toast: "高一物理月考卷.docx 不收 —— 首版只支持图片和 PDF。在希沃里另存为 PDF，或截图后直接投。" },
        ) },
    ],
  },

  parse: {
    no: 3, name: "触发解析", budget: "1 步 · 就在投放落点",
    entry: "靠近投放完成后的落点，不在容易误触处",
    fallback: "解析前画布可空；失败保持原样",
    claim: "画布不会在你没准备好的时候被改写",
    steps: [
      { hint: "资源就绪。解析按钮刚出现在投放落点附近，不在别处。",
        build: () => withScreen(freshScene(), "ready") },
      { hint: "解析中。画布有回执，但还不改内容——解析完成才碎开。",
        build: () => withScreen(freshScene(), "parsing", { busy: true }) },
    ],
  },

  scatter: {
    no: 4, name: "碎开", budget: "0 步 · 解析完成的瞬间",
    entry: "无入口，是解析结果生效的呈现",
    fallback: "失败保持原样",
    claim: "全场唯一一次自动发生的事",
    steps: [
      { hint: "整份资源还粘在一起，就是它本来的版面。",
        build: () => withScreen(freshScene(), "cohesive") },
      { hint: "裂成 6 块：各块停在原位置附近、轻微分离，但相对位置保留了。摆块时那份「谁原本挨着谁」的线索就来自这里。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "scattered") },
    ],
  },

  confirm: {
    no: 5, name: "拍板裁切", budget: "1 步/块；支持「全部接受」",
    entry: "就地浮出的确认控件",
    fallback: "未拍板状态可见；拍板前可改框",
    claim: "系统找出来的块，要你点头才算数",
    steps: [
      { hint: "6 块里有一块没拍板（虚线）。虚线就是「还没审」的状态，不会漏掉。",
        build: () => withScreen({ ...freshScene(), board: { ...laid(), pending: ["r3"] } }, "pending") },
      { hint: "就地浮出的两个按钮：接受 / 改框。不用跑到屏幕另一头。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), pending: ["r3"], selected: "r3" } }, "pending-focus") },
      { hint: "改框：拖四角手柄，边界实时跟手。切口穿过了字就现在纠正——这个错看得见，所以交给自动机制挑出来是合理的。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), pending: ["r3"], selected: "r3", editing: "r3" } },
          "editing") },
      { hint: "全拍完了。虚线消失——现在你看到的每一块都经过你点头。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "scattered") },
    ],
  },

  splitcut: {
    no: 6, name: "拆 / 合裁切", budget: "2 步内 · 选中后的就近动作",
    entry: "选中块后就近浮出",
    fallback: "切碎了能合回去",
    claim: "切太粗和切太碎都能就地改",
    steps: [
      { hint: "选中一块。就近动作出现在它旁边，不跑到屏幕另一头。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), selected: "r4" } }, "selected") },
      { hint: "切成两块之后各自独立，想换回去也是 2 步内。切太碎不该是死路。",
        build: () => withScreen(
          { ...freshScene(), board: { ...freshBoard(), regions: replaceWith(laid().regions, "r4", 2) } },
          "split") },
      { hint: "合回来一样是 2 步内。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "scattered") },
    ],
  },

  group: {
    no: 7, name: "拆 / 合分组", budget: "2 步内 · 选中后的就近动作",
    entry: "选中块后就近浮出",
    fallback: "分错了能拆开、能合并",
    claim: "分组是提议，可以推翻",
    steps: [
      { hint: "虚线框圈出的就是语义单元的提议（u1 / u2 / u3）。它只是提议。",
        build: () => withScreen({ ...freshScene(), board: { ...laid(), groups: true } }, "grouped") },
      { hint: "选中一块，就能看到它属于哪一组、以及拆 / 合两个动作。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), groups: true, selected: "r1" } }, "grouped-sel") },
      { hint: "分组必须一眼可见——它决定了「整组拖动」能带走哪些块。",
        build: () => withScreen({ ...freshScene(), board: { ...laid(), groups: true } }, "grouped") },
    ],
  },

  arrange: {
    no: 8, name: "单块 / 整组拖动", budget: "1 步 · 直接拖",
    entry: "直接拖（整组拖：拖组内任一块）",
    fallback: "摆错了就再拖回去",
    claim: "摆放是纯人工的，AI 从不摆放",
    steps: [
      { hint: "拖一块。注意：没有吸附、没有对齐线、没有「AI 建议的位置」。",
        build: () => withScreen({ ...freshScene(), board: { ...laid(), groups: true } }, "scattered") },
      { hint: "这一块挪到了右边，和别的块脱开了。画面正常、内容也对——正是这种「看不出错」的错误不该交给自动机制。",
        build: () => {
          const b = laid();
          const r1 = b.regions.find((r) => r.id === "r1")!;
          return withScreen(
            { ...freshScene(), board: moveRegion({ ...b, groups: true }, ["r1"], 700 - r1.x, -140 - r1.y) },
            "moved-one");
        } },
      { hint: "整组拖动：拖 u1 里任意一块，同组的另一块跟着走——一道题的题干图选项一起走。",
        build: () => {
          const b = laid();
          const g = b.regions.filter((r) => r.unit === "u1");
          let board = moveRegion({ ...b, groups: true }, g.map((r) => r.id), 0, 0);
          for (const r of g) {
            const targetY = 470;
            board = moveRegion(board, [r.id], 0, targetY - r.y);
          }
          return withScreen({ ...freshScene(), board }, "moved-group");
        } },
    ],
  },

  reread: {
    no: 9, name: "继续切碎（提高可读性）", budget: "2 步内 · 选中后就近动作",
    entry: "选中块后就近浮出",
    fallback: "切细了就合回整块",
    claim: "「字号太小」靠切分解决，不靠提高分辨率",
    steps: [
      { hint: "一张数据表，投到大屏上后排看不清。选中它。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), selected: "r6" } }, "selected") },
      { hint: "按行切成 4 块，每块的裁切框都收紧到只包住自己那几行。切口沿阅读方向——按列切出来的东西没人读得下去。",
        build: () => withScreen(
          { ...freshScene(), board: { ...freshBoard(), regions: replaceWith(laid().regions, "r6", 4) } },
          "split-rows") },
      { hint: "现在把其中一块投出去：它占满整块屏，字不用拉伸就清楚了。这就是「面积」的意思——换一块内容更少的图去占屏，而不是把同一张表拉伸。",
        build: () => {
          /* 从 derive 里直接取子块。不能写 replaceWith(...)[0]——那是
             flatMap 之后的第一块，也就是 r1，不是表格切出来的第一块。
             症状很隐蔽：屏幕上确确实实只有一块、也确实放大了，
             只是放大的不是我们说的那一块。 */
          const [first] = derive("r6", 4);
          return withScreen(
            { ...freshScene(), board: { ...freshBoard(), regions: [first!] } },
            "one-block-full", { fill: true });
        } },
    ],
  },

  rerun: {
    no: 10, name: "重跑解析", budget: "2 步 · 入口 + 强确认",
    entry: "不在容易误触处；强确认",
    fallback: "确认框说清会丢什么；不能撤销",
    claim: "会毁掉这一份上劳动的动作，只有这一个",
    steps: [
      { hint: "先摆歪几块，模拟「你已经干了一会儿活」。注意重跑入口在哪：离其它动作隔了两道。",
        build: () => worked() },
      { hint: "确认框把「会丢什么」数出来了，不是形容词。",
        build: () => {
          const s = worked();
          const n = movedCount(s.board);
          return { ...s, screen: "operating" as const, dialog: {
            kind: "danger" as const,
            title: "重跑解析会覆盖这一份上你摆好的一切",
            body: n
              ? <>这一份里你已经挪动了 <b className="tabular-nums text-neutral-900 dark:text-white">{n}</b> 块区域，重跑会把它们<b className="text-neutral-900 dark:text-white">整份覆盖</b>，不做合并。画布上别的资源不动。<br />
                 没有备份，这一步<b className="text-red-600 dark:text-red-400">不能撤销</b>。</>
              : <>这一份还没有任何编排，重跑只是重新算一遍裁切与分组。<br />
                 没有备份，这一步<b className="text-red-600 dark:text-red-400">不能撤销</b>。</>,
            cancel: "取消", confirm: "仍然重跑",
          } };
        } },
      { hint: "覆盖是这一份的，不合并——所以不会遇到「保留哪些、丢弃哪些」这种看不出规则的行为。画布上别的资源不动，也没有备份可退。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "scattered",
          { toast: "已重跑这一份。旧的编排没有备份，覆盖不能撤销。" }) },
    ],
  },

  cast: {
    no: 11, name: "投屏进入 / 退出", budget: "1 步",
    entry: "靠近顺手位置",
    fallback: "退出即回到操作态，布局不丢",
    claim: "这一屏不该出现任何操作痕迹",
    steps: [
      { hint: "正常操作态。选中框、角标、底部控件、分组虚线——学生都看得见。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), groups: true, badges: true, selected: "r1" } },
          "operating") },
      { hint: "投屏态：所有痕迹一次消失，只剩内容与你的编排。位置一点没动。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "casting") },
      { hint: "退出投屏，布局原封不动地回来了。进出都只有一步。",
        build: () => withScreen(
          { ...freshScene(), board: { ...laid(), groups: true, badges: true, selected: "r1" } },
          "operating") },
    ],
  },

  nav: {
    no: 12, name: "缩放 / 平移画布", budget: "1 步 · 双指 / 滚轮与拖拽",
    entry: "触控双指 / 鼠标滚轮与拖拽",
    fallback: "视野变化，无不可逆损伤",
    claim: "有限的手，无限的空间",
    steps: [
      { hint: "缩到很小看整体：这块画布没有边界，也没有「页」。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "zoom-out", { zoom: 0.42 }) },
      { hint: "推近看细节。同一块画布，视野而已。",
        build: () => withScreen({ ...freshScene(), board: laid() }, "zoom-in", { zoom: 1.9 }) },
    ],
  },
};

export const ORDER = Object.values(PATHS).sort((a, b) => a.no - b.no).map((p) => p.name);
export const PATH_KEYS = Object.keys(PATHS).sort(
  (a, b) => PATHS[a]!.no - PATHS[b]!.no,
);
