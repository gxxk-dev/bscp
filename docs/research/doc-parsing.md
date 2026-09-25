# 文档解析一手来源调研（PDF / DOCX / 图片）

查证日期：**2026-09-25**（UTC）。所有版本号与 URL 均为当日实测。
约束：按 team-lead 指示，**旧 .doc 二进制格式不在范围内**，只讨论 PDF 与 DOCX。
凡本文件写「未确认」处，均为在官方来源中未找到陈述，**未做任何推测**；标明「推论」处为基于官方原文的直接推导。

---

## 结论速览

1. PyMuPDF（pymupdf 1.28.2）能给出每个 span 的精确 bbox、字体名、字号、颜色、flags——**PDF 有文字层时完全不需要 OCR**。
2. 但 `sort=True` 只是按坐标 `(y1, x0)` 全局排序；官方 FAQ 明说**多栏排版「helps but isn't perfect」**，需自己判栏。多栏阅读顺序**不能纯靠 PyMuPDF 解决**。
3. 官方生态里的多栏方案是 **`pymupdf-layout`（ONNX 版面模型）**——即 PyMuPDF 自己承认这块要上版面模型。
4. 「这一页是不是纯图」官方**没有单一 API**，只有三条启发式判据（整页被图覆盖 / 无文字 / 大量模拟文字的矢量图形）。
5. **普通段落的位置确实不存储在 DOCX 里**（OOXML schema 层面无坐标属性）。Word 是流式排版，坐标在渲染时才产生——**OOXML 直解拿不到坐标，只能拿逻辑结构**。这是两条输入路径必须分流的事实根据。
6. 「统一栅格化 + 像素上做 AI」在保真与成本上都有明确代价：官方称 OCR 比原生抽取**慢约 1000 倍**，且 Tesseract 结果**丢失粗体/斜体/原字体信息**、**不识别矢量图形**，表格框线也随矢量层消失。
7. 许可提醒：**PyMuPDF 是 AGPL-3.0 或 Artifex 商业双许可**（校内自建服务一般可接受 AGPL；闭源分发需商业授权）；pdfplumber 是 MIT。

---

## 1. PyMuPDF（fitz）的抽取能力

**版本基线**：PyMuPDF **1.28.2**，PyPI 上传 2026-08-06；GitHub 最新 release tag `1.28.2`（2026-08-06T22:16:34Z），仓库 `pymupdf/PyMuPDF`，pushed 2026-09-24。
许可：`Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License`；`requires_python >= 3.10`。
来源：https://pypi.org/pypi/PyMuPDF/json 、https://api.github.com/repos/pymupdf/PyMuPDF （查证 2026-09-25）
文档站自称覆盖到 1.28.2（"This documentation covers all versions up to 1.28.2"，Last updated 03. Sep 2026）。

### 1.1 `Page.get_text()` 签名与参数

官方签名（page.html#Page.get_text）：

```
get_text(option, *, clip=None, flags=None, textpage=None, sort=False, delimiters=None)
```

- `option`：`"text"`（默认）/ `"blocks"` / `"words"` / `"html"` / `"xhtml"` / `"xml"` / `"dict"` / `"json"` / `"rawdict"` / `"rawjson"`。拼错时**静默退回 `"text"`**。
- `clip`：只保留完全落在矩形内的内容（逐字符判定）。要取全部内容需 `clip=pymupdf.INFINITE_RECT()`。对 `html`/`xhtml`/`xml` **无效**。
- `flags`：位掩码，控制是否包含图片、空白/连字处理等（v1.16.2 新增）。
- `textpage`：复用一个已建好的 TextPage 可显著提速（官方称 **>50%、最高 95%**）；一旦传入，`flags` 与 `clip` 被忽略。
- `sort`：见第 2 节。
- `delimiters`：仅对 `"words"` 生效，追加词分隔符（v1.23.5 新增）。

来源：https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_text （查证 2026-09-25）

### 1.2 各 output option 的默认 flags 组合（官方常量表）

| 常量 | 默认组合 |
|---|---|
| `TEXTFLAGS_TEXT` / `_WORDS` / `_BLOCKS` | `TEXT_PRESERVE_LIGATURES \| TEXT_PRESERVE_WHITESPACE \| TEXT_MEDIABOX_CLIP \| TEXT_USE_CID_FOR_UNKNOWN_UNICODE` |
| `TEXTFLAGS_DICT` / `_RAWDICT` / `_HTML` / `_XHTML` | 同上 **+ `TEXT_PRESERVE_IMAGES`** |
| `TEXTFLAGS_XML` | 同 TEXT 组 |
| `TEXTFLAGS_SEARCH` | `TEXT_PRESERVE_WHITESPACE \| TEXT_MEDIABOX_CLIP \| TEXT_DEHYPHENATE` |

逐个 flag 的位值与含义（节选与选型相关者）：
`TEXT_PRESERVE_LIGATURES`=1、`TEXT_PRESERVE_WHITESPACE`=2、`TEXT_PRESERVE_IMAGES`=4、`TEXT_INHIBIT_SPACES`=8、`TEXT_DEHYPHENATE`=16、`TEXT_PRESERVE_SPANS`=32、`TEXT_MEDIABOX_CLIP`=64、`TEXT_USE_CID_FOR_UNKNOWN_UNICODE`=128、`TEXT_COLLECT_STRUCTURE`=256、`TEXT_ACCURATE_BBOXES`=512、`TEXT_COLLECT_VECTORS`=1024、`TEXT_IGNORE_ACTUALTEXT`=2048、`TEXT_SEGMENT`=4096、`TEXT_COLLECT_STYLES`=32768、`TEXT_LAZY_VECTORS`=1048576、`TEXT_FUZZY_VECTORS`=2097152。

值得注意的三条官方说明：
- **性能警告**（原文）："Especially make sure to switch off image extraction unless you really need them. The impact on performance and memory is significant!"
- `TEXT_ACCURATE_BBOXES`：忽略字体度量、按字形绘制指令算 bbox 外壳；需配合 `pymupdf.TOOLS.unset_quad_corrections(True)`；会**拖慢**抽取。
- `TEXT_SEGMENT`（4096）："Attempt to segment page into different regions. **Detail documentation pending.**" —— 有 flag 但**官方文档未补齐**，不可依赖。
- `TEXT_COLLECT_STYLES`：可检出下划线/删除线，以及创作者用「同一文本多次轻微偏移打印」模拟的**假粗体**。

来源：https://pymupdf.readthedocs.io/en/latest/vars.html （"Text Extraction Flags" 与 "The following constants represent the default combinations" 两节，查证 2026-09-25）

### 1.3 `get_text("dict")` 的结构（block / line / span 字段）

顶层：`width`、`height`（clip 矩形尺寸）、`blocks`。

