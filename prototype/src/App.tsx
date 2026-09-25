/* ===========================================================================
   应用外壳
   ===========================================================================
   顶部那条是**评审用的脚手架**，不是被评审的产品 UI——所以投屏态它还在。
   底部那条和绿色提示条是设计对象：投屏时必须一次消失干净。
   每一屏都能用 URL 直接定位：?path=<key>&step=<从 0 起>。 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Canvas } from "./Canvas";
import { movedCount } from "./model";
import type { Board, Scene } from "./model";
import { PATHS, PATH_KEYS } from "./paths";
import { Glyph, IconButton, Icons, TextButton } from "./ui";

/* ---------- URL ↔ 状态 ---------- */
function readUrl(): { path: string; step: number } {
  const q = new URLSearchParams(location.search);
  const path = q.get("path") ?? PATH_KEYS[0]!;
  const p = PATHS[path];
  if (!p) return { path: PATH_KEYS[0]!, step: 0 };
  return { path, step: Math.min(Math.max(0, Number(q.get("step") || 0)), p.steps.length - 1) };
}

export default function App() {
  const [where, setWhere] = useState(readUrl);
  const [scene, setScene] = useState<Scene>(() => build(where.path, where.step));
  const [fitNonce, setFitNonce] = useState(0);

  const path = PATHS[where.path]!;
  const step = path.steps[where.step]!;
  const casting = scene.screen === "casting";

  /* 换屏 = 从零重建这一屏。所以切路径不可能把上一屏的编排带过来——
     「重跑会丢几块」那个数字也就和浏览顺序无关了。 */
  const go = useCallback((p: string, s = 0) => {
    setWhere({ path: p, step: s });
    setScene(build(p, s));
    setFitNonce((n) => n + 1);
    history.replaceState(null, "", `?${new URLSearchParams({ path: p, step: String(s) })}`);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = PATH_KEYS.indexOf(where.path);
      if (e.key === "ArrowLeft") go(PATH_KEYS[(i - 1 + PATH_KEYS.length) % PATH_KEYS.length]!);
      if (e.key === "ArrowRight") go(PATH_KEYS[(i + 1) % PATH_KEYS.length]!);
      if (e.key === "ArrowUp") go(where.path, where.step - 1);
      if (e.key === "ArrowDown") go(where.path, where.step + 1);
      /* 投屏的退出口是系统级动作（希沃遥控的退出键），不在被投的画面上
         留任何按钮。原型里对应 Esc。 */
      if (e.key === "Escape" && casting) go("cast", 2);
      if (e.key === "Escape" && scene.dialog) setScene((s) => ({ ...s, dialog: null }));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, where.path, where.step, casting, scene.dialog]);

  /* 回执自动消失：评审者看完就该让位，别一直压在画面上。 */
  useEffect(() => {
    if (!scene.toast) return;
    const t = setTimeout(() => setScene((s) => ({ ...s, toast: null })), 20000);
    return () => clearTimeout(t);
  }, [scene.toast]);

  const patchBoard = (b: Board) => setScene((s) => ({ ...s, board: b }));
  const demo = (what: string) =>
    setScene((s) => ({ ...s, toast: `演示里这一步的落点：${what}。底下不接真实数据。` }));

  const rerun = () =>
    setScene((s) => {
      const n = movedCount(s.board);
      return {
        ...s,
        dialog: {
          kind: "danger",
          title: "重跑解析会覆盖你摆好的一切",
          body: n
            ? <>
                你已经挪动了{" "}
                <b className="tabular-nums text-neutral-900 dark:text-white">{n}</b>{" "}
                块区域，重跑会把整份编排
                <b className="text-neutral-900 dark:text-white">整份覆盖</b>，不做合并。
                <br />本次会话内可以回滚一次；刷新或关掉标签页就没了。
              </>
            : <>
                画布上还没有任何编排，重跑只是重新算一遍裁切与分组。
                <br />本次会话内可以回滚一次；刷新或关掉标签页就没了。
              </>,
          cancel: "取消", confirm: "仍然重跑",
        },
      };
    });

  const castMain = ["operating", "arranged", "moved-one", "moved-group",
                     "scattered", "one-block-full"].includes(scene.screen);

  return (
    <div className="isolate fixed inset-0 overflow-hidden bg-neutral-100 text-neutral-900
                    dark:bg-neutral-950 dark:text-neutral-100">
      <Canvas
        board={scene.board}
        zoom={scene.zoom}
        fill={scene.fill}
        fitNonce={fitNonce}
        interactive={!casting && !scene.busy && !scene.dialog}
        onBoard={patchBoard}
        onSelect={(id) => patchBoard({ ...scene.board, selected: id })}
      />

      <Topbar where={where} go={go} casting={casting} hint={step.hint} />

      {/* 热点层：只在解析中和对话框期间盖住画布。早先连未拍板也盖，
          但未拍板正是最需要点块、最需要拖手柄的时候——盖上之后界面
          对操作者说「拖四角」而手拖不动。 */}
      {(scene.busy || scene.dialog) && (
        <div className={`absolute inset-0 z-30 ${scene.busy ? "cursor-not-allowed" : ""}`} />
      )}

      {!casting && (
        <Chrome
          screen={scene.screen}
          castMain={castMain}
          onCast={() => go("cast", 1)}
          onFit={() => setFitNonce((n) => n + 1)}
          onRerun={rerun}
          onDemo={demo}
        />
      )}

      {!casting && step.hint && (
        <p id="hint" className="pointer-events-none fixed top-16 left-1/2 z-40
                      max-w-[min(92vw,34rem)] -translate-x-1/2 rounded-(--radius)
                      bg-emerald-600 px-3 py-1.5 text-center text-pretty text-sm text-white
                      [--radius:var(--radius-xl)]">
          {step.hint}
        </p>
      )}

      {scene.toast && (
        <p className="pointer-events-none fixed bottom-20 left-1/2 z-60 max-w-[min(92vw,28rem)]
                      -translate-x-1/2 rounded-(--radius) bg-neutral-950 px-3.5 py-2
                      text-sm text-white ring-1 ring-white/10
                      [--radius:var(--radius-xl)]">
          {scene.toast}
        </p>
      )}

      {scene.dialog && (
        <DialogBox
          title={scene.dialog.title}
          body={scene.dialog.body}
          danger={scene.dialog.kind === "danger"}
          cancel={scene.dialog.cancel}
          confirm={scene.dialog.confirm}
          onCancel={() => setScene((s) => ({ ...s, dialog: null }))}
          onConfirm={() => go("rerun", 2)}
        />
      )}

      <p className="pointer-events-none fixed right-3 bottom-3 z-60 rounded-full bg-white
                    px-2.5 py-1 text-[0.625rem] font-semibold tracking-wide text-red-700
                    ring-1 ring-red-200 dark:bg-neutral-900 dark:text-red-400 dark:ring-red-900">
        PROTOTYPE
      </p>
    </div>
  );
}

