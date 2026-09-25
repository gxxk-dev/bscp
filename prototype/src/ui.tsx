/* ===========================================================================
   控件原语
   ===========================================================================
   规范来源 ~/.claude/skills/design/guidelines/，每条都标在相关处。
   图标一律来自 @heroicons/react 官方包，20/solid 一档，viewBox 0 0 20 20，
   规范里这一档只配 size-5——不跨档放大。 */
import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  ArrowPathIcon, ArrowUturnLeftIcon, ArrowsPointingOutIcon,
  ChevronLeftIcon, ChevronRightIcon, ExclamationTriangleIcon,
  InformationCircleIcon, MinusIcon,
} from "@heroicons/react/20/solid";

/* ---------- 按钮 ----------
   buttons.md：一屏最多一个 primary；主按钮必须是最显眼的那个；
   实心按钮要配自己的 focus ring。 */
type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-emerald-600 text-white ring-1 ring-emerald-600 hover:bg-emerald-700 " +
    "focus-visible:outline-emerald-600",
  secondary:
    "bg-neutral-950/5 text-neutral-900 ring-1 ring-neutral-950/10 hover:bg-neutral-950/10 " +
    "dark:bg-white/10 dark:text-white dark:ring-white/10 focus-visible:outline-neutral-500",
  danger:
    "bg-red-600 text-white ring-1 ring-red-600 hover:bg-red-700 focus-visible:outline-red-600",
  ghost:
    "text-neutral-600 ring-1 ring-transparent hover:bg-neutral-950/5 " +
    "dark:text-neutral-300 dark:hover:bg-white/10 focus-visible:outline-neutral-500",
};

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2";

export function TextButton(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  title?: string;
}) {
  const { children, onClick, variant = "secondary", title } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex shrink-0 items-center gap-x-1.5 rounded-(--radius) px-3 py-1.5
        text-sm font-medium whitespace-nowrap ${VARIANT[variant]} ${FOCUS}`}
    >
      {children}
    </button>
  );
}

/* 两种按钮尺寸：28 / 36，差 8px ≥ 6px。48×48 命中区由 hit-expand 补足，
   且只在粗指针设备上生效（pointer-fine:hidden），鼠标用户不吃它。 */
export function IconButton(props: {
  glyph: ReactNode;
  label: string;
  onClick?: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const { glyph, label, onClick, size = "sm", className = "" } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`group relative grid place-items-center rounded-(--radius) ring-1
        focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-emerald-600 hover:bg-neutral-950/5
        dark:hover:bg-white/10 ${size === "sm" ? "size-7" : "size-9"} ${className}`}
    >
      {glyph}
      <span className="hit-expand" aria-hidden="true" />
    </button>
  );
}

/* icons.md：实心图标用 fill-*，不用 text-* + currentColor。
   className 直接落到 svg 上，尺寸只在这一处决定——多包一层 span
   只会让「这个图标到底多大」有两个答案。 */
export function Glyph(props: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string;
}) {
  const { icon: I, className = "" } = props;
  return (
    <I
      aria-hidden="true"
      className={`size-5 shrink-0 fill-neutral-500 group-hover:fill-neutral-900
        dark:fill-neutral-400 dark:group-hover:fill-white ${className}`}
    />
  );
}

export const Icons = {
  undo: ArrowUturnLeftIcon,
  redo: ArrowPathIcon,
  fit: ArrowsPointingOutIcon,
  prev: ChevronLeftIcon,
  next: ChevronRightIcon,
  none: MinusIcon,
  warn: ExclamationTriangleIcon,
  info: InformationCircleIcon,
};

/* ---------- 标记 ----------
   badges.md：带图标的标签不能用对称 px-*。这两个都不带图标，所以对称没问题。
   它们都属于「操作痕迹」——投屏态必须能整批撤掉。 */
export function UnitTag({ unit }: { unit: string }) {
  return (
    <span className="unit-tag" aria-hidden="true">{unit}</span>
  );
}

/* 来源角标。它和手柄、选中框一样属于「操作痕迹」——投屏时必须消失，
   所以它由 board.badges 控制，而不是渲染期的一个参数。

   角标上写的是**文件名**，不是资源类别。投放可以一次给多份，只有文件名
   能回答「这一块是哪来的」；只写「第 2 份 · p1」等于让操作者自己记顺序。 */
export function SourceBadge({ artifact, page }: { artifact?: string; page: number }) {
  const label = artifact
    ? `${truncate(artifact, 14)} · p${page}`
    : `卷 · p${page}`;
  return <span className="src-badge" title={artifact ? `${artifact} 第 ${page} 页` : undefined}>{label}</span>;
}

/** 文件名可能是一长串 UUID。角标只有这么点宽度，尾巴砍掉比换行好看，
    但完整名字留在 title 里，鼠标/长按能看全。 */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