**Block**：`type`（0=text，1=image，3=vector）、`bbox`、`number`，文本块另有 `lines`。
- 图片块仅在 `TEXT_PRESERVE_IMAGES` 置位时出现，字段含 `bbox`、`ext`、`width`、`height`、`colorspace`、`xres`、`yres`、`bpc`、`transform`、`size`、`image`(bytes)、`mask`。官方特别提示：**同一图片在页面上出现几次就有几个图片块**（与 `Page.get_images()` 每个图片只列一次不同）。
- 矢量块仅在 `TEXT_COLLECT_VECTORS` 置位时出现，字段含 `bbox`、`stroked`、`isrect`、`continues`、`color`、`alpha`。

**Line**：`bbox`、`wmode`（0 水平 / 1 垂直）、`dir`（书写方向单位向量 `(cosine, -sine)`）、`spans`。

**Span**（"A line contains more than one span only, if it contains text with different font properties"）：

| key | 值 |
|---|---|
| `bbox` | span 矩形（rect_like） |
| `origin` | 首字符原点（基线左端，point_like，v1.17.6 新增） |
| `font` | 字体名（str） |
| `ascender` / `descender` | 相对 fontsize=1 的字体度量（float，descender 为负，v1.18.5） |
| `size` | 字号（float） |
| `flags` | 字体特征位（int） |
| `char_flags` | 字符特征位（int，v1.25.2 新增） |
| `color` | 文本颜色，sRGB 整数 `0xRRGGBB` |
| `alpha` | 不透明度 0..255（v1.25.3 新增） |
| `text` | 仅 `extractDICT()`；`extractRAWDICT()` 则换成 `chars`（逐字符字典列表） |

`flags` 位义：bit0 上标、bit1 斜体、bit2 衬线、bit3 等宽、bit4 粗体（`TEXT_FONT_*`）。官方警告：**bit1–bit4 是字体程序里的属性，"not necessarily correct or complete: fonts quite often contain wrong data here"**。
`char_flags` 位义：bit0 删除线、bit1 下划线、bit3 填充、bit4 描边、bit5 裁剪；若既未填充也未描边则文字**不可见**。
`rawdict` 的字符字典含 `origin`（字形左基线点）、`bbox` 等。

来源：https://pymupdf.readthedocs.io/en/latest/textpage.html （Module TextPage → Block/Line/Span/Character Dictionary，查证 2026-09-25）

### 1.4 能否给出精确坐标？坐标是什么单位？

**能**。span、line、block 三级都有 `bbox`，`rawdict` 还到字符级。

坐标单位（官方 appendix 3「Coordinates」原文）：
- "In PDF, the origin (0, 0) of a page is located at its **bottom-left** point. In MuPDF, the origin (0, 0) of a page is located at its **top-left** point."
- "Coordinates are float numbers and measured in **points**, where: **one point equals 1/72 inches**."
- "In this way we can conveniently find that `Rect(0, 0, 100, 100)` in MuPDF is the same as `Rect(0, 692, 100, 792)` in PDF." 转换用 `Page.transformation_matrix`。
- 返回坐标**相对未旋转页面**："all coordinates returned by methods and attributes pertain to the unrotated page"，`Page.get_text()` 与批注矩形皆然（v1.17.0 起）。要换算到旋转后坐标需乘 `Page.rotation_matrix`。

**一处官方文档内部措辞不一致（照录，供注意）**：appendix 1 在讲 `extractDICT()` 时写作 "bbox – **boundary boxes in pixel units**"；appendix 3 明确是 points。对未旋转、以 72 dpi 渲染的页面二者数值相同，但**以 points 为准更安全**。

来源：https://pymupdf.readthedocs.io/en/latest/app3.html （Coordinates / Origin Point, Point Size and Y-Axis）、https://pymupdf.readthedocs.io/en/latest/app1.html 、https://pymupdf.readthedocs.io/en/latest/page.html （Modifying Pages 前的 coordinate note）。

---

## 2. 阅读顺序：`sort=True` 到底做什么？多栏够用吗？

### 2.1 `sort=True` 的确切行为（官方原文）

`Page.get_text()` 的 `sort` 参数说明原文：

> sort (bool) – sort the output by vertical, then horizontal coordinates. **In many cases, this should suffice to generate a "natural" reading order.** Has no effect on (X)HTML and XML. For options "blocks", "dict", "json", "rawdict", "rawjson", **sorting happens by coordinates (y1, x0) of the respective block bbox**. For options "words" and "text", the text lines are completely re-synthesized to follow the reading sequence and appearance in the document – which even establishes the original layout to some extent.

变更历史：v1.19.1 新增 `sort`；**v1.24.11 改变了 `sort=True` 对 `"text"` 与 `"words"` 的行为，使其"closely follow natural reading sequence"**。

来源：https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_text

官方 elsewhere 把它概括为**「top-left to bottom-right」**方案：
- appendix 1："you can request a reordering following the scheme **'top-left to bottom-right'** by executing `page.get_text("text", sort=True)`."
- recipes-text："Use `sort` parameter of `Page.get_text()`. **It will sort the output from top-left to bottom-right** (ignored for XHTML, HTML and XML output)."

来源：https://pymupdf.readthedocs.io/en/latest/app1.html 、https://pymupdf.readthedocs.io/en/latest/recipes-text.html

### 2.2 对多栏排版：官方明说不够用

**官方 FAQ 原文（标题即问题）**：
> **Q** Text extraction doesn't follow reading order. **Columns are mixed up.** How do I fix this?
> **A** Text extraction order depends entirely on how the PDF was created. The internal order may not match visual reading order. Use `sort=True` to sort blocks by position (top-left to bottom-right): `text = page.get_text(sort=True)`
> **For multi-column layouts, this helps but isn't perfect. You may need to identify column boundaries yourself using block bounding boxes and split text accordingly. There is no universal solution because PDF creators can store text in arbitrary order.**

来源：https://pymupdf.readthedocs.io/en/latest/faq/index.html （查证 2026-09-25）

**维护者（JorjMcKie）在 issue 中的表述**：讨论跨栏标注时写道 "For a multi-column page you would have to also specify `clip` to prevent the logic extending lines across columns."（2021-12-10）
来源：https://github.com/pymupdf/PyMuPDF/issues/1445#issuecomment-989483751

**机制层面为什么不够**：`"dict"/"blocks"` 的 `sort=True` 是按 block bbox 的 `(y1, x0)` 做**全局排序**——两栏页面里左右两栏的 block 在 y 轴上交错，全局排序必然把左栏第二段与右栏第一段按 y1 互相穿插。官方 FAQ 因此建议**自行用 block bbox 判定栏边界再分组**。

