/* ===========================================================================
   产品外壳：把一份图片拖进来，摆在画布上，投出去。
   ===========================================================================
   这是产品路径。评审脚手架（DemoApp）里的那些东西**一个都不在这里**，
   而且是靠「不存在」实现的，不是靠「投屏时记得藏起来」：

     · 顶部那条路径导航 · PROTOTYPE 红标 · ?path=&step= 路由
     · 绿色提示条 · 解析/拍板/分组/重跑那些还没实现的按钮

   同样是「不存在」的还有：语义单元（`unit` 恒为 null，#8 才有）、
   撤销（ADR-0011：产品没有回滚，留一个假的比没有更糟）、吸附与对齐线
   （ADR-0010：AI 从不摆放，编排纯人工）。

   ## 屏幕只有五态

   empty / ingesting / ready / casting / error。多一态就多一处「这一屏在
   等什么」需要人记，而原型那边二十来个 screen 正是评审时说不清「现在该
   点哪个」的原因。

   ## 投屏是一道渲染门

   `casting` **不重建 board、不触发任何取景、不发一个请求**。区域位图在
   ingest 响应回来时就已经 fetch 成 Blob 物化成 blob: URL 了（见
   RegionImage），所以投出去的那一刻屏上每一个字节都已经在本地。

   退出绑 Esc，对应希沃遥控的系统级退出键——**画面上不摆退出口**。
   也**不做 fullscreen / Presentation API**：`requestFullscreen` 会吞掉
   Esc，与「退出靠系统级动作」正面冲突。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ApiError, clientKey, createSession, deleteSession, uploadArtifacts } from "./api";
import type { Outgoing } from "./api";
import { Canvas } from "./Canvas";
import { camera } from "./camera";
import { ErrorScreen } from "./ErrorScreen";
import type { Problem } from "./ErrorScreen";
import { gateFile, placeRegions, placable } from "./ingest";
import { prefetchRegionBitmaps, releaseRegionBitmaps } from "./RegionImage";
import { acceptedItems, buildReceipt, formatBytes, receiptHeadline } from "./messages";
import type { Receipt } from "./messages";
import type { Board, Bounds, RejectedItem, VerdictItem } from "./types";
import { Glyph, IconButton, Icons, TextButton } from "./ui";

export type Screen = "empty" | "ingesting" | "ready" | "casting" | "error";

/** 「重新开始」时通知服务端的上限。它只是**通知**：超了就放弃这一发，
    不影响本地的清理——本地的清理在发请求之前就做完了。 */
const DELETE_TIMEOUT_MS = 3000;

/** 空画布。**刻意不走 model.ts 的 freshBoard()**——那一份是评审脚手架的，
    连着 SAMPLE 那些示例区域。把它引进产品路径等于把演示素材打进产物。 */
function emptyBoard(): Board {
  return {
    regions: [], touched: [], pending: [],
    selected: null, editing: null, groups: false, badges: false,
  };
}