function build(p: string, s: number): Scene {
  const path = PATHS[p] ?? PATHS[PATH_KEYS[0]!]!;
  const step = path.steps[Math.min(Math.max(0, s), path.steps.length - 1)]!;
  return step.build();
}

/* ---------- 顶部：评审脚手架 ---------- */
function Topbar(props: {
  where: { path: string; step: number };
  go: (p: string, s?: number) => void;
  casting: boolean;
  hint: string;
}) {
  const { where, go, casting, hint } = props;
  const p = PATHS[where.path]!;
  const i = PATH_KEYS.indexOf(where.path);
  const canBack = where.step > 0;
  return (
    <header className="fixed inset-x-0 top-0 z-40 flex items-center gap-x-3 border-b
      border-neutral-950/5 bg-neutral-950/85 px-3 py-2 text-white">
      <div className="flex min-w-0 flex-1 items-center gap-x-3">
        <p className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[0.6875rem]
                      leading-4 font-semibold tabular-nums">路径 {p.no}/12</p>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{p.name}</span>
          {/* 投屏时画面上不能有任何提示，路标就挪到这条脚手架的副标题上 */}
          <span className="block truncate text-[0.6875rem] text-neutral-400">
            {casting ? hint : p.budget}
          </span>
        </span>
        <span className="mx-1 hidden h-5 w-px shrink-0 bg-white/15 sm:block" />
        <span className="hidden items-center gap-x-1.5 sm:flex">
          {PATH_KEYS.map((k, n) => (
            <button key={k} type="button" onClick={() => go(k)}
              aria-label={`第 ${n + 1} 条：${PATHS[k]!.name}`}
              className={`h-1.5 rounded-full transition-[width]
                ${n === i ? "w-5 bg-emerald-400" : "w-1.5 bg-white/25 hover:bg-white/50"}`} />
          ))}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-x-1">
        <span className="hidden text-xs tabular-nums text-neutral-400 md:block">
          步 {where.step + 1}/{p.steps.length}
        </span>
        <IconButton
          label={canBack ? "上一步" : "已是第一步"}
          onClick={() => canBack && go(where.path, where.step - 1)}
          className={canBack ? "" : "opacity-30"}
          glyph={<Glyph icon={canBack ? Icons.undo : Icons.none} className="fill-white" />}
        />
        <IconButton label="上一条路径" onClick={() => go(PATH_KEYS[(i - 1 + PATH_KEYS.length) % PATH_KEYS.length]!)}
          className="bg-white/10 hover:bg-white/25"
          glyph={<Glyph icon={Icons.prev} className="fill-white group-hover:fill-white" />} />
        <IconButton label="下一条路径" onClick={() => go(PATH_KEYS[(i + 1) % PATH_KEYS.length]!)}
          className="bg-white/10 hover:bg-white/25"
          glyph={<Glyph icon={Icons.next} className="fill-white group-hover:fill-white" />} />
      </div>
    </header>
  );
}