**官方给出的其他替代手段**（recipes-text "How to Extract Text in Natural Reading Order"）：
1. `sort` 参数（top-left → bottom-right）；
2. 命令行 `python -m pymupdf gettext ...`，官方称其产出 "a text file where text has been re-arranged in **layout-preserving mode**"，且有多个选项可调；
3. 官方示例脚本（"You can also use the above mentioned script with your modifications"）。

来源：https://pymupdf.readthedocs.io/en/latest/recipes-text.html

### 2.3 官方生态里的多栏方案 = 版面模型（重要）

`pymupdf4llm` 的 README 宣称 "It handles **multi-column layouts** ... **Layout-aware** — multi-column pages, **reading-order reconstruction**, table detection"，能力表里写 "**Layout analysis** | Reconstructs natural reading order across single and multi-column pages"。
但它的安装说明同时写明：`pip install pymupdf4llm` 会 "automatically installs or upgrades PyMuPDF & **PyMuPDF Layout** as a dependency"；且 layout 模式的 `edge_threshold` 是 "passed through to **`page.get_layout()`** to adjust **the layout model's grouping confidence**"。

`pymupdf-layout` 独立包的一手元数据：
- 版本 **1.28.2**（2026-08-06），许可同 PyMuPDF（AGPL-3.0 / Artifex 商业双许可）
- 依赖：`PyMuPDF==1.28.2`、`pyyaml`、`numpy`、**`onnxruntime`**、`networkx`
- summary 原文："PyMuPDF Layout turns PDFs into structured data 10× faster than vision-based tools **using AI trained on PDF internals, not images. CPU-only. No GPU required.**"
- 仓库：https://github.com/ArtifexSoftware/pymupdf_layout

来源：https://raw.githubusercontent.com/pymupdf/pymupdf4llm/main/README.md 、https://pypi.org/pypi/pymupdf-layout/json 、https://pypi.org/pypi/pymupdf4llm/json （查证 2026-09-25）

**结论**：PyMuPDF 内核（C 层）提供坐标与 block 结构，但**阅读顺序重建在多栏场景要靠额外的 ONNX 版面模型**（`pymupdf-layout`），CPU 可跑、不需 GPU。`pymupdf4llm` 另有 legacy 模式（`pymupdf4llm.use_layout(False)`），但 README 把 `IdentifyHeaders`/`TocHeaders` 等自定义表头检测标为**仅在 legacy 模式可用**。

---

## 3. 判断 PDF 有没有文字层（是否扫描件）

### 3.1 官方给出的判据（没有单一 API）

recipes-ocr "How to OCR a Document Page" 原文：

> Determine whether OCR is needed / beneficial at all. A number of criteria can be used for this decision, like:
> - **page is completely covered by an image**
> - **no text exists on the page**
> - **thousands of small vector graphics** (indicating simulated text)

来源：https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html （查证 2026-09-25）

FAQ 的另一条官方诊断（问题原文 "I can see text in the PDF but `get_text()` returns empty or garbled characters. Why?"）：

> Several possible causes:
> - **Scanned PDF**: The page is an image, not real text. **You need OCR.**
> - **Scrambled encoding**: Some PDF creators intentionally scramble character sequences as copy-protection... **There is no reliable way to detect this programmatically.** If you see lots of U+FFFD (replacement characters), this is likely the cause.
> - **Custom font encoding**: The font does not provide a back-translation to Unicode. If the font's internal /ToUnicode map is missing, the information simply cannot be recovered. OCR is your fallback here.
> - **Diagnostic**: Try `page.get_text("rawdict")` and inspect the character codes. If they're all 0xFFFD or nonsensical, the encoding is broken at the PDF level, not a PyMuPDF issue.

来源：https://pymupdf.readthedocs.io/en/latest/faq/index.html

**关于「有没有官方 API 直接给出这一页是不是纯图」**：在 PyMuPDF 1.28.2 的 `Page` 方法清单与上述两页官方文档中，**未找到**此类单一 API（形如 `is_scanned` / `has_text_layer`）——**未确认存在**。可用的一手手段是官方提到的那几项判据 + `Page.get_images(full=True)` / `Page.get_image_info()` / `get_text("dict")` 的图片块 bbox。

### 3.2 图片相关 API（用于「整页被图覆盖」判据）

- `Page.get_images(full=False)`：列出页面 xref 引用的图片；官方提示可能含**不显示的死条目**（"dead" entries）。
- `Page.get_image_info()`：返回页面上**实际显示**的图片信息列表（含 inline images），"The dictionary layout is similar to that of image blocks in `page.get_text("dict")`"；**不加载图片二进制**，内存占用远低于 `get_text()`；且**不受 clip / 可见区域限制**（与 `get_text()` 只在 clip 内取图的规则相反）。

来源：https://pymupdf.readthedocs.io/en/latest/page.html （get_images / get_image_info）、https://pymupdf.readthedocs.io/en/latest/textpage.html （图片块）

### 3.3 官方推荐 OCR 路径

- 整页 OCR：`page.get_textpage_ocr(flags=3, language='eng', dpi=72, full=False, tessdata=None)`，把结果存进 TextPage，之后所有抽取/搜索复用它。
- 图像 OCR：`Pixmap.pdfocr_save()` / `Pixmap.pdfocr_tobytes()`。
- **基于 Tesseract**："The feature is currently based on Tesseract-OCR which must be installed as a separate application"。
- 成本原文："**optical character recognition is about one thousand times slower than standard text extraction**"。
- OCR 产物质量限制（原文照录）："All text is written as **'hidden'** with Tesseract's own **GlyphLessFont**, a **mono-spaced** font with metrics comparable to Courier."；"All text has the properties **regular and black** (i.e. **no bold, no italic, no information about the original fonts**)."；"**Tesseract does not recognize vector graphics** (i.e. no drawings / line-art)."

来源：https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html 、https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_textpage_ocr

---

## 4. PDF 里的表格与图片

### 4.1 `Page.find_tables()`——官方表格 API

签名（1.28.2 文档）：
```
find_tables(clip=None, strategy=None, vertical_strategy=None, horizontal_strategy=None,
            vertical_lines=None, horizontal_lines=None, snap_tolerance=None,
            snap_x_tolerance=None, snap_y_tolerance=None, join_tolerance=None,
            join_x_tolerance=None, join_y_tolerance=None, edge_min_length=3,
            min_words_vertical=3, min_words_horizontal=1, intersection_tolerance=None,
            intersection_x_tolerance=None, intersection_y_tolerance=None,
            text_tolerance=None, text_x_tolerance=None, text_y_tolerance=None,
            add_lines=None, add_boxes=None, paths=None, use_layout=True)
```

