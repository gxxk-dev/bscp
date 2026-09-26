// ===========================================================================
// fixture：e2e 用的那些字节。
// ===========================================================================
// 两类东西，各有各的讲究：
//
//   · **真 PNG** —— 必须在**页面里现场画**。不能从 base64 字面量里解出来。
//     demo 的 `smoke.mjs` 里那个 114 字节的 base64 PNG 其实是**截断的**：
//     服务端 Pillow 的 `im.verify()` 会抛 Truncated File Read，于是每一次
//     投放都变成 `corrupt_image` 拒收。demo 侧不碰 Pillow，所以它一路绿
//     到今天；产品链路是真过一遍 Pillow 的，症状却是「画布上 0 块」——
//     看着像锚点逻辑坏了，实际坏的是测试自己的素材。
//
//   · **假 docx / 假 pdf / 坏图** —— 就是几行字节，故意做得不像。
//
// ## 为什么尺寸是这三个
//
//   1×1      「小图不放大」（AC）：fitInto 的 k 恒 `Math.min(1, …)`，
//            所以 1×1 的图上屏就该是 1×1，而**不是**被撑成 42% 视野。
//   100×100  异尺寸收拢的「小的那一份」。它必须是**小**的：收拢的旧算法
//            只看最后一项的右边缘，最后一项小才会把 bug 露出来。
//   3000×2000 手机实拍照那个量级。按原尺寸摆的话一张就把整块画布吞掉，
//            第二份连落脚的缝都没有——所以它要能触发「默认大小按视野份额收」。
//
// ## 为什么三份 PNG 的字节必须不同
//
// 资源身份是**内容哈希**（ADR-0015）。两份字节相同的 fixture 会被服务端
// 认成同一份资源，第二次投放回 `alreadyPresent`，画布上不新增区域——
// 于是「投三份应当有三块」全部变成空过，而且红起来的时候症状是
// 「收拢算法坏了」。所以这里**在构建时**就按 sha256 撞一遍，撞上直接抛：
// 素材坏了要当场炸，而不是在几百行断言之后以一个误导性的症状炸。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 画一张真的 PNG 并落盘。**只能在浏览器里画**（见文件头）。 */
async function drawPng(page, w, h, rgb, label) {
  const b64 = await page.evaluate(
    ([w, h, rgb, label]) =>
      new Promise((res, rej) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.fillStyle = rgb;
        g.fillRect(0, 0, w, h);
        /* 往里画点东西。纯色块压出来太小：几份都太小的图更容易撞成同一份
           字节——那正是 ADR-0015 要去重的情形，测试里不要自己撞上。
           1×1 画不了字（画布只有一像素），那一档靠尺寸本身区分。 */
        if (w >= 24 && h >= 24) {
          g.fillStyle = "#111";
          g.font = `${Math.max(8, Math.round(h / 8))}px sans-serif`;
          g.fillText(label, 8, Math.round(h / 2));
        }
        c.toBlob(
          (b) => {
            if (!b) return rej(new Error("canvas.toBlob 没能产出字节"));
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result).split(",")[1]);
            fr.onerror = () => rej(fr.error ?? new Error("读 dataURL 失败"));
            fr.readAsDataURL(b);
          },
          "image/png",
        );
      }),
    [w, h, rgb, label],
  );
  return Buffer.from(b64, "base64");
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * 建好全部 fixture。返回按角色命名的路径表。
 *
 * @param {import("playwright-core").Browser} browser
 * @param {string} dir 落盘目录
 */
export async function buildFixtures(browser, dir) {
  mkdirSync(dir, { recursive: true });

  // 一次性借一个 page 画图，画完就关。不复用 e2e 的任何一个屏——
  // fixture 是素材，不该带进任何一次「一个场景只 goto 一次」的计数里。
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const paths = {
    /** 1×1：「小图不放大」那一档。 */
    tiny: join(dir, "像素.png"),
    /** 100×100：异尺寸收拢里「小的那一份」。 */
    small: join(dir, "小图.png"),
    /** 3000×2000：实拍照量级，触发默认大小按份额收。 */
    photo: join(dir, "板书实拍.png"),
    /** 中等尺寸的普通一份，摊开 / 回执 / 往返都用它。 */
    exam: join(dir, "月考卷.png"),
    handout: join(dir, "讲义.png"),
    /** 800×3000 **竖向**：`SHARE.h = 0.6` 那一半唯一能被执行到的形状。
        没有它时全部素材都是横向或正方，高份额永远不是紧的那个约束，
        把 `SHARE.h` 改成 0.05 一样全绿。 */
    tall: join(dir, "竖版讲义.png"),
    /** **同样大小**、只有颜色不同的三份：异尺寸收拢那条的阳性对照。 */
    same1: join(dir, "同尺寸一.png"),
    same2: join(dir, "同尺寸二.png"),
    same3: join(dir, "同尺寸三.png"),
    /** 扩展名说了是图片，内容却不是：服务端该判 corrupt_image。 */
    broken: join(dir, "坏图.png"),
    docx: join(dir, "作业.docx"),
    pdf: join(dir, "讲义.pdf"),
  };

  const drawn = [
    [paths.tiny, 1, 1, "#ef4444", "1"],
    [paths.small, 100, 100, "#eef2ff", "100"],
    [paths.photo, 3000, 2000, "#334155", "3000"],
    [paths.exam, 1200, 800, "#f4f4f5", "1200"],
    [paths.tall, 800, 3000, "#eef2ff", "竖"],
    [paths.handout, 640, 480, "#ecfdf5", "640"],
    [paths.same1, 500, 400, "#fef2f2", "1"],
    [paths.same2, 500, 400, "#f0f9ff", "2"],
    [paths.same3, 500, 400, "#faf5ff", "3"],
  ];

  /* 画完先自己撞一遍哈希。撞上了就抛——素材坏了要当场炸，
     而不是几百行之后以「收拢算法坏了」这个误导症状炸。 */
  const digests = new Map();
  const sizes = [];
  for (const [path, w, h, rgb, label] of drawn) {
    const buf = await drawPng(page, w, h, rgb, label);
    const d = sha(buf);
    if (digests.has(d)) {
      throw new Error(
        `fixture ${path} 与 ${digests.get(d)} 的字节完全相同（sha256 ${d.slice(0, 12)}…）。` +
          "内容哈希就是资源身份（ADR-0015），两份相同的素材会让第二次投放被去重掉，" +
          "后面所有「应当有 N 块」的断言都变成空过。换一张图。",
      );
    }
    digests.set(d, path);
    writeFileSync(path, buf);
    sizes.push(`${w}×${h} ${buf.length}B`);
  }
  await ctx.close();

  writeFileSync(paths.broken, Buffer.from("not an image at all"));
  writeFileSync(paths.docx, Buffer.from("PK fake docx"));
  writeFileSync(paths.pdf, Buffer.from("%PDF-1.4\n% fake\n"));

  return {
    paths,
    /** 素材的体检报告，进 e2e 的观察行——坏了要一眼看得出是素材的锅。 */
    report: `fixture ${digests.size} 份真 PNG 字节互不相同（${sizes.join("，")}），` +
      "外加 坏图.png / 作业.docx / 讲义.pdf",
  };
}
