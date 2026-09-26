/* ===========================================================================
   错误屏：这一轮结束了。
   ===========================================================================
   ## 为什么它是一整屏，不是一块浮在画布上的小面板

   现状是 `ProductApp` 里那个贴着底栏的 `ProblemPanel`。它有四个毛病，
   每一个单拎出来都够换掉它：

     1. **不接管视线。** 面板压在画布上，操作者看得见自己刚摆的那几块，
        于是他会以为「东西还在，只是有点问题」——然后一直等。
     2. **会被下一次投放顶掉。** `ingest` 一进来就 `setProblem(null)`，
        而 canvas 在 error 态是不可交互的：屏上出现一个既没有出口、
        又摆着一堆看起来还能拖的东西的死局。
     3. **它暗示这一轮还在继续。** 可会话没了意味着服务端那份页位图已经
        放掉了（ADR-0014：页位图只在服务端内存里留 30 分钟），画布上剩的
        是几张**没有出处的空壳**。让人继续对着一堆空壳操作，比直接告诉他
        「这一轮结束了，重新开始」糟糕得多。
     4. **焦点无处可去。** 它不是对话框，没有 `role="dialog"`，也不接管
        焦点。键盘与一体机的屏幕阅读器用户会发现自己还停在那个已经
        失效的「投屏」按钮上。

   所以这里给的是**一整屏**：铺满、接管焦点、不自动消失、没有第二个
   primary。

   ## 为什么不复用 DemoApp 的 `DialogBox`

   那个对话框是评审脚手架的一部分，而且撑不住这里：它**固定两个按钮**、
   `kind` 只有二值（`info` / `danger`）、没有焦点陷阱也没有焦点归还。
   「会话没了」要的是一个**终态**——终态上的对话框看着像「这个还能点」，
   而这里唯一能点的那件事是「从头再来」，它不是一个取消得掉的对话框。

   ## 只有一个动作

   重新开始。`ApiError` 上有 `retryable`，理论上可以给个「重试」，
   但这一版刻意不给：会话没了重试多少次都是同一个 410（重投会再建一个
   会话，那已经是「重新开始」了），而给一个注定失败的动作留位置，
   比不给更让人多按一次。`message` / `detail` 两句已经说清了发生了什么。 */
import { useEffect, useRef } from "react";
import { Glyph, Icons, TextButton } from "./ui";

export type Problem = {
  /** 拒收码。给样式与将来可能的分支用，屏上不摆出来——摆出来操作者
      读不懂，而 `message` 才是给操作者的那一句。 */
  code: string;
  /** 一句话：发生了什么。 */
  message: string;
  /** 更细的一句，给「为什么」。 */
  detail: string;
  /** 410 家族 = 会话没了。出路只有「重新开始」。 */
  gone: boolean;
};

export function ErrorScreen(props: {
  problem: Problem;
  onRestart: () => void;
}) {
  const { problem, onRestart } = props;
  const restart = useRef<HTMLDivElement>(null);

  /* 接管焦点。**不是**锦上添花：出错之前焦点多半停在「投屏」上，
     而那一屏已经整体撤掉了控件——焦点落在一个已经从 DOM 里消失的
     元素上时，Tab 的下一步是未定义的，操作者会以为整块屏死了。 */
  useEffect(() => {
    restart.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div
      id="error-screen"
      role="alert"
      aria-live="assertive"
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-100 px-6
                 dark:bg-neutral-950"
    >
      <div
        ref={restart}
        data-problem-code={problem.code}
        className="w-[min(92vw,32rem)] rounded-(--radius) bg-white p-5 shadow-lg
                   ring-1 ring-red-200 dark:bg-neutral-900 dark:shadow-none
                   dark:ring-red-900 [--radius:var(--radius-xl)]"
      >
        <p className="flex items-start gap-x-2 text-base font-semibold text-neutral-900
                      dark:text-white">
          <Glyph icon={Icons.warn} className="mt-px fill-red-600 dark:fill-red-500" />
          {problem.message}
        </p>
        <p className="mt-1.5 text-pretty text-sm leading-6 text-neutral-600
                      dark:text-neutral-400">
          {problem.detail}
        </p>

        {/* 整屏唯一一处动作，也是整屏唯一的 primary（buttons.md）。
            焦点已经在上面那个 effect 里落到它身上了，环是 `focus-visible`
            给的——自动 focus 不会点亮它，避免一进来就糊着一圈。 */}
        <div className="mt-4">
          <TextButton variant="primary" onClick={onRestart}>重新开始</TextButton>
        </div>
      </div>
    </div>
  );
}