- `strategy`：`"lines"`（**默认**，"uses **all vector graphics** on the page to detect grid lines"）、`"lines_strict"`（忽略无边框的矩形矢量，减少误判）、`"text"`（用文字位置生成虚拟行列边界，配 `min_words_vertical` / `min_words_horizontal`）。
- `use_layout`（1.28.2 新增参数）："use **layout analysis** to gate line-based table candidates. **Set to False for pure line-based detection.**"
- 返回 `TableFinder`：`cells`（全页单元格 bbox 列表）、`tables`（`Table` 列表，也可当序列下标访问）。
- `Table`：`bbox`、`cells`、`extract()`（返回 list[list[str]]）、`to_markdown()`（GitHub 兼容，官方称 "optimized for small token sizes, which is especially beneficial for **LLM/RAG feeds**"）、`to_pandas()`、`header`（`TableHeader`：bbox / cells / names / external）、`col_count`、`row_count`、`rows`。
- **重要限制（官方 Caution）**："The lifetime of the `TableFinder` object, as well as that of all its tables **equals the lifetime of the page**. If the page object is deleted or reassigned, all tables are no longer valid." 想保留内容只能 `to_markdown()` / `to_pandas()` / `extract()[:]`。

版本沿革：`find_tables` **New in v1.23.0**；v1.23.19 增 `add_lines`；**1.28.2 release notes**：新增 `use_layout: bool = True`、`union: bool = False`、`refine: bool = False`，并 "Improved speed"。

来源：https://pymupdf.readthedocs.io/en/latest/page.html#Page.find_tables 、https://api.github.com/repos/pymupdf/PyMuPDF/releases/latest （1.28.2 body，查证 2026-09-25）

**一处需要留意的官方口径不一致**：recipes-text 说 `find_tables()` 的 "great advantage is that there are **no external library dependencies, nor the need to employ artificial intelligence or machine learning technologies**"（https://pymupdf.readthedocs.io/en/latest/recipes-text.html ）；而 1.28.2 的 `find_tables` 默认 `use_layout=True` 且文档称其为 "layout analysis"。**该 `use_layout` 是否依赖神经网络模型、还是 MuPDF 内置的确定性版面分析，官方在这两页均未说明——未确认。** 选型时建议实测 `use_layout=True/False` 的依赖与结果差异。

### 4.2 定位页面里的图片块（bbox）

- `page.get_text("dict")` 或 `"rawdict"` / `"json"`：图片块 `type == 1`，带 `bbox`；需 `TEXT_PRESERVE_IMAGES`（**DICT/RAWDICT/HTML/XHTML 的默认组合已含此位**，见 1.2 表）。
- `page.get_image_info()`：拿 bbox 而不取二进制，**更省内存**，且不受 clip 限制。
- `page.get_images(full=True)`：xref 级清单，可能含死条目。

另：矢量块（`type == 3`，需 `TEXT_COLLECT_VECTORS`）可用来找**表格框线**——这正是 `find_tables` 默认策略所依赖的 "vector graphics"。

---

## 5. DOCX 路径

### 5.1 **关键事实问题：普通段落的位置是否根本不存储在 DOCX 里？**

**结论：成立。**依据（均为 ISO/IEC 29500-1 条文，经 Microsoft Learn Open XML SDK 参考页照录）：

**(a) 正文的最小结构里没有任何坐标属性。** 官方对 WordprocessingML 基本结构的描述是：`document` → `body` → `p`（段落）→ `r`（run）→ `t`（文本）。官方给出的最小合法文档 `document.xml` 全文只有这五层元素，**无任何位置属性**。
来源：https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document （查证 2026-09-25）

**(b) 段落只有「相对缩进」，不是绝对坐标。** `w:ind (Paragraph Indentation)` 条文原文：

> Indentation settings are overriden on an individual basis - if any single attribute on this element is omitted on a given paragraph, its value is determined by the setting previously set at any level of the style hierarchy...
> [*Example*: ... a one inch indentation from the **text margins** on both the left and the right sides ... `<w:ind w:left="1440" w:right="1440" w:hanging="1080" />`]
> This set of indentation properties specifies that a *1440* **twentieths of a point** indentation should be provided on both the left and the right side of **the text margins**...

即：单位是 twips（1/20 point），基准是**文本页边距**，是相对量而非页面坐标。
来源：https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.indentation

**(c) 只有「文本框段落」才有绝对位置属性。** `w:framePr (Text Frame Properties)` 条文原文：

> *Text frames* are paragraphs of text in a document which are **positioned in a separate region or frame** in the document, and can be positioned with a specific size and position relative to non-frame paragraphs in the current document.
> ... This information is specified simply by the **presence of the framePr element** in paragraph's properties. **If the framePr element is omitted, the paragraph shall not be part of any text frame in the document.**
> The positioning of the frame relative to the properties stored on its attribute values shall be **calculated relative to the next paragraphs in the document which is itself not part of a text frame.**

其属性表中，`w:x` 的官方描述为 **"Absolute Horizontal Position"**、`w:y` 为 **"Absolute Vertical Position"**——**但只对 text frame 存在**，且锚定基准仍是"后一个非 frame 段落"。
来源：https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.frameproperties

**(d) 浮动对象才有绝对定位，且是相对偏移。** `wp:anchor (Anchor for Floating DrawingML Object)` 原文：

> Within a WordprocessingML document, drawing objects can exist in two states:
> - *Inline* - The drawing object is in line with the text, and affects the line height and layout of its line (like a character glyph of similar size).
> - *Floating* - The drawing object is anchored within the text, but **can be absolutely positioned** in the document **relative to the page**.

`wp:posOffset (Absolute Position Offset)` 原文：

> This element specifies an absolute measurement for the positioning of a floating DrawingML object within a WordprocessingML document. This measurement shall be **calculated relative to the top left edge of the positioning base specified by the parent element's `relativeFrom` attribute**.
> [*Example*: ... `<wp:positionH relativeFrom="page"><wp:posOffset>914400</wp:posOffset></wp:positionH>` ... The posOffset element specifies the absolute positioning of the object relative to the top-left edge of the page **in EMUs**.]

（914400 EMU = 1 英寸。）
来源：https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.anchor 、https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.positionoffset

**(e) 分页位置只以「上次渲染的提示」形式存在。** `w:lastRenderedPageBreak (Position of Last Calculated Page Break)` 条文原文：

> This element specifies that this position delimited the end of a page **when this document was last saved by an application which paginates its content**.
> [*Guidance*: This element must be used by applications to specify the locations of page breaks within a document when it is saved as WordprocessingML, in order to allow other applications (e.g. assistive software) to utilize this information when reading the document.]

这条最能说明问题：**连"分页"都只是渲染应用存下的近似位置**，且存的是「上一次计算」的结果——段落级的 y 坐标根本不存在于文件里。
来源：https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.lastrenderedpagebreak