export default function ProductApp() {
  const [screen, setScreen] = useState<Screen>("empty");
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** **非终态**的错误：这一轮还在继续，只是刚才那一下没成。它是可关掉的，
      不清 board、不夺交互、不改屏态。终态那些走 `problem` + ErrorScreen。 */
  const [notice, setNotice] = useState<Problem | null>(null);
  /** 还有几块的位图没到位。投屏要等它归零——投到大屏上才发现有一块是
      空的，比投之前就说清糟糕得多。

      存的是**键的集合**而不是一个只写一次的计数器：RegionImage 自己重试成功
      时会回报（见 `RegionImage` 的 `onSettled`），那一块从集合里划掉。曾经
      它是个只写一次的数，于是「第一次位图请求抖了一下」会把「投屏」**永久**
      锁在 secondary——而屏上的位图明明是好的，整轮会话投不出去，唯一出路是
      刷页面丢掉全部编排。 */
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const settleBitmap = useCallback((id: string) => {
    setPendingKeys((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const [fitNonce, setFitNonce] = useState(0);
  const [over, setOver] = useState(false);

  /* 会话 id **只在内存里**（ADR-0014）。刻意不写 localStorage：页位图只在
     服务端内存里留 30 分钟，把一个 id 存到本地再在刷新后拿回来，只会得到
     一个必然 410 的会话——而「刷新了」本来就该等于「重新开始」。
     所以「刷新页面就是新会话」是产品行为，不是省事。 */
  const session = useRef<{ id: string; promise: Promise<string> } | null>(null);
  /** 投放互斥。松手可以连着来，但后一次要看得见前一次的结果——所以到来的
      files **排队**，而不是被丢掉。 */
  const busy = useRef(false);
  /** busy 期间到来的投放。上一批落定后接着投。
      曾经这里是 `if (busy.current) return`：第二份连同它的 File 一起静默消失，
      没有回执、没有提示、连「投放中…」都没闪——而上面那句注释恰恰宣称
      「松手可以连着来」。补投是最常见的动作，连着拖两下非常容易。 */
  const queue = useRef<{ files: File[]; at?: { x: number; y: number } }[]>([]);
  const inflight = useRef(new AbortController());
  const alive = useRef(true);
  /** 画布上有没有东西。`ingest` 是异步的，读闭包里的 `hasContent` 会拿到
      发起那一下的旧值——这正好是「补投」判断要���的东西：补投要**接着摊**，
      不能因为中间有人动过就当成空画布。 */
  const hasContent = board.regions.length > 0;
  /* 镜像一份给那些身份必须稳定的回调读（`fail`）。读闭包里的值会拿到
     发起那一下的旧快照，而「投不出去之后屏上该显示什么」要的是当下。 */
  const hasContentRef = useRef(hasContent);
  hasContentRef.current = hasContent;

  /* 挂载标记。**effect 体里第一行就置 true**：React 19 开发模式（StrictMode）
     挂载即 mount → unmount → remount，只在 cleanup 里置 false 的话第一次
     cleanup 之后 `alive` 永远是 false——于是 `bun run dev` 下产品路径
     每一发 await 回来都被自己的守卫挡掉：不上屏、不出回执、连错误屏都不出，
     永远停在「投放中…」。e2e 跑的是 dist（生产构建不做双调用），所以这条
     洞在测试里完全看不见。 */
  useEffect(() => {
    alive.current = true;
    /* 每次挂载换一个新的 controller——**这一行不能少**。cleanup 会 abort
       掉当前那一个，而 React 19 开发模式的 StrictMode 挂载即
       mount → unmount → remount：第一次 cleanup 之后 `inflight.current`
       就是一个**已经 abort 过**的对象。只补 `alive` 不换 controller，
       之后每一发投放都带着 `signal.abort() === true` 出去，请求根本没
       离开浏览器，屏上永远停在「投放中…」。e2e 跑的是 dist（生产构建
       不做双调用），所以这条洞在测试里完全看不见，只有 `bun run dev`
       会中招——而开发模式才是仓库要求做手动验证的那条路。 */
    inflight.current = new AbortController();
    return () => {
      alive.current = false;
      inflight.current.abort();
    };
  }, []);

  const casting = screen === "casting";
  const pendingBitmaps = pendingKeys.size;
  /* 一个没解决的非终态错误也算投不出去。 */
  const canCast = hasContent && pendingBitmaps === 0 && notice === null;

  /** 懒建会话：第一次真要投的时候才建，打开页面不烧一个 30 分钟的会话。 */
  const ensureSession = useCallback(async (): Promise<string> => {
    const cur = session.current;
    /* 已经在建了就等同一个 promise，不要并发建两个。 */
    if (cur) return cur.id ? Promise.resolve(cur.id) : cur.promise;
    const promise = createSession().then((r) => r.sessionId);
    session.current = { id: "", promise };
    try {
      const id = await promise;
      session.current = { id, promise };
      return id;
    } catch (e) {
      session.current = null;
      throw e;
    }
  }, []);

  /** 一批次级失败。**分两路**，因为两者的出路根本不同。

      `gone`（410 家族：会话没了）走**终态错误屏**，唯一动作是「重新开始」——
      服务端那份页位图已经放掉了（ADR-0014），画布上剩下的是几张没有出处的空壳，
      让人继续对着一堆空壳操作比直接告诉他「这一轮结束了」糟糕得多。

      其余（`server_unreachable` / 5xx / 响应读不懂）走**非终态**的错误条：画布、
      编排与交互全部留着，投屏暂时禁用。理由很具体——一体机的 wifi 抖两秒就会
      让补投失败，而这个处置会把操作者刚排好的版连同会话一起扔掉，唯一的补救
      是从头再来一遍。`Problem.gone` 这个字段以前算了却从没人读过，于是
      「网络抖了两秒」和「会话没了」得到完全相同的处置。 */
  const fail = useCallback((e: unknown) => {
    if (!alive.current) return;
    const p: Problem =
      e instanceof ApiError
        ? { code: e.code, message: e.message, detail: e.detail, gone: e.isGone }
        : {
            code: "unexpected",
            message: "出了点没料到的问题。",
            detail: String(e),
            gone: false,
          };
    setProblem(p);
    if (p.gone) {
      setScreen("error");
      return;
    }
    setNotice(p);
    /* 非终态失败**也**要把屏从「ingesting」里放出来。投放一开始（`:186`）
       就把它设成 ingesting，而复位只写在成功路径上——于是 5xx 之后工具条
       一直停在「投放中… | 投屏」，「再投几份」与「适应画布」两个触控入口
       同时消失，而它们恰恰是网络抖两秒之后操作者最需要的东西。e2e 唯一的
       错误场景是 410，走的是 error 分支，正好绕开这条。

       投屏态原样保留：一发在途的投放回来时无权把人从投屏里踢出去。 */
    setScreen((s) => (s === "casting" ? s : hasContentRef.current ? "ready" : "empty"));
  }, []);

  /* ---------- 投放 ----------
     两条入口走同一条链路：拖拽（整屏）与文件选择器。`accept="image/*"` 只
     对选择器有效，拖拽完全绕过它，所以闸门在 `gateFile` 里，两条路径共用。

     一批落定之后从 `queue` 里取下一批接着投。排队只在这里做一次，
     `ingest` 开头不再排——两处都排会让同一批被投两次。 */
  const ingest = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    if (!files.length) return;
    if (busy.current) {
      queue.current.push({ files, at });
      return;
    }
    busy.current = true;
    /* 投屏是**渲染门**：整条投放路径在投屏时是死的。曾经只有 `Canvas` 的
       交互被关掉，`onDrop` 还开着——于是投屏中掉一份文件会发两次请求、
       在投出去的画面上多出一块、并把屏从 casting 踢回 ready。 */
    if (screen !== "casting") setScreen("ingesting");
    setProblem(null);
    setNotice(null);

    /* 键在过闸门**之前**就起好：本地拒掉的那些要能排进同一条回执的原始
       顺序里——混着投时「拒的是哪几份」必须一眼对得上。 */
    const entries = files.map((file) => ({ file, key: clientKey() }));
    const outgoing: Outgoing[] = [];
    const local: RejectedItem[] = [];
    for (const e of entries) {
      const g = gateFile(e.file, e.key);
      if (g) {
        local.push({
          clientKey: g.clientKey, status: "rejected",
          code: g.code, params: g.params, bytes: g.bytes,
        });
      } else {
        outgoing.push({ file: e.file, key: e.key });
      }
    }

    const wasEmpty = !hasContent;

    try {
      let items: VerdictItem[];
      if (!outgoing.length) {
        /* 闸门全拒了就不必建会话，更不必发一次往返。画布保持原样：
           不摆一份「假如收下了会长什么样」的预览，那会让人以为投进去了。 */
        items = orderBy(entries.map((e) => e.key), new Map(), local);
      } else {
        const sid = await ensureSession();
        /* 用 `uploadArtifacts` 已经建好的那张表，**不要**在这里再建一张同名
           的——同一段逻辑有两份实现时，哪一份先开始撒谎都不会有人发现。 */
        const { byKey } = await uploadArtifacts(sid, outgoing, inflight.current.signal);
        /* 按**投放顺序**重排：服务端回的是它收到的那几份，本地拒掉的不在
           里面。一条回执里每一份排一次，顺序即操作者拖进来的顺序。 */
        items = orderBy(entries.map((e) => e.key), byKey, local);

        const placed = placable(acceptedItems(items));
        if (placed.length) {
          /* 先把位图抓成 blob: URL，再让它们上屏。顺序反了的话，从落位到
             「投屏」变可点之间有一个窗口，块在那儿是空的。 */
          setPendingKeys(new Set(placed.map((p) => p.id)));
          const { urls, errors } = await prefetchRegionBitmaps(
            placed.map((p) => ({ key: p.id, path: p.bitmapPath })),
          );
          if (!alive.current) return;

          /* 批次级的**会话**错误要显式报出来，不能被当成「这块的位图坏了」。
             一个 410 落在 prefetch 里原本会被 allSettled 吞掉，于是 AC
             「『会话没了』是一个操作者能看懂的明确错误」在这条路径上不成立——
             屏上只剩一块永远取不到的图和一句「重试中」。 */
          for (const reason of errors.values()) {
            if (reason instanceof ApiError && reason.isGone) throw reason;
          }
          /* 抓到字节的那几块立刻划掉。抓不到的那几块**留在集合里**——
             它们没有 src，投出去就是一块空白。RegionImage 挂载后会自己再试，
             成功时回报，那一块这时才被划掉。 */
          if (urls.size) {
            const arrived = new Set(urls.keys());
            setPendingKeys((prev) => new Set([...prev].filter((k) => !arrived.has(k))));
          }

          const anchor = anchorAt(at);
          const regions = placeRegions(placed, anchor.point, anchor.bounds);
          setBoard((b) => ({
            ...b,
            /* 补投**接着摊**，不把原来那批抹掉——补投漏掉的一份是常见
               动作，抹掉等于逼人从头再来一遍。 */
            regions: [...b.regions, ...regions],
            badges: true,
          }));
        }
      }

      if (!alive.current) return;
      setReceipt(buildReceipt(items, names(entries)));
      const gotSomething = items.some((i) => i.status === "accepted");
      /* 末尾这句也必须让着投屏：一发**在途**的投放在操作者点下「投屏」之后
         才回来，它无权把人从投屏里踢出去。 */
      if (screen !== "casting") {
        setScreen(gotSomething || !wasEmpty ? "ready" : "empty");
      }
    } catch (e) {
      fail(e);
    } finally {
      busy.current = false;
      /* 队列里排着的接着投。递归调用而不是循环：这一批的 await 链本身要
         先走完，循环会把两条链路叠在一起。 */
      const next = queue.current.shift();
      if (next) void ingest(next.files, next.at);
    }
  }, [ensureSession, fail, hasContent, screen]);

  /* 重新开始：把服务端那份也放掉。页位图只在服务端内存里，前端不留副本
     （ADR-0014），所以会话没了之后本地的块就是几张空壳。

     **先把屏动起来，再去通知服务端。** 曾经是先 `await deleteSession` 才清
     board/切屏，而那个 fetch 没有 signal 也没有超时——服务端假死时
     （一体机上很常见：进程挂住、代理挂住）浏览器要等到 TCP 超时才 reject，
     期间 `releaseRegionBitmaps` / `setBoard` / `setScreen` 全都没执行，
     操作者看到的就是「按了没反应」，只能反复按。 */
  const restart = useCallback(() => {
    const cur = session.current;
    session.current = null;
    if (cur?.id) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), DELETE_TIMEOUT_MS);
      void deleteSession(cur.id, ctl.signal)
        .catch(() => {
          /* 通知失败不该挡住重来。服务端那边最坏是这一个会话活到 TTL 到期，
             由后台扫掠回收。 */
        })
        .finally(() => clearTimeout(timer));
    }
    queue.current = [];
    releaseRegionBitmaps();
    setBoard(emptyBoard());
    setReceipt(null);
    setProblem(null);
    setNotice(null);
    setPendingKeys(new Set());
    /* 换屏 = 自动取景的合法触发之一。投放不是。 */
    setFitNonce((n) => n + 1);
    setScreen("empty");
  }, []);

  /* 退投屏。Esc = 希沃遥控的系统级退出键。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && casting) setScreen("ready");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [casting]);

  /* 页面真的被关掉/换走时才收走 blob: URL。**不在 unmount 时收**：
     那样一次重渲染导致的重新挂载就会把投屏变成一片白，而投屏期间
     恰恰是最不该动 URL 的时候（见 RegionImage 文件头）。

     **`persisted` 那一道必须留着。** 一体机上是 Windows Chrome/Edge，
     从别的页面按「后退」回来时页面是 bfcache 的候选，落盘缓存时
     `pagehide` 的 `e.persisted === true`：收走 URL 而 board 还在（那只是
     内存里的 state），于是恢复后画布上每一块都变成坏图，而「投屏」此刻
     仍然是 primary 且可点——可以把一片坏图投到大屏上。 */
  useEffect(() => {
    const onGone = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      releaseRegionBitmaps();
    };
    addEventListener("pagehide", onGone);
    return () => removeEventListener("pagehide", onGone);
  }, []);

  /* 投屏态把操作痕迹整批撤掉：角标、分组标、选中框、待拍板虚线、手柄。
     **regions 是同一个引用**，位置一个像素都不动——进出投屏必须一模一样。 */
  const shown: Board = casting
    ? { ...board, selected: null, pending: [], editing: null, groups: false, badges: false }
    : board;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    /* 投屏态整条投放路径都是死的（见 `ingest` 里的同一段注释）。 */
    if (casting) return;
    void ingest([...e.dataTransfer.files], { x: e.clientX, y: e.clientY });
  };

  return (
    <div
      id="app"
      /* 两个数据属性是**给测试与现场排障用的状态出口**，不是装饰。

         投放是异步的（等一次服务端往返，再抓一批区域位图），所以「这一屏
         落定了没有」这件事必须有一个能等的东西。等中文文案「投放中…」消失
         是脆弱的：410 那条路只存在几毫秒，轮询很容易整个错过它，然后
         干等超时；而文案一改，测试就跟着改。

         `data-ingest-state` 是屏，`data-bitmaps-pending` 是还没到位的位图
         块数。两者都归零 = 这一轮真的落定了。它们挂在根节点上，不参与
         任何逻辑（`screen` 与 `pendingBitmaps` 才是真相），删掉它们
         只会让 e2e 退回 sleep。 */
      data-ingest-state={screen}
      data-bitmaps-pending={pendingBitmaps}
      className="isolate fixed inset-0 overflow-hidden bg-neutral-100 text-neutral-900
                 dark:bg-neutral-950 dark:text-neutral-100"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={onDrop}
    >
      <Canvas
        board={shown}
        zoom={null}
        fitNonce={fitNonce}
        /* 投屏只是一道门：交互关掉，board 一块没动。 */
        interactive={!casting && screen !== "ingesting" && screen !== "error"}
        onBoard={setBoard}
        onRegionSettled={settleBitmap}
      />

      {over && !casting && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center
                        bg-emerald-600/10 ring-4 ring-inset ring-emerald-600/60
                        backdrop-blur-[1px]">
          <p className="rounded-(--radius) bg-white px-4 py-2 text-sm font-medium shadow-sm
                        ring-1 ring-neutral-950/10 dark:bg-neutral-900 dark:ring-white/10
                        [--radius:var(--radius-xl)]">
            松手就投放 · 收图片
          </p>
        </div>
      )}

      {/* 提示条与底部控件在投屏时一次撤干净。它们是操作痕迹，不是内容。

          **回执的可见性与「画布上有没有内容」解耦。** 曾经它挂在
          `screen === "ready"` 上，而一份都没收下时屏态被设成 `empty`——
          于是空画布上投一份 PDF（本地闸门按扩展名拒掉，不发往返），
          `data-ingest-state="empty"`、`#receipt` 不存在、整页只有那句
          「把图片或 PDF 拖到画面任意位置，或点这里选」。操作者丢完文件，
          屏幕毫无变化：既不知道被拒了，也不知道该怎么办，而入口文案恰恰在
          邀请他投 PDF。AC「投 DOCX 当场拒收，话术说清不收和出路」在这一整类
          情形下没有落点。 */}
      {!casting && receipt && screen !== "ingesting" && screen !== "error" && (
        <ReceiptPanel receipt={receipt} onClose={() => setReceipt(null)} />
      )}

      {!casting && notice && screen !== "error" && (
        <NoticeBar notice={notice} onClose={() => setNotice(null)} />
      )}

      {screen === "error" && problem && (
        <ErrorScreen problem={problem} onRestart={() => void restart()} />
      )}

      {!casting && (
        <div id="chrome" className="fixed bottom-3.5 left-1/2 z-40 -translate-x-1/2 touch-manipulation">
          <div className="flex max-w-[min(96dvw,44rem)] items-center gap-x-3 overflow-x-auto
            rounded-(--radius) bg-white/90 p-(--padding) shadow-sm ring-1 ring-neutral-950/10
            backdrop-blur-sm dark:bg-neutral-900/90 dark:shadow-none dark:ring-white/10
            [--radius:var(--radius-xl)] [--padding:--spacing(2)]">
            {screen === "ingesting" && (
              <p className="shrink-0 px-3 py-2 text-sm text-neutral-500">投放中…</p>
            )}

            {(screen === "empty" || screen === "ready") && (
              <>
                <PickLabel onPick={ingest} ready={screen === "ready"} />
                {hasContent && (
                  <IconButton label="适应画布" size="md" onClick={() => setFitNonce((n) => n + 1)}
                    glyph={<Glyph icon={Icons.fit} />} />
                )}
              </>
            )}

            {/* 有内容之后，「投屏」是本屏**唯一**的 primary。位图没到位时
                它降成 secondary——「投出去一块空白」比「这一下按了没反应」
                更难查。有一个没解决的非终态错误时也降级：刚才那一下没能
                成功，现在投出去的东西未必是操作者以为的那一份。

                **error 屏不给投屏**：会话没了意味着这一轮已经结束
                （ADR-0014），画布上剩下的是几张没有出处的空壳。而且
                「重新开始」已经是那个屏上的 primary 了，再来一个就违反
                「一屏最多一个 primary」。 */}
            {hasContent && screen !== "error" && (
              <>
                <span aria-hidden="true" className="h-4 w-px shrink-0 bg-neutral-950/10 dark:bg-white/15" />
                <TextButton variant={canCast ? "primary" : "secondary"}
                  title={castBlockedBy(pendingBitmaps, notice)}
                  onClick={() => canCast && setScreen("casting")}>
                  投屏
                </TextButton>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* 「投屏」按不动时的那句 `title`。**不许说「正在重试」**——重试是
   `RegionImage` 里那三轮有界退避，跑完就是一句假话，而操作者会一直
   等一个不会发生的变化。 */
function castBlockedBy(pending: number, notice: Problem | null): string | undefined {
  if (pending > 0) return `还有 ${pending} 块的位图没取到`;
  if (notice) return "刚才那一下没成功，先处理掉上面那条";
  return undefined;
}

/* ---------- 锚点 ----------
   屏幕坐标 → 画布坐标，视野与视口从共享的 camera store **同步**读。
   投放是同步的：松手那一刻必须读得到当下这一刻的相机，不许有一帧的队列。 */
function anchorAt(at?: { x: number; y: number }): {
  point: { x: number; y: number };
  bounds: Bounds | undefined;
} {
  const { view, rect } = camera.snapshot();
  const topLeft = { x: -view.x / view.k, y: -view.y / view.k };
  /* 还没挂上（第一帧就投）时没有收拢边界，落到视野左上角即可 */
  if (!rect) return { point: topLeft, bounds: undefined };
  if (!at) return { point: topLeft, bounds: camera.bounds() };
  return { point: camera.toCanvas(at.x, at.y), bounds: camera.bounds() };
}

/** 按投放顺序重排回执。键不在服务端那张表里（本地闸门拒掉的）用本地那份兜底。 */
function orderBy(
  keys: string[],
  fromServer: Map<string, VerdictItem>,
  local: RejectedItem[] = [],
): VerdictItem[] {
  const localByKey = new Map(local.map((r) => [r.clientKey, r]));
  return keys
    .map((k) => fromServer.get(k) ?? localByKey.get(k))
    .filter((it): it is VerdictItem => !!it);
}

/** 键 → 本地文件名。`pixel_count_exceeded` 的 params 里没有 filename，
    只有这个映射能补上「是哪一份被拒了」。 */
function names(entries: { file: File; key: string }[]): Map<string, string> {
  return new Map(entries.map((e) => [e.key, e.file.name]));
}

/* ---------- 回执 ----------
   逐项点名，每项带文件名与体积。原型那个合计式回执在混着投的时候是废的：
   它只说收下多少 KB，不说拒的是哪一份、那一份多大。 */
function ReceiptPanel(props: { receipt: Receipt; onClose: () => void }) {
  const { receipt: r, onClose } = props;
  return (
    /* `id="receipt"` 是给 e2e 的一个把手。「同一份文件名在一条回执里只该出现
       一次」这条断言必须只量**回执面板**：画布上的来源角标也写着文件名，
       拿整页 innerText 去数必然数出两次，而真出了「名字被拼两遍」那个 bug
       时，页面里本来就该有两处一模一样的名字。 */
    <div id="receipt" className="pointer-events-auto fixed bottom-20 left-1/2 z-40
                    w-[min(92vw,30rem)] -translate-x-1/2 rounded-(--radius) bg-white p-3
                    shadow-lg ring-1 ring-neutral-950/10 dark:bg-neutral-900
                    dark:shadow-none dark:ring-white/10 [--radius:var(--radius-xl)]">
      <div className="flex items-baseline justify-between gap-x-3">
        <p className="text-sm font-semibold">{receiptHeadline(r)}</p>
        <button type="button" onClick={onClose}
          className="shrink-0 text-xs text-neutral-500 hover:text-neutral-900
                     dark:hover:text-white">知道了</button>
      </div>
      <ul className="mt-1.5 flex flex-col gap-y-1">
        {r.lines.map((l) => (
          <li key={l.key} className="text-pretty text-xs leading-5
              text-neutral-600 dark:text-neutral-400">
            {/* 文件名与体积各出现一次。`text` 已经被 messages.ts 剥掉了
                名字，所以这里直接拼，不会出现「月考卷.png 38 KB
                月考卷.png（38 KB）」那种重复。 */}
            <span className="font-medium text-neutral-900 dark:text-white">{l.name}</span>
            <span className="ml-1.5 tabular-nums text-neutral-400">{formatBytes(l.bytes)}</span>
            <span className="ml-1.5">{l.text}</span>
            {l.remedy && (
              <span className="ml-1.5 text-emerald-700 dark:text-emerald-400">{l.remedy}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- 非终态的错误条 ----------
   与 ErrorScreen 的区别就是**这一轮还在继续**：不清 board、不夺交互、
   不改屏态，也没有第二个 primary。关掉它之后画布上刚才排的版原样还在。 */
function NoticeBar(props: { notice: Problem; onClose: () => void }) {
  const { notice, onClose } = props;
  return (
    <div
      id="notice"
      data-problem-code={notice.code}
      role="alert"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-20 left-1/2 z-40
                 w-[min(92vw,30rem)] -translate-x-1/2 rounded-(--radius) bg-white p-3
                 shadow-lg ring-1 ring-amber-300 dark:bg-neutral-900 dark:shadow-none
                 dark:ring-amber-800 [--radius:var(--radius-xl)]"
    >
      <div className="flex items-baseline justify-between gap-x-3">
        <p className="flex items-start gap-x-2 text-sm font-semibold text-neutral-900
                      dark:text-white">
          <Glyph icon={Icons.warn} className="mt-px fill-amber-500 dark:fill-amber-400" />
          {notice.message}
        </p>
        <button type="button" onClick={onClose}
          className="shrink-0 text-xs text-neutral-500 hover:text-neutral-900
                     dark:hover:text-white">知道了</button>
      </div>
      <p className="mt-1 pl-6 text-pretty text-xs leading-5 text-neutral-600
                    dark:text-neutral-400">
        {notice.detail} 画布上已经摆好的那些没动，直接再投一次就行。
      </p>
    </div>
  );
}

/* ---------- 第二条投放路径 ----------
   触控设备上不方便拖拽时用它。这个 label 包着一个 sr-only 的 file input：
   它照样能被 Tab 选中，所以焦点落在它身上时必须有可见的环。 */
function PickLabel(props: { onPick: (files: File[]) => void; ready: boolean }) {
  const { onPick, ready } = props;
  return (
    <label className="shrink-0 cursor-pointer rounded-(--radius) px-3 py-2 text-sm
      font-medium text-neutral-600 ring-1 ring-transparent hover:bg-neutral-950/5
      dark:text-neutral-300 dark:hover:bg-white/10
      has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
      has-[:focus-visible]:outline-emerald-600">
      {ready ? "再投几份" : "把图片拖到画面任意位置，或点这里选"}
      <input type="file" multiple accept="image/*" className="sr-only"
        onChange={(e) => {
          /* 先把 FileList 拷成数组，再把 input 清空。不清空的话，
             **连选同一个文件第二次不触发 change**——而「同一份内容再投
             一次」正是 ADR-0015 明写要支持的动作。 */
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (list.length) void onPick(list);
        }} />
    </label>
  );
}
