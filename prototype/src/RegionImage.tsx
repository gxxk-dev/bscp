/* ===========================================================================
   区域位图：一次往返 → 一个 blob: URL，然后一直用着。
   ===========================================================================
   ## 为什么要在 ingest 响应回来时就把位图抓成 Blob

   投屏是这一轮里**唯一**不许有网络往返的时刻。投出去的每一块都要是已经
   落在本地的字节：一体机上课时网络不一定还在，而投到一半再白一次屏，
   比没投出去更糟。

   所以位图在 ingest 响应回来时就立刻 fetch 成 Blob 并 `createObjectURL`，
   按 `(artifactId, cropKey)` 缓存。缓存键就是 `Region.id`，它**已经是**
   `${artifactId}#${regionId}`——服务端生成的，见 ingest.ts。

   `casting` 因此只是一道**渲染门**：它不重建 board、不触发任何取景、
   也不发一个请求。屏上每一块的 `src` 早就是 blob: URL 了。

   ## 为什么不 revoke 到 unmount

   曾经想在组件卸载时 revoke。后果是**投屏变白**：投屏就是「那一批块仍然
   挂载着，只是不许碰」，任何一次重渲染导致的重新挂载都会把 URL 收走，
   而 `<img>` 手上的那个 URL 立刻失效。所以 revoke 只在**会话销毁**时做
   ——换一次课、刷新页面、或者用户点「重新开始」。那一刻之后没人再看它。 */
import { useEffect, useRef, useState } from "react";
import { fetchRegionBitmap } from "./api";
import type { Region } from "./types";

/** 缓存键 → object URL。模块级，**不在 React 状态里**：
    投屏期间这块组件可能因为任何一次重渲染被重新挂载，缓存在状态里
    就跟着丢一次。 */
const urls = new Map<string, string>();
/** 同一次往返的并发去重：两个组件同时要同一块位图时只发一个请求。 */
const inflight = new Map<string, Promise<string>>();

/** 缓存里现成的 URL，没有就是 undefined。同步读——所以命中缓存的块
    在**首帧**就有 src，不会闪一帧空白。 */
export function cachedRegionUrl(key: string): string | undefined {
  return urls.get(key);
}

/** 取一块区域位图的 blob: URL。命中缓存直接返回；否则发一次往返，
    并把同一个键的并发请求合并成一个。 */