**关于"官方是否有一句直白说明『Word 是流式排版、坐标在渲染时才产生』"**：在本次查证的官方页面中**未找到该原句——未确认**。但由 (a)–(e) 五条 schema 事实可等价推出：**DOCX 里普通段落没有坐标，只有逻辑结构 + 相对缩进 + 页面设置；绝对定位仅存在于文本框与浮动对象。**

### 5.2 因此 OOXML 直解能得到什么、得不到什么

| 能得到（逻辑层） | 得不到（几何层） |
|---|---|
| 段落/run/表格的层级与顺序（`body`/`p`/`r`/`tbl`/`tr`/`tc`） | 任何段落、行、run 的 **bbox** |
| 样式（`styles.xml`、`pStyle`、`rPr`：粗体/斜体/字号/颜色） | 行分割位置、换行点 |
| 相对缩进（`w:ind`，twips）与对齐（`w:jc`） | 该段落在第几页（只有 `lastRenderedPagebreak` 这个近似提示） |
| 页面设置（节属性 `sectPr`：页面尺寸与页边距，即 `w:ind` 所说的 "text margins"） | 文本框以外任何对象的坐标 |
| 文本框与浮动对象的**相对偏移**（`w:framePr/@w:x,@w:y`；`wp:posOffset`，EMU） | 这些偏移换算成最终页面坐标仍需渲染语境 |
| 图片的**二进制与关系**（`word/media/*`，`r:embed`） | 图片在页面上的位置 |

**对「题答混排 / 一页多题 / 多栏」这类判定的含义**：靠 DOCX 直解可以判断**逻辑归属**（某段属于哪道题、哪节），但判断不了**空间上的「同页」「同栏」「上下相邻」**——那是渲染产物。

### 5.3 LibreOffice headless（DOCX → PDF 路线）

- `soffice --headless --convert-to ...` 是官方记载方式。官方帮助 "Starting LibreOffice Software With Parameters" 载 `--headless` 定义（"Starts in 'headless mode' which allows using the application without user interface. This special mode can be used when the application is controlled by external clients via the API."）与语法 `--convert-to OutputFileExtension[:OutputFilterName[:OutputFilterParams[,param]]] [--outdir output_dir]`，示例含 `--convert-to pdf *.doc` 与 `--convert-to pdf:writer_pdf_Export --outdir /home/user *.doc`。Filter 名有官方清单：`writer_pdf_Export`（`application/pdf`）、`"MS Word 2007 XML"`（Word 2007 即 DOCX）。PDF filter 还可传 JSON 参数（官方示例 `--convert-to pdf:writer_pdf_Export:{"PageRange":{"type":"string","value":"2-5"}}`）。
  来源：https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html 、.../convertfilters.html 、.../pdf_params.html （帮助版本 = LibreOffice 26.8 Help，查证 2026-09-25）
- **保真度**：官方**没有**一篇集中讨论 headless 转换保真度的文档。可确认的一手事实：PDF 导出帮助称保 "the original formatting intact"；但 Bugzilla 有已确认反例——**161821（NEW，v7.6.5.2, 2024-06-27）"Pagination changes on PDF export, making ToC numbers wrong"**（https://bugs.documentfoundation.org/show_bug.cgi?id=161821 ）。
- **字体替换**：官方帮助 Fonts 页明确存在替换机制（"Substitutes a font with a font of your choice… you can override the default substitution font that your operating system uses when it encounters an **unavailable font** in a document"；选项 Always / Screen only）。→ 服务器缺中文字体会触发替换而改变度量与分页。
  来源：https://raw.githubusercontent.com/LibreOffice/help/master/source/text/shared/optionen/01010700.xhp
- **headless 并发限制**：官方帮助同页载注意事项 "LibreOffice requires write access to its user profile directory."，并记载 `-env:VAR[=VALUE]` 与示例 `soffice -env:UserInstallation=file:///tmp/test`（"to set a non-default user profile path"）。Bugzilla **106134（RESOLVED NOTABUG, 2017）"headless mode does not allow concurrent jobs"**、37531（FIXED）"Libreoffice will not run in batch mode when there is another instance open"。
  来源：同 start_parameters.html 、https://bugs.documentfoundation.org/show_bug.cgi?id=106134
- **服务器/容器**：**未确认** TDF 官方发布桌面版转换 Docker 镜像（Docker Hub `library/libreoffice` 404；`libreoffice` 命名空间下只有 `online`，last_updated 2020-09-08；TDF wiki 无 Docker 页）。
- **unoconv / unoserver 都不是官方项目**：属 `unoconv` 组织（非 TDF/LibreOffice）。unoconv 已 **archived**（最后 push 2023-04-19，GPL-2.0）；unoserver 活跃（**3.7, 2026-06-10**，MIT），README 载 `--user-installation`（"defaults to a dynamically created temporary directory"）并声明 "Only LibreOffice is officially supported."。GitHub `org:LibreOffice` 检索 unoconv/unoserver 命中 0。
  来源：https://raw.githubusercontent.com/unoconv/unoserver/master/README.rst 、https://pypi.org/pypi/unoserver/json

### 5.4 PyMuPDF 侧的 Office 支持（商业）

`pymupdf4llm` README 载："Extend support to Word, Excel, PowerPoint, and HWP/HWPX by pairing with **PyMuPDF Pro**: `pip install pymupdfpro`"。
`pymupdfpro` 的 PyPI 元数据：author Artifex，classifier `License :: Other/Proprietary License`（**专有许可**）。
来源：https://raw.githubusercontent.com/pymupdf/pymupdf4llm/main/README.md 、https://pypi.org/pypi/pymupdfpro/json （查证 2026-09-25；其具体定价与条款**未确认**）

---

## 6. 「统一栅格化」这条路线的评估

### 6.1 把页渲染成图的能力与成本（PyMuPDF）

官方 API：
```
get_pixmap(*, matrix=pymupdf.Identity, dpi=None, colorspace=pymupdf.csRGB,
           clip=None, alpha=False, annots=True)
```
- `dpi` 一旦给定则**忽略 `matrix`**（v1.19.2）；`matrix=Matrix(xzoom, yzoom)` 可缩放，zoom=2 即每方向像素翻倍。
- `alpha=False` 为默认，官方理由："This will save **a lot of memory (25% in case of RGB … and pixmaps are typically large!)**, and also processing time."；alpha=False 时空白处预填 0xff（白底），True 时预填 0x00（透明）。
- "The method will respect any page rotation and will not exceed the intersection of `clip` and `Page.cropbox`."
- `colorspace` 可选 `"GRAY"`/`"RGB"`/`"CMYK"`。

来源：https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_pixmap

**并发与成本（官方）**：
- "**PyMuPDF does not support running on multiple threads** - doing so may cause incorrect behaviour or even crash Python itself." → 必须用 **multiprocessing**。
- 官方给的范式：按 CPU 数把文档切成页区间，每进程处理一段（"The type of work would typically be **text extraction or page rendering**"）。
- 官方预期收益："speed improvements in range of **100% (ie. twice as fast) or better** can be expected."
- 另有量化对照："**OCR is roughly 1,000× slower** than native text extraction"（pymupdf4llm README）/ "optical character recognition is about **one thousand times slower** than standard text extraction"（recipes-ocr）。