/* ---------- 底部：被评审的设计 ---------- */
function Chrome(props: {
  screen: string;
  castMain: boolean;
  onCast: () => void;
  onFit: () => void;
  onRerun: () => void;
  onDemo: (what: string) => void;
}) {
  const { screen, castMain, onCast, onFit, onRerun, onDemo } = props;
  const items: ReactNode[] = [];
  const btn = (key: string, label: string, variant?: "primary" | "ghost") =>
    <TextButton key={key} variant={variant} onClick={() => onDemo(label)}>{label}</TextButton>;

  /* 按「这一屏在等什么」分派，而不是把条件一路累加。累加式很容易在两个
     分支各塞一个 primary，然后评审者点错的那个就没了。 */
  switch (screen) {
    case "empty":
      items.push(<p key="drop" className="px-3 text-sm text-neutral-500">
        把图片或 PDF 拖到画面任意位置</p>);
      break;
    case "rejected":
      items.push(btn("pdf", "把 DOCX 另存为 PDF 再投", "primary"));
      break;
    case "ready":
      items.push(<TextButton key="parse" variant="primary" onClick={() => onDemo("解析")}>解析</TextButton>);
      break;
    case "parsing":
      items.push(<p key="busy" className="px-3 text-sm text-neutral-500">解析中…</p>);
      break;
    case "pending":
      items.push(btn("all", "全部接受", "primary"), btn("each", "逐个查看"));
      break;
    case "pending-focus":
      items.push(btn("ok", "接受", "primary"), btn("edit", "改框"),
                 btn("rest", "其余全部接受", "ghost"));
      break;
    case "editing":
      items.push(btn("ok", "接受此框", "primary"), btn("reset", "复位", "ghost"),
                 btn("rest", "其余全部接受"));
      break;
    case "selected": case "grouped-sel":
      items.push(btn("split", "拆开"), btn("merge", "合并"), btn("more", "继续切碎"));
      break;
    case "grouped":
      items.push(btn("gsplit", "拆开分组"), btn("gmerge", "合并分组"));
      break;
    case "moved-one": case "moved-group": case "arranged": case "operating":
      items.push(<IconButton key="undo" label="撤销" onClick={() => onDemo("撤销")}
        glyph={<Glyph icon={Icons.undo} />} />);
      break;
  }

  if (["scattered", "grouped", "operating", "moved-one", "moved-group", "arranged",
       "split", "split-rows"].includes(screen)) {
    items.push(<IconButton key="fit" label="适应画布" onClick={onFit}
      glyph={<Glyph icon={Icons.fit} />} />);
  }

  /* 没内容就不给「投屏」——没有东西可以投。一个点了没反应的常驻按钮
     比没有更糟：它会让人以为投屏坏了。 */
  const hasContent = screen !== "empty" && screen !== "rejected" && screen !== "ready"
    && screen !== "parsing";
  if (hasContent) {
    /* 投屏和重跑之间也隔一道：一个常用，一个毁活。距离本身比一句
       「小心点」便宜。分隔用分组而不是 margin——general.md 禁止在
       flex 子项之间用 ml-*。 */
    const sep = <span key="sep" className="h-4 w-px shrink-0 bg-neutral-950/10 dark:bg-white/15" />;
    items.push(sep,
      <TextButton key="cast" variant={castMain ? "primary" : "secondary"} onClick={onCast}>投屏</TextButton>,
      sep,
      <IconButton key="rerun" label="重跑解析" onClick={onRerun}
        glyph={<Glyph icon={Icons.redo}
          className="fill-red-600 dark:fill-red-400 group-hover:fill-red-600" />} />,
    );
  }

  return (
    <div id="chrome" className="fixed bottom-3.5 left-1/2 z-40 -translate-x-1/2">
      <div className="flex max-w-[min(96dvw,44rem)] items-center gap-x-2 overflow-x-auto
        rounded-(--radius) bg-white/90 p-(--padding) shadow-sm ring-1 ring-neutral-950/10
        backdrop-blur-sm dark:bg-neutral-900/90 dark:shadow-none dark:ring-white/10
        [--radius:var(--radius-xl)] [--padding:--spacing(1.5)]">
        <div className="flex shrink-0 items-center gap-x-0.5">{items}</div>
      </div>
    </div>
  );
}