export function regionBitmapUrl(key: string, path: string): Promise<string> {
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;

  const job = fetchRegionBitmap(path).then(
    (blob) => {
      /* 只有**成功**的往返才写缓存：失败时不能把一个坏结果钉住，
         否则这一整轮会话里这块永远是坏的。 */
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      inflight.delete(key);
      return url;
    },
    (err) => {
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, job);
  return job;
}

/** ingest 响应回来之后立刻把整批位图抓成本地字节。
    返回成功表**与**失败表**——分开是因为「这块的位图没取到」和「这一轮已经
    结束了」要给操作者两句完全不同的话：前者是逐块的占位加重试，后者是
    `session_expired` 的错误屏。`Promise.allSettled` 两边都收下，别让
    一个 410 静悄悄地被当成「这块坏了」。

    抓失败的那几块不在 `urls` 里，由 RegionImage 自己显示占位并重试——
    一批里有坏的不该让另外几块也上不了屏。 */
export async function prefetchRegionBitmaps(
  entries: { key: string; path: string }[],
): Promise<{ urls: Map<string, string>; errors: Map<string, unknown> }> {
  const settled = await Promise.allSettled(
    entries.map((e) => regionBitmapUrl(e.key, e.path)),
  );
  const urls = new Map<string, string>();
  const errors = new Map<string, unknown>();
  settled.forEach((s, i) => {
    const key = entries[i]!.key;
    if (s.status === "fulfilled") urls.set(key, s.value);
    else errors.set(key, s.reason);
  });
  return { urls, errors };
}

/** 会话销毁时收走全部 blob: URL。**只在那一刻调**，理由见文件头。 */
export function releaseRegionBitmaps(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  inflight.clear();
}

/* ---------- 渲染 ----------
   Canvas 的区域盒原来直接写 `<img src={r.src}>`。demo 那条路径的 `src`
   是本地 File 的 object URL（根本没有网络），产品这条路径的 `src` 是
   上面缓存好的位图 URL。两种都归到这里，于是「一块的位图怎么显示出来」
   全应用只有一处答案。 */

/** 一块位图最多试几次。**瞬时失败（网络抖一下、服务端重启、一次 500）在
    课堂一体机上很常见，而「投屏」是这一轮唯一的主动作——第一次失败就把它
    永久锁住，操作者除了刷页面（丢掉全部编排）没有第二条路。 */
const MAX_ATTEMPTS = 3;
/** 重试之间的退避。短到操作者察觉不到，长到不给刚重启的服务端雪上加霜。 */
const RETRY_DELAY_MS = 400;

/** 到位了就叫一次。**`ProductApp` 用它把这一块从「还没到位」里划掉。

    没有这条回调时，pending 只在 ingest 那一刻算一次，之后谁都不回写——
    于是 RegionImage 自己重试成功了、位图明明在屏上，「投屏」却永远停在
    secondary 且按下去什么都不发生。同一个属性两套真相。 */
export function RegionImage(props: { r: Region; onSettled?: (id: string) => void }) {
  const { r } = props;
  /* src 已经给了就直接用（demo 路径与预取成功的块）；否则按 bitmapPath
     现取。命中缓存时这是同步的，不产生一次额外请求。 */
  const [url, setUrl] = useState<string | undefined>(() => r.src ?? urls.get(r.id));
  const [failed, setFailed] = useState(false);

  /* 回调走 ref 读最新的。**不能**进 effect 的依赖：`onSettled` 每次渲染都是
     新函数，进依赖就意味着父组件一重渲染就把 effect 重跑一遍、把已经拿到的
     `url` 丢掉——那正是这块位图反复闪烁的来源。 */
  const settled = useRef(props.onSettled);
  settled.current = props.onSettled;

  useEffect(() => {
    const path = r.bitmapPath;
    if (url || r.src || !path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const tryOnce = () => {
      attempt += 1;
      regionBitmapUrl(r.id, path).then(
        (u) => {
          if (!alive) return;
          setUrl(u);
          setFailed(false);
          /* 只在真的拿到字节时上报。**失败不上报**——那样 ProductApp 会把
             这块当成「到位了」，于是投屏会投出一块空白。 */
          settled.current?.(r.id);
        },
        () => {
          if (!alive) return;
          if (attempt < MAX_ATTEMPTS) {
            timer = setTimeout(tryOnce, RETRY_DELAY_MS * attempt);
            return;
          }
          setFailed(true);
        },
      );
    };

    setFailed(false);
    tryOnce();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [r.id, r.bitmapPath, r.src, url]);

  if (!url) {
    /* 还没到位，或者试了三次都没到。不画一块空白：留一个说清「这块的位图没取到」
       的格子，比让操作者以为这块本来就是空的强。

       上面刻意没把失败写进缓存，所以它**永远是可重试**的：这三轮之外再来一次
       落点（重新投放同一份内容、换一次屏态）都会重新发起。这里的文案不承诺
       「正在重试」——那三轮跑完之后就是一句假话，而 ProductApp 的「投屏」按钮
       才是此刻该看的地方。 */
    return (
      <div className="grid size-full place-items-center bg-neutral-100 p-3 text-center
                      text-xs text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
        {failed ? "这块的位图没取到" : "位图加载中…"}
      </div>
    );
  }
  /* 区域是服务端裁出来的一块图，**铺满 rect**。裁切框就是它的全部内容，
     四周再留白等于在告诉评审者「这一块还有一部分没投出来」。 */
  return <img src={url} alt="" className="size-full" draggable={false} />;
}