来源：https://pymupdf.readthedocs.io/en/latest/recipes-multiprocessing.html 、https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html 、https://raw.githubusercontent.com/pymupdf/pymupdf4llm/main/README.md

### 6.2 pdf.js（官方事实）

- 定位：`pdfjs-dist` 的官方 description 为 "**Generic build of Mozilla's PDF.js library.**"；homepage https://mozilla.github.io/pdf.js/ ；repository https://github.com/mozilla/pdf.js 。
- **是 JavaScript 库**，后端要用必须走 Node 路径。一手证据：npm 包 `pdfjs-dist` **6.3.289**，`license: Apache-2.0`，`engines.node: ">=22.13.0 || >=24"`，`main: build/pdf.mjs`，`types: types/src/pdf.d.ts`，`optionalDependencies: {"@napi-rs/canvas": "^1.0.0"}`，`browser` 字段把 `fs`/`url`/`http`/`https`/`canvas` 全部置 false，unpackedSize **≈34.78 MB**。
  → 即服务器端渲染需要额外提供 canvas 实现（`@napi-rs/canvas`），不是纯 Python 方案。
- 该版本构建时间戳约 **2026-08-29**（取自 npm `_npmOperationalInternal.tmp`），查证日 2026-09-25。
- 渲染 API 细节（`PDFPageProxy.render` 的 viewport/scale、输出到 canvas）**未在本次查证中从官方文档确认——未确认**。

来源：https://registry.npmjs.org/pdfjs-dist/latest （查证 2026-09-25）

### 6.3 栅格化相比「读文字层」丢掉了什么

以下每一条都以官方原文为据：

| 丢失项 | 官方依据 |
|---|---|
| **精确的文字内容**（必须改用 OCR，约慢 1000×） | recipes-ocr："about one thousand times slower"；pymupdf4llm："OCR is roughly 1,000× slower" |
| **粗体/斜体/原字体名与度量** | recipes-ocr："All text has the properties regular and black (i.e. no bold, no italic, **no information about the original fonts**)"；且 OCR 文本用 Tesseract 自带 **GlyphLessFont（等宽）**，"metrics comparable to Courier" |
| **精确字号/颜色** | span 的 `size`/`color`/`flags`/`char_flags` 是文字层属性（textpage.html Span Dictionary）；OCR 产物不含这些（同上条） |
| **矢量图形**（含表格框线、下划线、图形示意） | recipes-ocr："**Tesseract does not recognize vector graphics** (i.e. no drawings / line-art)" |
| **`find_tables()` 的线条策略** | 官方定义默认策略 `"lines"` "uses **all vector graphics** on the page to detect grid lines"。栅格化后 PDF 层面已无 vector graphics 可读，该策略不再适用（**推论**——基于官方策略定义推得，官方无直接陈述） |
| **文本可搜索/可选中** | 文字层天然支持 `Page.search_for()`；纯位图需先补 OCR 文本层才恢复 |
| **体积/带宽** | 官方明说 pixmap "typically large"；且 alpha 一项就差 25% 内存 |
| **结构化要素（`TEXT_COLLECT_STRUCTURE`、链接、批注）** | 见 vars.html `TEXT_COLLECT_STRUCTURE`（256）；`get_pixmap` 的 `annots` 参数只是"画上去"，不产出结构 |

反过来，栅格化**不丢**的：版面的真实视觉外观（多栏、分栏框、图文相对位置全在像素上）、以及"不需要文字层"这一鲁棒性——扫描件与数字 PDF 在此路线上被统一处理。

**一个反向证据（对"必须栅格化"的削弱）**：PyMuPDF4LLM 自己的混合 OCR 策略说明，它**先分析页面再决定是否 OCR**，触发条件有四条："Too many illegible characters (�)"、"Presence of (many) vector graphics that simulate text"、"Presence of a previous OCR text layer"、"Presence of images containing text"；官方称该策略 "typically reduces OCR processing time by around **50%**"，并解释"applying full-page OCR on top of already-readable text can actually **degrade** output quality by introducing recognition errors"。→ 官方立场是**不要无条件栅格化 + 全页 OCR**。
来源：https://raw.githubusercontent.com/pymupdf/pymupdf4llm/main/README.md

---

## 7. 替代 / 补充库（仅列官方可确认项）

| 库 | 官方定位（README/pyproject 原文） | 许可 | 最新版 / 发布日 | 带坐标的结构化输出？ |
|---|---|---|---|---|
| **pdfplumber** | "Plumb a PDF for detailed information about each char, rectangle, line, et cetera — and easily extract text and tables." | **MIT**（`LICENSE.txt`、PyPI classifier） | **0.11.10**，2026-06-15 | **能**。`char`/`line`/`rect`/`curve`/`image` 带 `x0,y0,x1,top,bottom,doctop`；`extract_words()` 返回带 bbox 的词；`find_tables()` 返回 `Table`，有 `.cells/.rows/.columns/.bbox`。**无版面语义模型** |
| **pymupdf4llm** | "Turn PDF and other documents into clean, LLM-ready data — in one line of code. No GPU, no Cloud, no Tokens required." | **AGPL-3.0 / Artifex 商业**双许可 | **1.28.2**，2026-08-06 | **能**。`to_json(path)` 官方描述 "Structured output containing **bounding box coordinates**, layout element types, font metadata, and text content for every detected element on each page"；`to_markdown(..., page_chunks=True)` 的 chunk 含 `metadata`/`toc_items`/`page_boxes`/`text` |
| **unstructured** | "The `unstructured` library provides open-source components for ingesting and pre-processing images and text documents… use cases revolve around streamlining and optimizing the data processing workflow for LLMs." | **Apache-2.0** | **0.27.8**，2026-09-22 | **能**。`element.metadata.coordinates` 含 `points`（bbox 四角）与 `system`（如 `PixelSpace`，含 layout 宽高），并有 `Element.convert_coordinates_to_new_system(...)` |
| **docling** | "Get your documents ready for gen AI"；PyPI summary: "SDK and CLI for parsing PDF, DOCX, HTML, and more, to a unified document representation for powering downstream workflows such as gen AI applications." | **MIT**（代码）；README 另注 "For individual model usage, please refer to the **model licenses** found in the original packages." | **2.130.0**，2026-09-22 | **能**。`DoclingDocument` 条目带 `prov: list[ProvenanceItem]`，`ProvenanceItem = {page_no, bbox: BoundingBox, charspan}`，`BoundingBox = {l, t, r, b, coord_origin}` |