/* ---------- 确认框 ----------
   文案规则：说清会丢什么、可不可回退。不做「确定吗？」 ---------- */
function DialogBox(props: {
  title: string;
  body: ReactNode;
  danger: boolean;
  cancel: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/40 p-4
                    backdrop-blur-[2px]">
      <div role="dialog" aria-modal="true" aria-label={props.title}
        className="w-full max-w-md rounded-(--radius) bg-white p-5 shadow-xl
        ring-1 ring-neutral-950/10 dark:bg-neutral-900 dark:shadow-none dark:ring-white/10
        [--radius:var(--radius-2xl)]">
        <div className="flex items-start gap-x-3">
          <span className="mt-px shrink-0">
            <Glyph icon={props.danger ? Icons.warn : Icons.info}
              className={props.danger
                ? "fill-red-600 dark:fill-red-500"
                : "fill-neutral-400"} />
          </span>
          <div className="min-w-0">
            <h2 className="text-balance text-sm font-semibold">{props.title}</h2>
            <div className="mt-1.5 text-pretty text-sm text-neutral-600 dark:text-neutral-400">
              {props.body}
            </div>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-x-2">
          <TextButton onClick={props.onCancel}>{props.cancel}</TextButton>
          <TextButton variant={props.danger ? "danger" : "primary"} onClick={props.onConfirm}>
            {props.confirm}
          </TextButton>
        </div>
      </div>
    </div>
  );
}
