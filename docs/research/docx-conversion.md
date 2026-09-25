# DOCX 处理路线调研：转 PDF、WASM、纯 JS、OOXML 直解

> 调研日期：**2026-09-25**。除特别注明外，所有事实均在当日抓取，来源 URL 附在条目后。
> 来源性质分级：**[规范]** ECMA-376 / ISO-29500 本体或其官方 SDK 文档；**[厂商]** 项目官方站/官方仓库/官方 Docker/官方 tracker；**[社区]** 第三方索引、issue 报告、非官方镜像。
> 凡未找到一手来源者一律标「**未确认**」，不作推测。

---

## 结论速览

1. **「普通段落没有坐标」这一条证实了**：OOXML 里正文是流式排版，段落只存语义与格式，坐标由排版引擎在渲染时算出；只有浮动对象（`wp:anchor`）才带显式定位。python-docx 官方文档用「text layer / drawing layer」把这个区别讲得很清楚。
2. **分栏能拿到**：`w:sectPr → w:cols` 有 `w:num`（栏数）、`w:space`（栏间距）、`w:equalWidth`、`w:col`（每栏宽度），是 Microsoft 官方 SDK 文档确认的。所以「这份材料是双栏、栏间距多少」不用转 PDF 就能读出来。
3. **文本框坐标能拿到，但不是绝对坐标**：`wp:positionH/@relativeFrom` 指定基准（页边距/页/栏/字符/段落），`wp:posOffset` 给该基准下的偏移。基准若是「段落/字符」，仍要先排版才知道基准在哪。
4. **服务端 LibreOffice headless 是唯一「已被大规模验证」的路线**，官方帮助页给了完整命令行。代价：镜像约 0.5–1.0 GB（压缩层），单进程串行、冷启动昂贵，且官方 tracker 里 DOCX→PDF 的卡死/内存耗尽/非确定性换行都是**未修复**的活跃 bug。
5. **浏览器 WASM（ZetaOffice/LOWA）真实存在且可用**：`zetajs` 1.2.0（MIT，2025-06）、官方 `convertpdf` 示例就是「浏览器内转 PDF」。代价是要 COOP/COEP 跨源隔离头，免费 CDN 的 wasm 传输体积 **36.3 MB + data 15.9 MB ≈ 52 MB**，且需要 1 GB 级内存。
6. **纯 JS 库只能给 HTML 流，给不了坐标**：mammoth 官方明说「忽略其他细节」、表格边框「被忽略」、文本框内容被挪成后面一个独立段落；docx-preview 官方明说「受 HTML 能力限制」、实时分页未实现。
7. **栅格化路线绕不开核心问题**：把输入统一成图片，仍然需要有人先把 DOCX 渲染出来（服务端 LibreOffice 或浏览器 WASM），它换掉的是「输出形态」，不是「渲染器」。
8. 最关键的两条**必须真机实验**：`w:cols` 在真实校内材料里的命中率，以及 LibreOffice 在**有中文字体**的容器里对双栏/题号/图文框的实际保真度。

---

## 0. 核心事实：DOCX 里普通段落到底有没有坐标？

### 结论：**证实**——正文段落没有坐标，坐标是排版时算出来的

最有力的一条原文来自 **python-docx 官方文档**（它是对 OOXML 语义的权威描述，且直接对应 Word 的行为）：

> "Conceptually, Word documents have two `layers`, a *text layer* and a *drawing
> layer*. In the text layer, text objects are **flowed from left to right and from
> top to bottom, starting a new page when the prior one is filled**. In the drawing
> layer, drawing objects, called `shapes`, are **placed at arbitrary positions**.
> These are sometimes referred to as `floating` shapes."
>
> —— `docs/user/shapes.rst`，<https://github.com/python-openxml/python-docx>（raw: `raw.githubusercontent.com/python-openxml/python-docx/master/docs/user/shapes.rst`），查证 2026-09-25

这段把两类东西的差别讲死了：

| | 正文流（text layer） | 浮动对象（drawing layer） |
|---|---|---|
| 定位方式 | 从左到右、从上到下**流动** | **任意位置**放置 |
| 文件里存了什么 | 段落顺序、样式、对齐、缩进、行距、分节属性 | `wp:anchor` + `wp:positionH/V` + `wp:posOffset` |
| 绝对坐标 | **不存在**，渲染时由排版引擎产生 | 有显式偏移，但依赖基准（见 §4.2） |

旁证：Microsoft 官方 SDK 文档对 `wp:positionH` 的定义只谈 **"floating DrawingML object"**（浮动对象），对正文段落没有任何坐标概念：

> "[ISO/IEC 29500-1 1st Edition] **positionH (Horizontal Positioning)**
> This element specifies the horizontal positioning of a **floating DrawingML object**
> within a WordprocessingML document."
>
> —— Microsoft Learn, `HorizontalPosition` class, <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.horizontalposition>（查证 2026-09-25）

**这条事实的推论（对选型是决定性的）**：

- 「直接解 OOXML 复原版面」**在正文层面做不到**——不是解析库不行，是文件里就没有这个信息。
- 想拿到正文的 x/y，**必须有一个排版引擎**（LibreOffice 的 layout、Word 的 layout，或你自己实现的 line-breaking + 字体度量）。
- 因此「OOXML 直解」的正确定位是：**拿到语义结构与区域级版面（分栏、分节、浮动对象位置）**，而不是拿到逐字坐标。逐字坐标对「切分重排」这个目标其实**不必要**（见 §7）。

---

## 1. LibreOffice headless 转换（服务端容器）

### 1.1 官方推荐的无头转换方式 —— 是，官方帮助页给了完整语法

官方帮助页 `start_parameters.xhp` 对 `--convert-to` 的完整定义：

> "`--convert-to OutputFileExtension [:OutputFilterName [:OutputFilterParams[,param]]] [--outdir output_dir]`
> If `--convert-to` is used more than once, last value of `OutputFileExtension[:OutputFilterName[:OutputFilterParams]]` is effective. If `--outdir` is used more than once, only its last value is effective.
> **In absence of `--outdir`, current working directory is used for the result.**
> For example:
> `--convert-to pdf *.doc`
> `--convert-to pdf:writer_pdf_Export --outdir /home/user *.doc`
> `--convert-to "html:XHTML Writer File:UTF8" *.doc`"

> "`--headless` Starts in "headless mode" which allows using the application without user interface. This special mode can be used when the application is controlled by external clients via the API."

> "`-env:VAR[=VALUE]` Set a bootstrap variable. For example, to set a non-default user profile path:
> `soffice -env:UserInstallation=file:///tmp/test`"

> "$[officename] **requires write access to its user profile directory**."

—— LibreOffice 帮助源文件 `source/text/shared/guide/start_parameters.xhp`，<https://github.com/LibreOffice/help>（在线版 <https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html>），查证 2026-09-25

**filter 名称（官方过滤器清单页）**：