来源：https://pypi.org/pypi/<pkg>/json 、https://raw.githubusercontent.com/jsvine/pdfplumber/stable/README.md 与 LICENSE.txt 、https://raw.githubusercontent.com/pymupdf/pymupdf4llm/main/README.md 、https://raw.githubusercontent.com/Unstructured-IO/unstructured/main/README.md 与 LICENSE.md 、https://raw.githubusercontent.com/docling-project/docling/main/README.md 、https://docs.unstructured.io/open-source/concepts/document-elements 、https://raw.githubusercontent.com/docling-project/docling-core/main/docling_core/types/doc/common/reference.py （全部查证 2026-09-25）

### 7.1 Docling / pymupdf4llm 是否专门面向「喂 LLM 文档结构」

**是，官方明说。**
- Docling README："providing seamless integrations with the **generative AI ecosystem**"、"Plug-and-play integrations incl. LangChain, LlamaIndex, Crew AI & Haystack for agentic AI"。
- pymupdf4llm README："converts documents into structured Markdown, JSON, and plain text **optimised for RAG pipelines, vector embeddings, and LLM ingestion**"、"Page chunking — chunk output by page with full metadata per chunk, **ready for vector stores**"。
来源：两仓库 README（2026-09-25）

### 7.2 Docling 的格式支持与默认模型

- **输入格式**（官方 supported_formats 页）：PDF；DOCX/XLSX/PPTX（OOXML）；**DOC/XLS/PPT（Legacy binary Office 97–2004，requires LibreOffice）**；RTF、ODT/ODS/ODP、EPUB、Pages、Keynote、Markdown、AsciiDoc、LaTeX、HTML/XHTML、MHTML、CSV、PNG/JPEG/TIFF/BMP/WEBP、音频、视频、WebVTT、BoxNote、EML/MSG、AFP、DocLang/USPTO/JATS/XBRL XML、Docling JSON。
  → **支持 DOCX**；旧 `.doc` 也支持但**依赖 LibreOffice**（本方案已排除 .doc，此处仅记录）。
- **默认用深度学习模型：是。** README features 载 "Advanced PDF understanding incl. **page layout, reading order, table structure**…"；官方 `docling-tools models download` 默认下载 layout model / tableformer / picture classifier / code formula / OCR；模型首次使用自动下载到 `$HOME/.cache/docling/models`。Model catalog 用 ⭐ 标默认：layout = `docling-layout-heron`，表格结构 = **TableFormer（accurate mode）**（`TableFormerMode.ACCURATE` 为默认）。
- **权重来源与许可**：从 HuggingFace 拉取（`docling-tools models download-hf-repo <repo_id>`；官方仓库 `ds4sd/docling-models`，现重定向到 `docling-project/docling-models`）。`docling-ibm-models` 代码仓库为 MIT；HF 权重仓库声明的 license tags 为 **cdla-permissive-2.0 与 apache-2.0**。**官方 README 未逐一列举各模型许可——模型许可 ≠ 代码 MIT，选型时须按具体模型仓库复核。**
来源：https://docling-project.github.io/docling/usage/supported_formats/ 、https://raw.githubusercontent.com/docling-project/docling/main/docs/usage/advanced_options.md 、.../docs/usage/model_catalog.md 、https://api.github.com/repos/docling-project/docling-ibm-models 、https://huggingface.co/api/models/ds4sd/docling-models （2026-09-25）

### 7.3 unstructured 的 `partition_pdf` strategy

官方：可选 `"auto" | "hi_res" | "ocr_only" | "fast"`，**默认 `auto`**。
- `auto`：若 `skip_infer_table_types` 为空列表则选 `hi_res`（官方称是唯一能抽表的策略），否则若能抽文本选 `fast`，再否则 `ocr_only`；
- `hi_res`："will identify the layout of the document using **detectron2_onnx**"，用版面信息提升元素分类；若 detectron2_onnx 不可用则**回退 `ocr_only`**；
- `ocr_only`：Tesseract OCR 后走 `partition_text`；
- `fast`：pdfminer 抽文本后走 `partition_text`。
→ **官方明确 `hi_res` 依赖深度学习模型（detectron2_onnx）。**
来源：https://docs.unstructured.io/open-source/core-functionality/partitioning （2026-09-25）

---

## 8. 段落 / 题目切分

**有官方 API 的通用语义切分**（按标题/章节层级 + token 控制）：
- **unstructured**：`from unstructured.chunking.title import chunk_by_title`，chunking strategy 有 `basic` / `by_title`；官方称 by_title "preserves section boundaries… **a single chunk will never contain text from two different sections**"，并有 `combine_text_under_n_chars` 合并过小段。
  来源：https://docs.unstructured.io/open-source/core-functionality/chunking
- **docling**：`from docling.chunking import HybridChunker`，另有 `HierarchicalChunker` 与 BaseChunker 接口；官方称其为 "hybrid approach, applying **tokenization-aware refinements on top of document-based hierarchical chunking**"，按标题层级切块、超长再拆、过小合并（`merge_peers` 默认 True）。
  来源：https://docling-project.github.io/docling/concepts/chunking/
- **pymupdf4llm**：只有**按页** chunk（`page_chunks=True`），官方原文是 "page chunking"，**非语义段落/题目切分**。

**「把试卷切分成一道一道题目」这类专用语义切分**：在上述四库的官方文档/README 中**未找到任何"题目/试卷切分"的官方说明或 API——未确认**。能确认的只有上述「按标题/章节层级 + token」的通用能力。
另外 PyMuPDF 有一个 `TEXT_SEGMENT`（4096）flag，官方描述 "Attempt to segment page into different regions"，但明确标注 "**Detail documentation pending**"——**文档未补齐，不可作为方案依据**。
来源：https://pymupdf.readthedocs.io/en/latest/vars.html

---

## 对选型的含义

### A. 三类资源各自**最少**需要哪些库？要不要视觉模型？

**PDF（有文字层，绝大多数校内资料属于此类）**
- 最少：**PyMuPDF 一个库**即可拿到 文字 + 每个 span/line/block 的 bbox + 字体/字号/颜色 + 图片块 bbox + 表格（`find_tables`）。**不需要 OCR，也不需要视觉模型。**
- 多栏阅读顺序要额外一层（见 B）。
- 注意：PyMuPDF 是 **AGPL-3.0 / 商业双许可**。校内自建服务通常可接受 AGPL；若要闭源分发则需商业授权。若许可不可接受，**pdfplumber（MIT）**提供字符级坐标 + 表格，但**没有版面语义模型、没有 `sort` 之类的阅读顺序辅助**，且不支持 `find_tables` 之外的高级特性。

