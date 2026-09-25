---
status: superseded by ADR-0008
---

# DOCX 走 OOXML 直解，PDF 走文字层：两条输入路径，都不渲染

> 本 ADR 已被 [ADR-0008](./0008-image-only-rasterize-first.md) 推翻——两条路径都取消了，
> 资源一律先栅格化。原文保留以备追溯；其中「栅格化是渲染的产物而非其替代」这一判断
> 仍然是本 ADR 的遗产，它正是 0008 要面对的成本。

DOCX 与 PDF 各走一条读取路径，但**两条都不需要渲染引擎**：

- **PDF 是已排版的格式**：每个文字段的坐标固化在文件里，直接读出来即可。
- **DOCX 的逐字坐标不存在**（正文是流式排版，坐标在渲染时才产生），但**它需要的
  那点版面信息在 OOXML 里是现成的**：

  | 需要什么 | OOXML 里在哪 |
  |---|---|
  | 分栏 | `w:sectPr/w:cols` 的 `w:num` / `w:space` / `w:equalWidth` / `w:col` |
  | 图文框位置 | `wp:anchor` + `wp:positionH/V` + `relativeFrom` + `posOffset`/`align` |

  两者都是普通 XML，浏览器 `DOMParser` 直接可读，**零第三方依赖**。

关键判断：我们先前的错误在于问错了问题——问的是「能不能拿到逐字坐标」，而实际上
**区域级的版面结构就够了**（区域本来就是块，不是像素）。逐字坐标只有渲染器能给，
但我们不需要它。

## Considered Options

- **服务端 LibreOffice 渲染成 PDF**：唯一被大规模验证的路线，官方 `--convert-to`
  语法完整。代价：镜像压缩层 **0.5–1.0 GB**；官方 bug tracker 上「headless 转 PDF
  卡死 / 内存耗尽 / 非确定性换行」**全部仍是 open**；缺中文字体必然被替换
  （官方帮助页承认）。为了拿分栏信息而引入一个 1GB 的渲染器，不划算。
- **浏览器内 LibreOffice WASM**（ZetaOffice / LOWA）：确实存在，`zetajs` 1.2.0 为 MIT，
  官方 `convertpdf` 示例就是浏览器内转 PDF。代价：必须 COOP/COEP 跨源隔离；
  免费 CDN 实测传输 **≈53 MB**（wasm 36.3 MB Brotli + data 15.9 MB）；运行时
  **1 GB 级内存**。而且其 WASM 产物本身的许可与费用条款**查不到书面依据**。
- **纯 JS 库**（mammoth / docx-preview）：官方明说只输出 HTML 流、忽略边框与字体细节、
  文本框被降级成独立段落。无坐标，仅可作预览。
- **统一栅格化**：见下。

## Consequences

- **「统一栅格化」被否掉一半前提**：栅格化是渲染的**产物**，不是替代——
  它绕不开「谁来渲染 DOCX」这个问题。而且它丢掉文字层、放大即糊（区域被放大到
  可读正是本项目的核心诉求）。因此栅格化**只作兜底**：文字层损坏的 PDF、
  以及读不出结构的 DOCX。
- **唯一实质风险是图文框**：`relativeFrom=page/margin` 可直算绝对坐标；
  `=paragraph/character` 仍需排版引擎定位；`wp:inline` 干脆没有坐标。
  这类内容只能退到栅格化路径处理。
- **浏览器侧可以独立完成 DOCX 解析**，与「文件尽留在浏览器」的取向一致，
  也让服务端不必为 DOCX 承担渲染成本。
- 真机实验清单见 `docs/research/docx-conversion.md` 的 E1–E10，其中最要紧的是
  `w:cols` 在真实校内材料里的**命中率**（分栏到底以什么形式出现），
  以及中文字体环境下的保真度比对。