- PDF 导出：`writer_pdf_Export`，MIME `application/pdf`
- DOCX 导入（Word 2010–365）：`Office Open XML Text`，MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- 附带发现：清单里还有一个 **`Writer Layout XML` / `writer_layout_dump`** 过滤器（输出 xml）。名字暗示它能 dump Writer 的排版结果，**这是否能作为「零成本拿到坐标」的后门，未确认**，值得单独实验（见 §7 实验清单 E5）。

—— LibreOffice 帮助源文件 `source/text/shared/guide/convertfilters.xhp`，同上仓库，查证 2026-09-25

### 1.2 并发与启动开销

**(a) 单次冷启动转换是「加载—转换—退出」，官方社区推荐改用 listener 模式**

`unoserver`（unoconv 的官方后继，现托管在 allotropia 组织下，MIT）README 原文：

> "Using LibreOffice to convert documents is easy, you can use a command like this to
> convert a file to PDF, for example:
> `$ libreoffice --headless --convert-to pdf ~/Documents/MyDocument.odf`
> **However, that will load LibreOffice into memory, convert a file and then exit LibreOffice,
> which means that the next time you convert a document LibreOffice needs to be loaded into
> memory again.**
> To avoid that, LibreOffice has a **listener mode**, where it can listen for commands via a port,
> and load and convert documents without exiting and reloading the software. **This lowers the
> CPU load when converting many documents with somewhere between 50% and 75%, meaning you can
> convert somewhere between two and four times as many documents in the same time using a listener.**"

> "You should be able to on a multi-core machine run several `unoservers` with different ports.
> There is however **no support for any form of load balancing** in `unoserver` ...
> For performant multi-core scaling, it is necessary to specify **unique values for each
> `unoserver`'s `--port` and `--uno-port` options**."

> "**there is no security on either ports used**, and as a result Unoserver is vulnerable to DDOS attacks, and possibly worse. The ports used **must not** be accessible to anything outside the server stack being used."

—— `unoconv/unoserver` README（现亦在 <https://github.com/allotropia/unoserver>），<https://raw.githubusercontent.com/unoconv/unoserver/master/README.rst>，查证 2026-09-25

**(b) `-env:UserInstallation` 的必要性**

- 官方帮助页只把 `-env:UserInstallation` 描述为「设置非默认用户配置目录」的**示例**，**并未**把它与「并发」绑定。**官方文档没有直接说「并发必须指定独立 profile」——这条未确认（官方文档层面）**。
- 但官方帮助页明确了 "$[officename] requires write access to its user profile directory"：多进程共享同一 profile 目录存在争用，物理上必须隔离。
- `unoserver` 为此提供了 `--user-installation` 选项，**默认行为是「动态创建的临时目录」**：
  > "`--user-installation`: The path to the LibreOffice user profile, defaults to a **dynamically created temporary directory**"
  这等于社区权威实现给出了「每个实例一份独立 profile」的实践答案。
- 官方 bugzilla 检索 "headless convert UserInstallation" 命中 13 条，但**没有**一条是「并发转换必须用 UserInstallation」的规范性说明；相关的是稳定性问题（见 §1.3）。

**(c) 稳定性（这条对生产很关键）** —— LibreOffice 官方 bugzilla（`bugs.documentfoundation.org`，通过官方 REST API 查询，查证 2026-09-25）：