**PDF（无文字层 / 扫描件）**
- 最少：PyMuPDF + **Tesseract**（走 `get_textpage_ocr`），或直接用 PyMuPDF4LLM 的混合 OCR。仍然**不一定需要视觉大模型**。
- 代价明确：约慢 1000×；OCR 文本**丢粗体/斜体/原字体**、**不识别矢量图形**。

**DOCX**
- 最少：**OOXML 直解一个库**（`python-docx`、`lxml` 或自研）即可拿到逻辑结构、样式、相对缩进、页面设置。
- **但拿不到任何坐标**（见 5.1/5.2）。若重排需要坐标，则必须再走 DOCX→PDF→PyMuPDF，即 **LibreOffice 一套（`soffice --headless --convert-to pdf`，且每并发需隔离 `-env:UserInstallation`）+ PyMuPDF**。视觉模型同样非必需。
- 图/文框/浮动对象的相对定位可从 `w:framePr`、`wp:anchor`/`wp:posOffset` 直读。

**图片**
- 本来就是像素：**必须 OCR 或视觉模型**，没有文字层这条路。若只要文字 → OCR；若要「哪块是题、哪块是图、怎么切」→ 这才是**真正需要视觉模型**的场景。

**一句话**：视觉模型只在「图片」和「统一栅格化路线」上是必需品；PDF 与 DOCX 两条文字路径都能只用传统库完成取字与取坐标。

### B. 多栏阅读顺序：靠 PyMuPDF 自己能不能解决？

**不能。** 三条官方依据：
1. `sort=True` 的实现是按 block bbox 的 `(y1, x0)` 全局排序（page.html 原文），两栏会按 y 交错；
2. 官方 FAQ 对"Columns are mixed up"的回答明说 "For multi-column layouts, this helps but **isn't perfect**. You may need to **identify column boundaries yourself** using block bounding boxes and split text accordingly. **There is no universal solution**"；
3. 维护者在 issue 中："For a multi-column page you would have to also specify `clip` to prevent the logic extending lines across columns."

**可选出路（按成本从低到高）**：
1. **自研分栏**：用 `get_text("dict")` 的 block bbox 做 x 轴投影/间隙检测，切出栏区间，逐栏抽文本。官方 FAQ 明确指向这条路。**无额外依赖，但要自己处理不分栏/三栏/跨栏标题的混合情况。**
2. **上版面模型（CPU 可跑）**：
   - `pymupdf-layout`（ONNX Runtime，CPU-only，官方称"用 AI 训练于 PDF 内部结构而非图像"）——与 PyMuPDF 同一许可体系（AGPL/商业）；
   - `docling`（MIT 代码；默认 layout = `docling-layout-heron` + TableFormer accurate；模型权重从 HF 下载，许可需单独复核）；
   - `unstructured` `hi_res`（Apache-2.0；detectron2_onnx）。
   → **这三者都不需要 GPU 也能跑**，属"版面模型"而非"视觉大模型"。
3. 若统一走栅格化：在像素上判栏必然要视觉/版面模型，且额外损失见 6.3。

### C. 哪些结论必须真机实验才能确认（供 /prototype 验证）

1. **`find_tables(use_layout=True)` 到底依赖什么**——是否引入模型/额外依赖，与 `use_layout=False` 的结果差异。官方文档口径不一致，必须实测。
   （对应未确认项：4.1 末）
2. **PyMuPDF `sort=True` 在本校真实资料上的失败率**——取若干份两栏/三栏试卷，量化「文字被交错」的页占比，判断自研分栏是否够用，还是要上版面模型。
3. **自研分栏 vs `pymupdf-layout` 的准确率/速度对比**——同一批样本，人工标注正确阅读顺序，比较两者；同时量 CPU 时间与内存。
4. **LibreOffice DOCX→PDF 的保真度实测**——重点测：中文字体缺失时的替换行为与分页漂移、文本框/浮动图片位置、表格跨页。官方承认字体替换存在、Bugzilla 有分页漂移的已确认案例，但**没说影响多大**。
5. **DOCX 直解能给出的"归属信息"够不够用**——用真实试卷 DOCX，验证仅靠 `p`/`tbl`/`pStyle`/`w:ind` 能否判出"某段属于哪道题"，以及"同页/同栏"这类判断是否真的做不了。
6. **许可合规确认**——项目是否接受 AGPL-3.0（PyMuPDF / pymupdf4llm / pymupdf-layout）；若不接受，评估 pdfplumber + 自研分栏是否够用。
7. **渲染成本基线**——用 `get_pixmap(dpi=150/200)` 测单页渲染时间与峰值内存（官方只给了"multiprocessing 约快一倍"与 OCR 约慢 1000× 两个锚点，没有单页绝对数字），据以估算整批资料的墙钟时间。
8. **扫描件的实际占比**——统计校内真实资料的样本里 `get_text()` 返回空/近乎空的页比例，决定 OCR 是不是必须项（这直接决定要不要引入 Tesseract 及其中文语言包）。
9. **是否存在官方警告的两种"文字层不可信"情况**：① 故意打乱的编码（官方称 "no reliable way to detect this programmatically"）；② 缺失 `/ToUnicode` 的自定义字体编码。用 `get_text("rawdict")` 扫 U+FFFD 做筛查实验，评估这批资料的实际发生率。
10. **表格提取可用性**——`find_tables` 在无框线（纯 text 策略）表格上的表现，以及 `use_layout` 开关的影响。

---

### 本文件中的「未确认」清单（汇总）

1. PyMuPDF 是否有单一 API 直接判定「这一页是纯图」——**官方文档未列出此类 API**（未确认存在）。
2. `find_tables(use_layout=True)` 是否为模型驱动——**官方两处口径不一致，未确认**。
3. 官方是否有原句直说「Word 是流式排版、坐标在渲染时才产生」——**未找到该原句**（但 schema 事实等价支持该结论）。
4. TDF/LibreOffice 官方是否推荐用 Docker 做无头转换——**未确认**（未找到官方镜像）。
5. `pymupdfpro`（PyMuPDF Pro）的具体许可条款与定价——**未确认**（只确认 classifier 为 Proprietary）。
6. pdf.js 的渲染 API 细节（`PDFPageProxy.render` 的 viewport/scale 语义）——**未确认**（只确认包名、版本、许可、Node 版本要求、canvas 可选依赖）。
7. 「把试卷切分成题目」的成熟开源方案及其官方说明——**未确认**（四库官方文档中无）。
8. PyMuPDF `TEXT_SEGMENT` flag 的具体行为——**官方文档明确 "Detail documentation pending"**。
9. docling 各模型权重的逐项许可——**官方 README 未列举**，只确认 HF 仓库声明为 cdla-permissive-2.0 / apache-2.0。
10. PyMuPDF span bbox 单位在 appendix 1 写作 "pixel units"、appendix 3 写作 points——**官方文档自身措辞不一致**，以 points 为准需实测核对。