| Bug | 状态 | 摘要 |
|---|---|---|
| [171646](https://bugs.documentfoundation.org/show_bug.cgi?id=171646) | NEW（LO 26.2.2.2，最后活动 2026-09-02） | LibreOffice writer in headless mode **hangs** when converting certain DOCX files to PDF |
| [163267](https://bugs.documentfoundation.org/show_bug.cgi?id=163267) | NEW（2026-01-29 仍有活动） | Attempting to convert a specific DOCX file to PDF **runs until memory exhaustion** |
| [170608](https://bugs.documentfoundation.org/show_bug.cgi?id=170608) | UNCONFIRMED（LO 25.8.4.2） | Headless pdf conversion **slows down significantly between versions 25.8.2 and 25.8.4 or 26.2.0** |
| [172650](https://bugs.documentfoundation.org/show_bug.cgi?id=172650) | UNCONFIRMED | **Non-deterministic line wrapping** when exporting XLSX to PDF (headless `--convert-to pdf`) |
| [172335](https://bugs.documentfoundation.org/show_bug.cgi?id=172335) | UNCONFIRMED | Libre Office **crashes** after PDF conversion with writer via UNO in headless mode |
| [171786](https://bugs.documentfoundation.org/show_bug.cgi?id=171786) | UNCONFIRMED | Remember to **return error to shell** for headless |
| [149424](https://bugs.documentfoundation.org/show_bug.cgi?id=149424) / [150768](https://bugs.documentfoundation.org/show_bug.cgi?id=150768) | NEW | Writer stuck in "layout loop" / Hang on opening and converting a DOCX file |

> **含义**：headless 转换会**挂死**、会**吃爆内存**、**不保证确定性**、**失败时不一定返回非零退出码**。这些都不是「配置问题」，是官方 tracker 上**仍然开着**的 bug。任何生产方案必须带超时、进程级隔离、以及「转换结果校验」而非「相信退出码」。

### 1.3 保真度与已知失败模式（官方口径）

**(a) 字体替换 —— 官方明说会替换，且默认行为取决于操作系统**

LibreOffice 官方帮助页（字体替换表）：

> "**Substitutes a font with a font of your choice.** The substitution replaces a font only when it is displayed on screen, or on screen and when printing. The replacement does not change the font settings that are saved in the document."

> "If you want, you can **override the default substitution font that your operating system uses when it encounters an unavailable font in a document**."

—— LibreOffice 帮助源文件 `source/text/shared/optionen/01010700.xhp`，<https://github.com/LibreOffice/help>，查证 2026-09-25

> **含义**：缺字体时 LibreOffice **一定**会替换，替换字体由操作系统默认决定；字宽一变，**断行与分页就跟着变**。校内材料几乎必然是宋体/黑体/等线/微软雅黑，Linux 容器默认**没有**这些字体，必须显式装中文字体（见 §1.4）。

**(b) 官方 wiki 的字体清单里，中文字体没有 metric-compatible 替身**

官方 wiki 的 Fonts 页列出 LibreOffice 自带字体及其捆绑理由，英文侧明确标注了度量兼容替身（例如 Carlito「Metrically compatible with Calibri」、Caladea「Metrically compatible with Cambria」）。页面清单中**未出现**宋体/黑体/微软雅黑/等线 的度量兼容替身。

—— The Document Foundation Wiki, `Fonts`，<https://wiki.documentfoundation.org/Fonts>（原站有 bot 挑战页，经 `web.archive.org` 回放读取），查证 2026-09-25

**(c) 文本框/图文框、分栏、表格边框、分页 —— 官方没有统一承诺，只有分散的 bug**

**官方未给出任何「DOCX→PDF 保真度」的统一承诺文档**（检索 `META DOCX fidelity`、`META OOXML fidelity` 均无此追踪 bug）。实际口径是分散在 tracker 里的一堆 open bug，代表性条目（官方 REST API 查询，查证 2026-09-25，全部为 **NEW/未修复**）：

| Bug | 摘要 | 与本项目的关联 |
|---|---|---|
| [58239](https://bugs.documentfoundation.org/show_bug.cgi?id=58239) | FILEOPEN: Importing DOCX document gives **wrong text box placement and page break**（2012 年提，2026-05-28 仍有活动） | **正中要害**：图文框位置 + 分页同时出错 |
| [154703](https://bugs.documentfoundation.org/show_bug.cgi?id=154703) | **[META] Export DOCX flies with framePr instead of DrawingDML** | 图文框有两套表示法，LibreOffice 处理不一致 |
| [155645](https://bugs.documentfoundation.org/show_bug.cgi?id=155645) | Chart distortion when DOCX contains more than 20 charts, especially when **exporting to PDF in headless** | 图表多的材料会崩版 |
| [76022](https://bugs.documentfoundation.org/show_bug.cgi?id=76022) | DOC/DOCX import: **Tables don't wrap around floating shapes** | 表格绕排图文框失败 |
| [114883](https://bugs.documentfoundation.org/show_bug.cgi?id=114883) | Tables with vertical text layout laid out **almost entirely off of the page** | 竖排表格跑出页面 |
| [114437](https://bugs.documentfoundation.org/show_bug.cgi?id=114437) | Text with **Consolas** font is cropped upon PDF export | 字体度量导致的裁剪 |
| [62422](https://bugs.documentfoundation.org/show_bug.cgi?id=62422) | Incorrect word spacing and then line wrapping of .docx files with **Microsoft font TNR** | 字体→断行 |
| [50068](https://bugs.documentfoundation.org/show_bug.cgi?id=50068) | Incorrect spacing above paragraph **on second column of section** | 分栏内的间距算错 |
| [76134](https://bugs.documentfoundation.org/show_bug.cgi?id=76134) | **Column widths are not interpreted properly** from Microsoft Word 2003 XML format | 栏宽解析（注：此条针对 Word 2003 XML，非 DOCX） |
| [128194](https://bugs.documentfoundation.org/show_bug.cgi?id=128194) | **[META] DOCX: Bugs brought up by OnlyOffice in competitive comparison** | 官方自己也承认有 DOCX 兼容性缺口清单 |

> 关于「官方或权威一手来源对比 LibreOffice 与 Word 的排版差异」：**未找到**官方发布的 DOCX→PDF 保真度基准对比文档。官方 bugzilla 里有一个 `[META] DOCX: Bugs brought up by OnlyOffice in competitive comparison`（#128194），是**问题清单**而非保真度基准。**此项部分未确认。**

### 1.4 打包成本

**Docker 镜像（Docker Hub 官方 API，`size` 为**压缩层**大小，非解压后体积；查证 2026-09-25）**

| 镜像 | 状态 | 压缩体积 |
|---|---|---|
| `libreoffice/headless` | **不存在**（仓库 404） | — |
| `libreoffice/online`（官方 org） | 最后更新 **2020-09-08**，已停滞 | amd64 ≈ **998 MB** |
| `linuxserver/libreoffice`（社区，67 star / 106 万 pull） | 活跃，tag `25.8.7`（2026-09-24） | amd64 ≈ **1004 MB** |
| `collabora/code` | 活跃（2026-09-24） | amd64 ≈ **491 MB** |

**发行版包的实际安装体积（Ubuntu 24.04 noble，LO 24.2；经 `web.archive.org` 回放 packages.ubuntu.com 读取，查证 2026-09-25）**

| 包 | 包体积 | **Installed Size** |
|---|---|---|
| `libreoffice-core` (amd64) | 42,007 kB | **147,830 kB ≈ 148 MB** |
| `libreoffice-common` (all) | 19,823 kB | **47,287 kB ≈ 47 MB** |
| `libreoffice-writer` (amd64) | 10,691 kB | **34,916 kB ≈ 35 MB** |
| `fonts-noto-cjk` (all) | 59,795 kB | **90,994 kB ≈ 91 MB** |

> **量级结论**：核心三包 + 中文字体 ≈ **230 MB（不含依赖）到 320 MB+**；容器镜像层面，社区现成镜像的**压缩层**已是 **0.5–1.0 GB** 量级。
> 注：`libreoffice-core/writer/common` 三者还有大量未列出的依赖，真实 `apt install` 占用显著高于上表求和。**「最小可用镜像大概多大」的精确数字未确认**，需实测。

---

## 2. 浏览器端把 LibreOffice 编译成 WASM

### 2.1 项目确认：**存在** —— ZetaOffice / LOWA / zetajs 都是真实的

Allotropia（LibreOffice 生态的商业实体）的产品线：

- **ZetaOffice**：官网 <https://zetaoffice.net/>（HTTP 200，2026-09-25 抓取），首页标语 "**LibreOffice in your browser**"，"Built on LibreOffice, is fully compatible with existing documents"。产品含 Writer / Calc / Impress，另提供 Linux/Windows 原生桌面版（beta）。
- **LOWA**（LibreOffice WebAssembly）：**就在 LibreOffice 官方仓库里**，文档路径为 `LibreOffice/core` 的 `static/README.wasm.md`，标题 "Support for Emscripten Cross Build"。
- **zetajs**：npm 包 `zetajs`，仓库 <https://github.com/allotropia/zetajs>（227 star，最后 push 2026-04-01）。描述："Access ZetaOffice in the Browser from JavaScript via **UNO**"。

> "The zetajs library provides the facilities to run an instance of ZetaOffice integrated in your
> web site, allowing you to control it with JavaScript code via the LibreOffice **UNO** technology.
> Use cases range from an in-browser office suite ..., to **a headless zetajs instance that does
> document conversion in the background**."
>
> "You may also compile a custom **LOWA build** (https://git.libreoffice.org/core/+/refs/heads/master/static/README.wasm.md)."

—— `allotropia/zetajs` README，<https://raw.githubusercontent.com/allotropia/zetajs/main/README.md>，查证 2026-09-25

### 2.2 版本、许可证、体积

| 项目 | 版本 | 许可证 | 依据 |
|---|---|---|---|
| `zetajs`（JS 包装层） | **1.2.0**（npm publish 2025-05-30；GitHub release v1.2.0 2025-06-11） | **MIT**（仓库根 LICENSE，1098 字节；README 要求贡献者以 MIT 授权） | npm registry `registry.npmjs.org/zetajs`（查证 2026-09-25） |
| LOWA / ZetaOffice WASM 二进制 | 与 ZetaOffice 版本线对齐；官网桌面版下载路径为 **`24.2.8.0.beta1`** | **未确认**（LibreOffice 本体是 MPL-2.0，但 Allotropia 分发的 WASM 构建与 CDN 服务的授权条款**未见明确许可文件**） | zetaoffice.net 下载链接、zetajs README |

**商业 vs 开源 —— 官方 FAQ 原文（重要）**：

> "2. Is ZetaOffice free? **ZetaOffice is open source software** based on the powerful LibreOffice suite.
> **We offer paid packages that include the use of our high performance CDN and professional support
> options for your company.** Our ZetaOffice services are currently in an **open beta** program."

> "4. Is it possible to self-host ZetaOffice, or do I have to use the CDN? **Both options are possible.**"

—— <https://zetaoffice.net/>（首页 FAQ 区块），查证 2026-09-25

> **读法**：**客户端 JS 库（zetajs）明确 MIT**；**服务（CDN + 支持）是付费产品**；自托管被官方明确允许。但「自托管时 WASM 二进制的许可与费用」**官方页面未给出明确条款，未确认**——这是采购/合规上必须先问清的点。

**WASM 体积（实测，非官方文档数字）**：从官方 `zetajs` 的 `zetaHelper.js` 里读到免费 CDN 基址 `https://cdn.zetaoffice.net/zetaoffice_latest/`，对其实测（HTTP/2 响应头，查证 2026-09-25）：

| 文件 | content-length | content-encoding |
|---|---|---|
| `soffice.wasm` | **36,279,250 B ≈ 36.3 MB** | `br`（Brotli） |
| `soffice.data` | **15,891,013 B ≈ 15.9 MB** | `br` |
| `soffice.js` | 858,124 B ≈ 0.86 MB | 无（明文） |
| **合计** | **≈ 53 MB（传输体积）** | |

- 三者 `last-modified` 均为 **2025-05-13**。
- **注意**：`soffice.wasm` 与 `soffice.data` 带 `content-encoding: br`，所以 **36.3 MB / 15.9 MB 是 Brotli 压缩后的传输量，解压后的原始 `.wasm` 更大**；具体原始值**未确认**（可从解压比估算，未实测）。
- 官方文档**没有**给出 WASM 体积数字；以上是我对官方 CDN 的实测结果。

### 2.3 浏览器要求（官方明确要跨源隔离头）

`zetajs` 官方示例 `examples/convertpdf/README.md` 原文：

> "The following HTTP headers must be set in the web server configuration.
> ```
> Cross-Origin-Opener-Policy "same-origin"
> Cross-Origin-Embedder-Policy "require-corp"
> ```"

—— <https://raw.githubusercontent.com/allotropia/zetajs/main/examples/convertpdf/README.md>，查证 2026-09-25

LOWA 官方构建文档同款要求，并给出部署方式：

> "Your HTTP server needs to provide additional headers:
> * add_header Cross-Origin-Opener-Policy same-origin
> * add_header Cross-Origin-Embedder-Policy require-corp
> The default html to use should be `qt_soffice.html`"

—— LibreOffice core `static/README.wasm.md`，<https://raw.githubusercontent.com/LibreOffice/core/master/static/README.wasm.md>，查证 2026-09-25

**内存与线程（官方构建文档）**：

> "Qt with threads has a further memory limit. From Qt configure:
> `Project MESSAGE: Setting PTHREAD_POOL_SIZE to 4`
> `Project MESSAGE: Setting TOTAL_MEMORY to 1GB`
> You can actually allocate 4GB"

> "**Linking takes quite a long time**, because emscripten-finalize rewrites the whole WASM files with
> some options. **This way the LO WASM possibly needs 64GB RAM.**"（注：这是**构建期**需求，不是运行期）

**三种官方构建形态**（`zetajs/docs/start.md`，查证 2026-09-25）：

> "There are three functionally different LOWA build configurations:
> - A plain build, using Qt-based interaction with a graphical canvas.
> - A build configured with `--disable-gui`, which provides a **headless LOWA server that does not use any graphical canvas**.
> - A build configured with `--enable-emscripten-proxy-posix-sockets` ..."

### 2.4 **浏览器内 DOCX→PDF：官方支持，且有在线 demo**

zetajs 的示例表里直接有一个：

> "| [convertpdf](https://github.com/allotropia/zetajs/tree/main/examples/convertpdf) | **local file to PDF conversion service** | Plain javascript | https://zetaoffice.net/demos/convertpdf/ |"

其 README 首句："An example of a **local file to PDF conversion service**."

**结论**：**"浏览器内完成 DOCX→PDF" 在 ZetaOffice/LOWA 上是官方已验证的能力**，不是推测。

**但对本项目的现实门槛**：
1. 免费 CDN 约 **53 MB** 传输体积（Brotli），首屏加载对「现场投屏、老师等不起」是硬伤；自托管可放内网，但要知道这是几十 MB 级的静态资源。
2. 需要 **COOP/COEP 跨源隔离**——这会影响该 PWA 里所有第三方资源（图片、字体、CDN 脚本）的加载策略，是架构级约束。
3. 运行期 **1 GB 级内存**，校园白板/一体机不一定宽裕。
4. WASM 二进制的**许可与费用条款未确认**（§2.2）。
5. LOWA 的构建链（Emscripten 4.0.10 + Allotropia 打过补丁的 Qt 5.15.2）**非常重**；自行从源码构建不现实，只能自托管官方产物或走 CDN。

### 2.5 其他「办公套件编译到 WASM」的项目

- **Collabora Online as WASM (COWASM)**：LOWA 官方文档明确把「把 LibreOffice 核心编成无 UI 的 WASM 供其他产品使用」列为第二种构建目的，并点名适用对象：
  > "just compiling LibreOffice core ("LibreOffice Technology") to WASM without any UI for use in
  > other software that provides the UI, **like Collabora Online built as WASM**."
  > "For building LO core for use in COWASM, it is known to work to use Emscripten 3.1.30"
  这意味着 Collabora 的 WASM 版**同源于 LOWA 构建链**，不是独立第三条路。
- **ONLYOFFICE WASM 版**：**未确认**——本轮未取得可靠一手来源（官方站/官方仓库）证实其存在与形态，不作结论。

---

## 3. 纯 JS 的 DOCX 渲染库

### 3.1 定位、许可、维护状态（npm registry 实测，查证 2026-09-25）

| 包 | 版本 | 最近发布 | 许可证 | 官方定位 |
|---|---|---|---|---|
| **mammoth** | **1.12.3** | **2026-09-12** | BSD-2-Clause | "Convert Word documents from docx to simple HTML and Markdown" |
| **docx-preview** | **0.4.1** | **2026-09-21** | Apache-2.0 | "Docx rendering library"（仓库 `VolodymyrBaydalka/docxjs`） |
| **docx4js** | 3.3.0 | 2024-09-09 | MIT | "javascript docx parser" |
| **officegen** | 0.6.5 | **2021-03-06** | MIT | **只写不读**：Office Open XML **Generator**，用于**生成** docx/pptx/xlsx |
| jszip | 3.10.2 | 2026-09-08 | MIT / GPL-3.0+ | ZIP 容器读写（docx 是 ZIP，手写 OOXML 解析的必选底座） |

> mammoth 与 docx-preview 都**在活跃维护**（最近发布就在本月）；docx4js 停在 2024；officegen 停在 2021 且**不解决本问题**。

### 3.2 **关键：它们官方声明丢掉了哪些排版信息？**

**mammoth —— 官方明说「忽略其他细节」，定位就是极简语义 HTML**

> "Mammoth aims to produce simple and clean HTML by using semantic information in the document,
> **and ignoring other details.**
> For instance, Mammoth converts any paragraph with the style `Heading 1` to `h1` elements,
> **rather than attempting to exactly copy the styling (font, text size, colour, etc.)** of the heading."

> "There's a large mismatch between the structure used by .docx and the structure of HTML,
> meaning that **the conversion is unlikely to be perfect for more complicated documents**."

> "**Tables.** The formatting of the table itself, such as **borders, is currently ignored**, but the
> formatting of the text is treated the same as in the rest of the document."

> "**Text boxes.** The contents of the text box are treated as **a separate paragraph that appears
> after the paragraph containing the text box**."

—— `mwilliamson/mammoth.js` README，<https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/README.md>，查证 2026-09-25

**docx-preview —— 官方明说「受 HTML 能力限制」，且实时分页未实现**

> "Goal of this project is to render/convert DOCX document into HTML document with keeping HTML
> semantic as much as possible. **That means library is limited by HTML capabilities** (for example
> Google Docs renders *.docx document on canvas as an image)."

> "**Realtime page breaking is not implemented** because it's requires re-calculation of sizes on each
> insertion and that could affect performance a lot.
> If page breaking is crucial for you, I would recommend:
> - try to insert manual break point as you could
> - try use editors like MS Word, that inserts `<w:lastRenderedPageBreak/>` break points"

> "Table of contents is built using the TOC fields and there is no efficient way to get table of
> contents at this point, **since fields is not supported yet**"

> "So far I can't come up with final approach of parsing documents and final structure of API.
> **Only `renderAsync` function is stable** and definition shouldn't be changed in future.
> Inner implementation of parsing and rendering may be changed at any point of time."

—— `VolodymyrBaydalka/docxjs` README，<https://raw.githubusercontent.com/VolodymyrBaydalka/docxjs/master/README.md>，查证 2026-09-25

**docx-preview 的已知缺陷（项目 issue / PR，均 open，查证 2026-09-25）**：

| 编号 | 状态 | 标题 |
|---|---|---|
| [#221](https://github.com/VolodymyrBaydalka/docxjs/issues/221) | open | Table insideH/insideV borders are not parsed |
| [#203](https://github.com/VolodymyrBaydalka/docxjs/pull/203) | open PR | Fix image and text box alignment relative to page |
| [#80](https://github.com/VolodymyrBaydalka/docxjs/issues/80) | open | Text box cannot be displayed |
| [#97](https://github.com/VolodymyrBaydalka/docxjs/issues/97) | open | docx file preview appears text box lines disappear |

> #221 的正文（WebFetch 读取）："`<w:insideH>` and `<w:insideV>` inside `<w:tblBorders>` are **not parsed**: they appear in neither the parser's element cases nor the border model."
> 说明：这些是**社区 issue**，不是官方功能声明；但 #203 的存在说明 docx-preview **确实实现了**浮动图片/文本框的定位（只是在修 bug），比 mammoth 走得远。

### 3.3 **它们能输出带坐标的结构化结果吗？**

**不能。** 两者的公开 API 与官方定位都是 **HTML 流**：

- mammoth：`convertToHtml` 产出的是"an HTML fragment"（README），语义映射到 `h1`/`p`/`table` 等元素，**没有任何坐标概念**；文本框被降级成「后面一个独立段落」，位置信息直接消失。
- docx-preview：`renderAsync(document, bodyContainer, styleContainer, options)` **渲染进 DOM 元素**；官方另暴露 `parseAsync` → `WordDocument` 内部对象 + `renderDocument`，README 明确标注这是 "**experimental / internal API**"，且"inner implementation ... may be changed at any point"。它是**有**内部布局模型的（所以能修「相对页面的绝对对齐」），但**官方不承诺**该模型稳定或可编程取坐标。

> 结论：**指望这两个库拿到「文字 + 坐标」不可行**；docx-preview 可作为**纯浏览器预览**的降级方案（保真度≈HTML 能表达的极限），但不能作为「切分重排」的数据源。

---

## 4. OOXML 直解（重点）

### 4.1 分栏：`w:sectPr` → `w:cols` —— **有可用定位信息**

Microsoft 官方 Open XML SDK 文档确认 `w:cols`（类 `Columns`，SchemaAttr `w:cols`）的属性与子元素：

| 成员 | 官方描述 | schema 名 |
|---|---|---|
| `ColumnCount` | **Number of Equal Width Columns** | `w:num` |
| `EqualWidth` | **Equal Column Widths** | `w:equalWidth` |
| `Space` | **Spacing Between Equal Width Columns** | `w:space` |
| `Separator` | **Draw Line Between Columns** | `w:sep` |
| 子元素 `Column` | （不等宽时逐栏定义，含 `w:w`） | `w:col` |

—— Microsoft Learn, `Columns` class, <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.columns>（Package 覆盖 v2.7.1–v3.0.1，查证 2026-09-25）

**结论：能。** 只看 OOXML 就能判定「这份材料是几栏、栏间距多少、要不要分隔线、不等宽时每栏多宽」。**这是本项目真正需要的那点排版信息，且不需要转 PDF。**

配套还有：分节（`w:sectPr` 本身，含纸张尺寸 `w:pgSz` 与页边距 `w:pgMar`）、分页类型（`w:type`：下一页/连续/奇偶页）。python-docx 把这些暴露成 `Section` 的 11 个属性（§4.3）。

> 注意区分：**「能读到栏数与栏宽」≠「能算出每段落在哪一栏」**。段落归属哪一栏仍要靠流式排版推断（按内容顺序 + 栏高估算）。但这对「切分重排」通常够用。

### 4.2 文本框 / 浮动对象定位：**有显式偏移，但基准是相对的**

Microsoft 官方 SDK 对 `wp:positionH` 的定义（原文，含 ISO/IEC 29500-1 直引）：

> "[ISO/IEC 29500-1 1st Edition] **positionH (Horizontal Positioning)**
> This element specifies the horizontal positioning of a floating DrawingML object within a
> WordprocessingML document. This positioning is specified in two parts:
> - **Positioning Base** - The `relativeFrom` attribute on this element specifies the part of the
>   document from which the positioning shall be calculated.
> - **Positioning** - The child element of this element (**align** or **posOffset**) specifies how the
>   object is positioned relative to that base.
>
> [*Example*: ... `<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>` ...]"

结构（同一页面的 Child Elements / Parent Elements 表）：

| 元素 | 官方描述 | schema 名 |
|---|---|---|
| `Anchor` | **Anchor for Floating DrawingML Object** | `wp:anchor` |
| `HorizontalPosition` | **Horizontal Positioning** | `wp:positionH` |
| `PositionOffset` | **Absolute Position Offset** | `wp:posOffset` |
| `HorizontalAlignment` | **Relative Horizontal Alignment** | `wp:align` |
| `RelativeFrom` | **Horizontal Position Relative Base** | `relativeFrom`（属性） |

—— Microsoft Learn, `HorizontalPosition` class, <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.horizontalposition>，查证 2026-09-25

**关键判断（回答「文本框绝对位置能不能直接算出来」）**：

- **能直接算出的情况**：`relativeFrom="page"` 或 `"margin"` 且子元素是 `wp:posOffset` 时，偏移量是相对**页面/页边距**的绝对值 → 与排版无关，可直接换算成页面坐标。
- **不能直接算出的情况**：`relativeFrom` 指向 **`paragraph` / `character` / `column` / `line`** 时，基准本身的位置**取决于排版**（例如「某段落后方 2 cm」必须先知道该段落在哪一行、该栏有多高）。此时 OOXML 只给了**相对关系**，绝对坐标仍需排版引擎。
- 另外 `wp:anchor` 是「浮动」分支；`wp:inline`（嵌入）对象**没有** `positionH/positionV`，它像一个大字符一样**随文流动**——同样没有坐标。
- 补充：`wp:align`（用 `center`/`left`/`right` 等语义对齐）比 `wp:posOffset` **更常见也更稳**，因为它只依赖基准，不含测量误差。

> **结论**：**文本框位置信息「部分可读」**——读得到「相对谁、偏多少」，但「相对段落/字符」这一类仍需排版才能落到绝对坐标。**不能**据此声称「OOXML 直解可以完全复原图文框位置」。相关官方 bug 也印证这条边界难做：LibreOffice 自己 #58239「DOCX 文本框位置与分页错误」开了 13 年仍未修。

### 4.3 python-docx 的官方能力边界

**能做的（官方文档确认）**

- 读/写**段落、run、样式、表格、图片（仅 inline）、节（Document.sections）、页眉页脚、脚注、批注**。
  —— `docs/index.rst`、`docs/user/` 各页，<https://github.com/python-openxml/python-docx>，查证 2026-09-25
- `Section` 官方明说**有 11 个属性**，文档逐个列出：

  > "The |Section| object has **eleven properties** that allow page layout settings to be discovered and specified."

  分别是：`start_type`、`orientation`、`page_width`、`page_height`、`left_margin`、`right_margin`、`top_margin`、`bottom_margin`、`gutter`、`header_distance`、`footer_distance`。

  —— `docs/user/sections.rst`，同上，查证 2026-09-25

  > **这 11 个里没有 `columns`。** 也就是说 **python-docx 公开 API 不暴露分栏**。

**不能做的（官方文档确认）**

> "At the time of writing, |docx| **only supports inline pictures**. Floating pictures can be added.
> If you have an active use case, submit a feature request on the issue tracker."

—— `docs/user/shapes.rst`，同上，查证 2026-09-25

> **引用诚实**：这句话字面上前后矛盾（"only supports inline pictures" 紧接 "Floating pictures can be added"），看语境应为「浮动图片**不能**通过 API 添加」的笔误/表述缺陷。无论如何，**官方定位是「只支持 inline」**，`InlineShape` 的 API 只有 `height` / `width` / `type`（`docs/api/shape.rst`）——**没有任何位置属性**。

**同上，python-docx 缺失的能力汇总**：分栏（`w:cols`）、文本框、浮动对象、绝对定位、`w:framePr`。`api/dml.rst` 里 DrawingML 只暴露了 `ColorFormat`（颜色），**没有几何定位**。

**官方对「读不了的部分」的推荐替代 —— 未确认**

- python-docx 文档里确实把底层 lxml 元素暴露在 `.element` 上，`oxml` 层也公开（`docs/user/api-concepts.rst` 等有相关叙述），但本轮**未取到官方一句「读不了就用 XPath 直接操作底层 XML」的明确推荐**。**标注未确认**，需要在实机确认该用法是否被官方文档正面支持。
- 实践中（社区惯例，**非官方**）可以 `docx.Document(...).element.xpath('//w:cols')` 绕过 API 直接读 XML。**这属于绕过，不是官方支持。**

### 4.4 浏览器侧 OOXML 解析库能否读这些定位信息

- **mammoth / docx-preview**：见 §3.3，**官方定位是 HTML 流**，不承诺坐标。
- **docx4js**：官方 README 只自称 "javascript docx parser"，**未找到**关于 `w:cols` / `wp:anchor` / 坐标支持的官方说明 → **未确认**。
- **JSZip + 手写 XML 解析**：**可行但无官方支持语义**。DOCX 本身是 ZIP（OOXML 用 Open Packaging Conventions，见 [ECMA-376 Part 2]），JSZip 能解包，之后用 `DOMParser` 读 `word/document.xml`。`w:cols` 与 `wp:positionH/wp:posOffset` 都是**普通 XML 元素**，浏览器原生 `DOMParser` 完全可读。
  > **这条是本调研对「浏览器内 OOXML 直解」的核心判断**：**不需要任何第三方库**就能读到分栏与浮动对象偏移——需要的只是 OOXML 的元素知识。第三方库（mammoth/docx-preview）解决的是「渲染」，不是「读数据」。

### 4.5 **结论：如果不转 PDF，能否直接复原版面？**

**必须分两层回答：**

| 图层 | 能否不转 PDF 复原 | 依据 |
|---|---|---|
| **区域级版面** —— 分栏数/栏宽/栏间距、纸张尺寸、页边距、分节与分页类型、浮动对象（文本框/图片）的基准与偏移 | **能，且信息完整可用** | `w:cols`（Microsoft SDK 确认 4 个属性 + `w:col` 子元素）；`wp:positionH/V` + `relativeFrom` + `posOffset`/`align`（ISO/IEC 29500-1 原文） |
| **逐字级版面** —— 每个字/每行在页面上的 x/y | **不能**（文件里根本没有），**必须**有排版引擎 | §0 已证实：正文是流式；python-docx 官方「text layer ... flowed」 |

**因此**：
- 「不转 PDF 直接复原版面」在**「知道这份材料是不是双栏、文本框大致钉在哪」这个粒度上是可行的**——这恰好是「切分重排 + 现场投屏」真正需要的粒度。
- 「不转 PDF 直接拿到 Word 里一模一样的分页与逐字坐标」**不可行**，因为没有第二个 Word 排版引擎。
- 代价换来了什么？**绕开了字体替换问题**（不经 LibreOffice 排版，就不存在缺字体导致的重排），也绕开了 §1.3 那些卡死/内存 bug。

---

## 5. 转换保真度的官方讨论

- **官方 bug tracker 有无专门讨论 DOCX→PDF 保真度的条目？**
  - **没有**统一的「DOCX→PDF 保真度」追踪 bug。检索 `META DOCX fidelity`、`META OOXML fidelity` 均无结果；检索 `docx pdf fidelity` 只返回 6 条彼此无关的 bug。
  - 存在的是**问题清单型 META bug**： [#154703](https://bugs.documentfoundation.org/show_bug.cgi?id=154703)（framePr vs DrawingDML 导出）、[#128194](https://bugs.documentfoundation.org/show_bug.cgi?id=128194)（OnlyOffice 竞品对比暴露的 DOCX bug 集合）。
  - 检索方式与结果已留存：`https://bugs.documentfoundation.org/rest/bug?quicksearch=...&limit=60`（官方 REST API，2026-09-25）。

- **有无官方或权威一手来源对比 LibreOffice 与 Word 的排版差异？**
  - 官方**未发布** DOCX→PDF 保真度基准对比文档（如「逐项兼容性对照表 + 实测分页差异」）。**未确认**。
  - 最接近的是官方 wiki 的 `Feature_Comparison: LibreOffice - Microsoft Office` 页面（本轮抓取被 bot 挑战页拦下，仅确认 URL 存在，**内容未取到 → 未确认**）。
  - 官方 wiki `Fonts` 页给出的**度量兼容**替身清单（Carlito↔Calibri、Caladea↔Cambria）是官方承认「字体度量决定排版」的间接证据。

---

## 6. 备选路线评估：把所有输入统一栅格化成纯图片

这是团队后来加问的方向。**必须先把一个前提说清楚：**

> **栅格化并不能绕开「谁来渲染 DOCX」。**
> 图片是渲染的**产物**，不是渲染的**替代**。要把 DOCX 变成图片，前面仍然必须有人做 DOCX→(PDF|版面) 的排版：要么服务端 LibreOffice（§1），要么浏览器 WASM（§2）。栅格化改变的只是**交给 AI 的输入形态**（像素而非文字+坐标），**不改变渲染器的选型与成本**。
> 唯一例外：把 DOCX 直接丢给能读 docx 的模型（多模态直读）——那属于模型能力问题，不在本轮取证范围，**未确认**。

**可行形态**

- **形态 A（服务端栅格化）**：DOCX → LibreOffice → PDF → 栅格化（PyMuPDF 等，由 `research-docs` 线覆盖）→ 位图。PDF 与图片输入天然同路。
- **形态 B（浏览器栅格化）**：PDF 用 pdf.js 渲到 canvas（pdf.js 官方定位："a Portable Document Format (PDF) viewer that is built with HTML5"，目标 "create a general-purpose, web standards-based platform for **parsing and rendering** PDFs"，<https://github.com/mozilla/pdf.js>，查证 2026-09-25）；DOCX 则需先经 WASM 或服务端。

**保真度：上限与代价**

- **几何保真度：最高**。栅格化就是原样拍下来，不存在字体替换、断行漂移、文本框错位——**§1.3 的所有失败模式一次性消失**（因为版已定，读的是像素）。
- **代价 1（对本项目最致命）：分辨率锁死，放大即糊**。投屏到白板/大屏是**大幅放大**，位图文字边缘会软、会锯齿。要抗住就得按目标显示尺寸渲染（例如 A4 单栏按 200+ DPI → 单页数 MB），**传输与内存成本随分辨率线性上涨**，而文字层只要几 KB。
- **代价 2：丢掉全部文本层**。没有字符串 → 没有搜索、没有复制、没有精确的题号/题干切分依据；要恢复语义只能再上 OCR 或 VLM，等于把「不确定性」从排版层搬到了识别层。
- **代价 3：丢掉结构**。标题层级、列表、表格语义都没了，只有像素。任何「按题切分」「按章节分组」都得靠模型在像素上猜。
- **代价 4：不可重排**。「板上重排」这个词本身要求内容可重新流动；栅格化后每一块都是图，重排 ≈ 拼图，无法按字号/栏宽自适应。

**相对「读文字层」丢掉了什么（直接回答）**

| 维度 | 读文字层（PDF/DOCX 直解） | 纯栅格化 |
|---|---|---|
| 文字内容 | 精确字符串 | 无（需 OCR/VLM 重建，有错字风险） |
| 精确坐标 | 有（PDF 每个 span 的 bbox；DOCX 有区域级） | 只有像素栅格 |
| 语义/结构 | 段落、样式、表格、标题层级 | 无 |
| 抗放大 | 优（矢量文字，可任意缩放） | **差**（位图放大会糊） |
| 抗字体替换 | 不涉及（读的是已有坐标） | 不涉及 |
| 文件体积 | 极小 | 大（与分辨率成正比） |
| 管线统一性 | PDF/DOCX/图片各不相同 | **统一**（都是位图） |

> **判断**：栅格化是**兜底/统一化**手段，不是**主路线**。它对「AI 只在像素上给裁切与排版建议」这个用法是自洽的（因为裁切本来就是像素级决策，坐标反而多余）；但它把「文字可缩放、可搜索、可精确切分」这三样本项目**很可能需要**的东西一起丢掉了，而且**并不能省掉 DOCX 渲染器**。

---

## 7. 对选型的含义

### 7.1 「自己内置一套 docx 转换」现实可行的形态是哪一种？

按「现实可行度 × 对项目的匹配度」排序：

| 形态 | 可行度 | 代价 | 保真度上限 | 建议 |
|---|---|---|---|---|
| **① 服务端 LibreOffice 容器**（headless / unoserver） | **高**（唯一被大规模验证） | 镜像 0.5–1 GB；每实例 ~1 GB 级内存；必须配超时/重启/结果校验；需装中文字体 | **最高**：Word 版式的近似最优解，但**永远不等于 Word**（#58239 等活跃 bug） | **作为兜底与「原样呈现」通道**，不作为主路径 |
| **② 浏览器 WASM（ZetaOffice/LOWA）** | **中—高**（官方有 convertpdf 示例） | 传输 ~53 MB；需 COOP/COEP；运行时 1 GB 级内存；**WASM 二进制许可与费用未确认** | 同 ①（同一个 LibreOffice 渲染器） | 若坚持「文件不出浏览器」且能接受体积，**是唯一现实选项**；先问清授权与自托管条款 |
| **③ 纯 JS 近似（mammoth / docx-preview）** | **高**（装上就能跑） | 包极小（dep 仅 jszip） | **低—中**：只能到 HTML 能表达的极限；**无坐标**；文本框降级为段落/丢失，边框不解析，实时分页未实现 | 仅作**降级预览**，不能作数据源 |
| **④ OOXML 直解（读结构，不渲染）** | **高**（浏览器/服务端都能做，零第三方依赖） | 需自己实现 OOXML 元素解析 | **中—高**（在「区域级」粒度上）：分栏、纸张、页边距、浮动对象基准与偏移**都能拿到**；**逐字坐标拿不到，且本来也不存在** | **推荐作为主路径**：用它拿「切分重排」所需的全部版面事实 |
| **⑤ 要求用户先导出 PDF** | **很高**（零开发） | 转嫁给老师；现场投屏场景下体验差 | 取决于用户用什么转，不可控 | 仅作**最后手段/临时降级** |
| **⑥ 全栅格化 + 模型在像素上决策** | 中（仍需 ①或② 做渲染） | 体积随分辨率膨胀；丢文本层；不可重排 | 几何最高、**语义最低** | 可作**统一化兜底**，不宜作主路线 |

**我的建议形态**：**④ 为主 + ① 为兜底**。
DOCX 走 OOXML 直解拿到「分节/分栏/页边距/浮动对象」这些**真实存在且有官方 schema 依据**的信息，用它们驱动切分与重排；只有当某份材料必须「原样呈现」时，才落到服务端 LibreOffice 转 PDF（PDF 侧再接现有 pdf.js 管线）。纯 JS 库留作离线预览的降级。

### 7.2 我们真正需要的那点排版信息，能不能拿到？

| 需要的信息 | 能否拿到 | 在哪 | 置信度 |
|---|---|---|---|
| **分栏（几栏、栏宽、栏间距）** | **能** | `w:sectPr/w:cols` 的 `w:num` / `w:space` / `w:equalWidth` / `w:col` | **高**（Microsoft 官方 SDK 文档逐属性确认） |
| **页面/纸张/页边距/分节** | **能** | `w:sectPr/w:pgSz` / `w:pgMar` / `w:type`；python-docx `Section` 11 属性（已覆盖尺寸与边距，**未覆盖分栏**） | **高** |
| **题号 / 题干** | **能（作为文本）** | 段落文本 + 编号定义（`w:numPr` 引用 numbering 部件）；PDF 侧等同理 | **中**：编号**文本**可读，但「第 3 题」的语义边界需自己判定 |
| **图文框 / 文本框位置** | **部分能** | `wp:anchor` + `wp:positionH/V` + `relativeFrom` + `posOffset`/`align` | **中**：`relativeFrom=page/margin` 可直算绝对坐标；`=paragraph/character` 需排版才能定位；`wp:inline` 无坐标 |
| **逐字坐标** | **不能（DOCX 里不存在）** | — | **高**（§0 已证实） |

> **一句话**：**我们需要的三类信息（分栏、题号、图文框）里，分栏和题号没问题，图文框是「部分可读」——这是整个方案唯一需要真机验证的实质风险点。**

### 7.3 必须真机实验才能确认的清单

| # | 实验 | 为什么必须做 | 判据 |
|---|---|---|---|
| **E1** | 收集**真实校内材料样本**（≥30 份 DOCX），统计 `w:cols` 命中率、`wp:anchor` 命中率、`relativeFrom` 取值分布、`w:framePr` 出现率 | 决定「OOXML 直解」能否覆盖真实材料；文档规范齐全 ≠ 材料真的这么写 | `w:cols` 命中率、`relativeFrom=paragraph/character` 的占比 |
| **E2** | LibreOffice 容器（装齐 Noto CJK + 常用中文字体）对 E1 样本跑 DOCX→PDF，**与 Word 导出的 PDF 逐页像素比对** | §1.3 的活跃 bug 是否真的打到我们的材料上 | 分页差异页数、文本框错位例数、卡死/超时例数 |
| **E3** | 同一批材料**不装中文字体**再跑一次，量化字体替换导致的断行/分页漂移 | 量化 §1.3(a) 的实际影响，决定字体镜像策略 | 与 E2 的分页差异 |
| **E4** | 并发压测：N 个 `unoserver`（不同 `--port`/`--uno-port`）+ `-env:UserInstallation` 独立 profile，测吞吐与内存峰值 | §1.2 的 fiddle 是否真的必要、单机上限在哪 | 每实例 RSS、每秒转换数、失败率 |
| **E5** | 试 `--convert-to "xml:writer_layout_dump"`（官方过滤器清单里存在），看能否直接 dump 出**带坐标的排版结果** | 若可行，等于用官方能力白拿坐标，可能改变整个方案 | 输出是否含页面坐标 |
| **E6** | 浏览器实测 ZetaOffice `convertpdf` 示例：首屏加载时间、内存占用、脱机（内网自托管）可行性、中文 DOCX 转换正确性 | §2 全是官方文档与 CDN 实测，**真实浏览器行为未验** | 首次可用耗时、峰值内存、中文排版结果 |
| **E7** | 查清 **WASM 二进制与自托管的法律/费用条款**（直接问 Allotropia） | §2.2 明确标为未确认，影响能否合法内网部署 | 书面条款 |
| **E8** | 用 `w:cols` + `w:pgSz` 自算栏框，把段落按顺序分配进栏，**在真实双栏材料上人工核对**归属正确率 | §4.1 的注意点：读到栏数 ≠ 能把段落分对栏 | 段落归栏准确率 |
| **E9** | 栅格化对照：同一页按 150/200/300 DPI 栅格化，投到目标白板尺寸后**主观清晰度**与文件体积 | §6 的核心权衡，只能眼看 | 可接受的最低 DPI + 单页体积 |
| **E10** | 确认 `w:numPr`（自动编号）在真实材料中的使用率，以及编号在**文本层之外**时如何还原题号 | 题号可能来自 numbering 部件而非文本，直接影响切分 | 自动编号占比 |

---

## 附：本轮「未确认」清单（如实列出）

1. **ZetaOffice/LOWA WASM 二进制的许可证与费用条款** —— 官网只说明「zetajs/开源软件 + CDN 与支持是付费产品、可自托管」，**未找到** WASM 产物本身的授权文件（仓库 `allotropia/lowa` 不存在，LOWA 代码在 LibreOffice core 里，但 Allotropia 分发的构建产物归属未明）。
2. **soffice.wasm 的解压后原始体积** —— 实测 36.3 MB 是 Brotli 传输量；原始 `.wasm` 更大，具体值未测。
3. **`libreoffice/headless` 官方镜像** —— Docker Hub 上该仓库 **404，不存在**；官方未提供 LibreOffice 的官方 Docker 镜像（`libreoffice/online` 是 LibreOffice Online，2020 年后停滞）。
4. **「最小可用 LibreOffice 镜像」的精确体积** —— 只拿到各发行版包的 Installed Size（core 148 MB + common 47 MB + writer 35 MB + fonts-noto-cjk 91 MB）与社区镜像的压缩层大小（0.5–1.0 GB），**未实测**自建镜像大小。
5. **官方是否推荐用 XPath/底层 XML 绕过 python-docx API 读分栏** —— **未找到**官方正面推荐语句。
6. **python-docx 官方维护者对 columns / textbox 不支持原因的说明** —— 本轮**未取到**（api.github.com 限额耗尽，issue 需 WebFetch 逐页打开，未完成）。**未确认**。
7. **docx4js 对定位信息的支持** —— 只有 "javascript docx parser" 一句官方描述，**支持情况未确认**。
8. **ONLYOFFICE 的 WASM 版** —— **未确认**，未取得可靠一手来源。
9. **官方 LibreOffice 与 Word 的排版差异对照文档** —— **未确认存在**。最接近的 `wiki.documentfoundation.org/Feature_Comparison:_LibreOffice_-_Microsoft_Office` 被 bot 挑战页拦住，**内容未取到**。
10. **「并发转换必须用 `-env:UserInstallation`」的官方规范性说明** —— 官方帮助页只把它列为「设置非默认 profile 路径」的示例，**未与并发绑定**；并发实践依据来自 `unoserver` 的 `--user-installation` 默认行为。
11. **官方下载站点/镜像站不可达记录**（供后续复现参考）：`wiki.documentfoundation.org`、`packages.debian.org` 对 curl 返回 bot 挑战页（Anubis / Varnish PoW），须经 `web.archive.org` 回放；`bugs.documentfoundation.org` 的 CSV 导出接口返 403，但**官方 REST API `/rest/bug` 正常**；`officeopenxml.com`、`zetajs.dev`、`lowa.dev` 连不上。
