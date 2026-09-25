# 决策模型调研：PP-OCR / 版面分析 / ONNX / JS 运行时

> 调研日期：**2026-09-25**。所有版本号与日期均为该日查证结果。
> 取材限定一手来源：官方仓库源码与 release notes、官方文档站、HuggingFace 官方 org、npm/PyPI registry、官方云产品文档。
> 查不到的内容一律标为「**未确认**」，不做推测。
> 术语遵循 `CONTEXT.md`：资源 / 区域 / 版面 / 重排 / 决策模型 / 投屏 / 操作者。

---

## 结论速览

1. **PP-OCRv6 真实存在**，随 PaddleOCR v3.7.0 于 **2026-06-11** 发布，Apache-2.0，三档 tiny/small/medium，官方同时在 HuggingFace 提供 Paddle 与 **ONNX** 两套权重。
2. 操作者记忆中的「端侧模型」对应 **PP-OCRv6_tiny**（官方口径 1.5M 参数，det 0.43M + rec 1.1M），ONNX 文件合计约 **6 MB**。
3. 版面侧：PP-DocLayout 家族 + **PP-DocLayoutV3**（ECCV 2026，非平面文档、多点框 + 阅读顺序），后者是 PaddleOCR-VL-1.5/1.6 的版面模块；版面模型最小的是 **PP-DocLayout-S（4.8 MB）**。
4. **ONNX 路径畅通**：官方 org 直接托管 `inference.onnx`，另有 `paddle2onnx` 与 PaddleX 高性能推理两条官方转换路径（后者在 Windows 上需 Docker/WSL）。
5. **浏览器端有官方方案**：`@paddleocr/paddleocr-js`（Apache-2.0）基于 onnxruntime-web + OpenCV.js，但官方文档只声明支持 **PP-OCRv5**；onnxruntime-web 当前 **1.30.0**（2026-09-14），WebGPU EP 可用。
6. **Bun 进程内跑 onnxruntime-node**：Linux/macOS 已有官方修复与验证（Bun 1.4.x）；**Windows 仍有未关闭的 segfault 报告**，对希沃一体机是最关键的未确认项。
7. **Paddle.js（PaddlePaddle/Paddle.js）基本停更**：默认分支最后一次 commit 停在 2022-11-17，npm 最后发布 2023-04-26，不要依赖。
8. **托管 API 有两条官方路径**：AI Studio（`Authorization: token ...`，20,000 页/日免费额度）与千帆（`Bearer`，**只提供 PP-StructureV3 与 PaddleOCR-VL，不提供 PP-OCR**）。
9. 官方耗时数据**全部是 x86 服务器 CPU / Apple M4 / A100**，没有任何浏览器、WASM、WebGPU 或低功耗终端的数字——「能否在希沃浏览器里本地跑」目前**无一手数据支撑**。

---

## 1. PP-OCRv6 是否存在？

**结论：存在，命名正确，操作者记忆没错。**

### 1.1 发布信息

| 项 | 值 | 来源 |
|---|---|---|
| 发布版本 | PaddleOCR **v3.7.0** | https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0 |
| 发布时间 | **2026-06-11**（GitHub published_at `2026-06-11T12:09:14Z`） | 同上（GitHub API `/releases`，2026-09-25 查证） |
| 是否为当前最新 release | 是。截至 2026-09-25，`/tags` 首位仍是 v3.7.0（main 分支最后 commit 为 2026-09-16） | https://api.github.com/repos/PaddlePaddle/PaddleOCR/tags |
| 技术报告 | arXiv:2606.13108（HF 模型卡 tags） | https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det |
| 许可证 | **Apache-2.0**（仓库与全部 PP-OCRv6 HF 模型卡） | https://pypi.org/pypi/paddleocr/json ；HF 模型卡 `license: apache-2.0` |

### 1.2 三档变体与体积

PaddleOCR v3.7.0 release note 原文：

> Three tiers for all scenarios: tiny (1.5M) / small (7.7M) / medium (34.5M) for edge, mobile, and server deployment.

注意 1.5M / 7.7M / 34.5M 是**该档检测+识别两个模型合计的参数量**，不是单个模型。官方模块文档给出的单模型数据：

| 模型 | 定位 | 官方「模型存储大小」 | 参数量 |
|---|---|---|---|
| PP-OCRv6_tiny_det | 端侧 / IoT | **1.9 MB** | 0.43 M（文档原文） |
| PP-OCRv6_small_det | 移动端 | 9.6 MB | — |
| PP-OCRv6_medium_det | 服务端 | 59.4 MB | — |
| PP-OCRv6_tiny_rec | 端侧 | 4.4 MB | 1.1 M（见 §1.4 引文） |
| PP-OCRv6_small_rec | 移动端 | 20.4 MB | — |
| PP-OCRv6_medium_rec | 服务端 | 73.3 MB | — |

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/module_usage/text_detection.md 、
https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/module_usage/text_recognition.md （2026-09-25 查证）

**官方 HuggingFace ONNX 文件实际字节数**（HF API `/tree/main`，2026-09-25 查证）：

| HF 仓库 | `inference.onnx` |
|---|---|
| `PaddlePaddle/PP-OCRv6_tiny_det_onnx` | **1.70 MB** |
| `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` | **4.26 MB** |
| `PaddlePaddle/PP-OCRv6_small_det_onnx` | 9.42 MB |
| `PaddlePaddle/PP-OCRv6_small_rec_onnx` | 20.18 MB |
| `PaddlePaddle/PP-OCRv6_medium_det_onnx` | 59.16 MB |
| `PaddlePaddle/PP-OCRv6_medium_rec_onnx` | 73.01 MB |

→ **tiny 档 det+rec 的 ONNX 合计约 5.96 MB**，这是端侧可行性最关键的体积事实。

**未找到** 代号或子变体叫 `mobile` / `server` 的 PP-OCRv6 命名——PP-OCRv6 的档位名就是 **tiny / small / medium**，官方用 edge / mobile / server 描述它们各自的部署场景。

### 1.3 语言支持

官方文档原文：

> PP-OCRv6 medium/small 档支持以下 50 种语言：**核心语言**：简体中文、繁体中文、英文、日文；**拉丁语系（46种）**…
> PP-OCRv6_tiny 档支持 49 种语言（不含日文，以避免约 4000 个汉字/假名字符对 1.1M 参数输出层的影响）。

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md

### 1.4 官方精度数据

检测 Hmean(%)，内部 16 场景基准平均：

| 模型 | AVG | 手写CN | 印刷CN | 印刷EN | 日文 | 古籍 | 表格 | 旋转 | 通用 |
|---|---|---|---|---|---|---|---|---|---|
| PP-OCRv6_medium | **86.2** | 83.7 | 95.1 | 93.7 | 84.3 | 80.2 | 96.8 | **93.8** | 82.8 |
| PP-OCRv6_small | 84.1 | 80.5 | 94.2 | 93.6 | 82.3 | 72.6 | 95.6 | 93.7 | 78.2 |
| PP-OCRv6_tiny | 80.6 | 79.4 | 93.1 | 92.3 | 76.6 | 63.0 | 94.7 | 91.0 | 73.8 |
| PP-OCRv5_server（对照） | 81.6 | 80.3 | 94.5 | 91.7 | 77.2 | 67.6 | **97.1** | 80.0 | 79.7 |

识别准确率(%)，内部 15 场景加权平均：

| 模型 | W-Avg | 印刷CN | 印刷EN | 日文 | 古籍 | 屏幕 | 工业 |
|---|---|---|---|---|---|---|---|
| PP-OCRv6_medium | **83.2** | 91.5 | 94.1 | 90.5 | 72.4 | **82.5** | 77.4 |
| PP-OCRv6_small | 81.3 | 90.5 | 93.3 | 88.2 | 71.1 | 79.7 | 76.4 |
| PP-OCRv6_tiny | 73.5 | 86.7 | 88.4 | 89.8 | 68.4 | 71.2 | 62.1 |
| PP-OCRv5_server | 78.1 | 90.1 | 85.1 | 73.7 | 60.4 | 68.1 | 70.2 |

来源同上（`docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md`，2026-09-25 查证）。

**与本项目场景的相关性**：PP-OCRv6 相对 PP-OCRv5 提升最大的恰好是**日文（+16.8）、古籍（+12.0）、屏幕显示（+14.4）**，而「屏幕显示」和官方强调的「数码显示屏 / 点阵字符」正是白板投放素材时的常见退化场景。这一点对选型有正面意义。

> ⚠️ 表中 Gemini-3.1-Pro / GPT-5.5 / Qwen3-VL-235B 为 PaddleOCR 自测口径，非第三方复现；引用时应注意。

### 1.5 官方速度数据（§6 会再用一次）

端到端 OCR 产线（含读图、前后处理、推理），单位 s/image：

| 硬件 | 后端 | medium | small | tiny |
|---|---|---|---|---|
| Intel Xeon 8350C | PaddlePaddle | 2.05 | 0.79 | 0.32 |
| Intel Xeon 8350C | **OpenVINO** | **1.40** | 0.59 | **0.20** |
| Intel Xeon 8350C | **ONNX Runtime** | 3.31 | 0.61 | **0.22** |
| Apple M4 | PaddlePaddle | 8.82 | 3.07 | 0.96 |
| Apple M4 | ONNX Runtime | 5.55 | 1.29 | 0.35 |
| NVIDIA A100 | PaddlePaddle | 0.29 | 0.25 | 0.13 |

来源同上。**`Intel Xeon 8350C` 是服务器级 CPU，不是一体机 CPU。**

### 1.6 操作者可能实际记得的是什么

原话是「千帆 / Paddle 有一个 PP-OCRv6 端侧模型」。核实结果：

- 「PP-OCRv6 端侧模型」**指的应该是 PP-OCRv6_tiny**——官方定位原文即 "for edge, mobile, and server deployment"（tiny/small/medium 对应 edge/mobile/server）。
- 「千帆」这一半**不成立**：千帆不提供 PP-OCR 系列，只提供 PP-StructureV3 与 PaddleOCR-VL（详见 §5.2）。可能是把「飞桨星河 AI Studio 的 PP-OCR 官方 API」记成了千帆。
- 另一条可能的记忆来源是 **PaddleOCR-VL**（VL 系列，0.9B）——它是 VLM 而非传统检测识别模型，若记得「Paddle 有个新的 OCR 大模型」，可能指这个。

---

## 2. 版面 / 结构类模型现状

### 2.1 PP-DocLayout 家族

官方模块文档表格（「版面区域定位」）：

| 模型 | 骨干 | 官方精度 | 模型存储大小 | 说明（官方原文摘） |
|---|---|---|---|---|
| PP-DocLayout_plus-L | RT-DETR-L | 83.2 | **126.01 MB** | 更高精度版面区域定位，覆盖论文/杂志/报纸/PPT/合同/书本/**试卷**/研报/古籍/日文/竖版 |
| PP-DocLayout-L | RT-DETR-L | 90.4 | 123.76 MB | 高精度 |
| PP-DocLayout-M | PicoDet-L | 75.2 | **22.578 MB** | 精度效率平衡 |
| PP-DocLayout-S | PicoDet-S | 70.9 | **4.834 MB** | 高效率 |
| PP-DocLayoutV2 | — | — | ONNX **204.05 MB** | PaddleOCR-VL v1 的版面模块 |
| PP-DocLayoutV3 | — | — | ONNX **124.46 MB** / paddle 124.75 MB | PaddleOCR-VL-1.5/1.6 的版面模块 |

前五行来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/module_usage/layout_detection.md
后两行为 HF API 实测文件大小（2026-09-25）。

注：官方 `layout_detection` 模块文档**尚未收录 PP-DocLayoutV2/V3**；PaddleX 的 `paddlex/configs/modules/layout_detection/` 目录里只有 `PP-DocLayoutV2.yaml`，**没有 PP-DocLayoutV3.yaml**（`release/3.7` 与 `develop` 分支均如此，2026-09-25 查证）。V3 是通过 PaddleOCR-VL 产线配置引用的：

```yaml
# paddlex/configs/pipelines/PaddleOCR-VL-1.6.yaml
SubModules:
  LayoutDetection:
    module_name: layout_detection
    model_name: PP-DocLayoutV3
```

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleX/release/3.7/paddlex/configs/pipelines/PaddleOCR-VL-1.6.yaml

### 2.2 PP-DocLayoutV3 能力（官方模型卡）

原文摘：

> **PP-DocLayoutV3 is specifically engineered to handle non-planar document images. It can directly predict multi-point bounding boxes for layout elements—as opposed to standard two-point boxes—and determine logical reading orders for skewed and curved surfaces within a single forward pass, significantly reducing cascading errors.** This model is an essential component of PaddleOCR-VL-1.5, providing crucial layout analysis for the high-precision parsing of various real-world documents in PaddleOCR-VL.
> This work has been accepted to ECCV 2026!

- 论文：RT-DocLayout: Real-Time End-to-End Document Layout Analysis with Reading Order in the Wild，arXiv:2606.23344
- 能力：**异形 / 多点框**、**阅读顺序（单次前向）**、光照变化、倾斜、弯曲、屏幕拍摄（官方给了 4 组可视化）
- 许可证：Apache-2.0
- 定位：**这是 PP-DocLayout 家族里唯一在模型卡中明确「预测阅读顺序」的版本**——与「重排」这个核心需求直接相关

来源：https://huggingface.co/PaddlePaddle/PP-DocLayoutV3

### 2.3 PP-StructureV3

官方定位：在通用版面解析 v1 基础上强化版面区域检测、表格识别、公式识别，增加图表理解、**多栏阅读顺序恢复**、结果转 Markdown。产线包含 7 个模块/子产线（版面区域检测、通用 OCR、文档图像预处理、表格识别、印章文本识别、公式识别、图表解析），各模块可独立训练与推理。

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/pipeline_usage/PP-StructureV3.md

**未确认**：PP-StructureV3 之后的「V4」版本。截至 2026-09-25，PaddleOCR v3.7.0 仍是最新 release，仓库中无 PP-StructureV4 字样。

### 2.4 PaddleOCR-VL 系列

- **PaddleOCR-VL v1**（2025-10-16，PaddleOCR v3.3.0）：核心 `PaddleOCR-VL-0.9B` = NaViT 风格动态分辨率视觉编码器 + ERNIE-4.5-0.3B，支持 109 语言，版面模块用 PP-DocLayoutV2。
- **PaddleOCR-VL-1.5**（2026-01-29，v3.4.0）：OmniDocBench v1.5 上 94.5%，新增**异形框定位**、印章识别、文本检测识别（Spotting）。
- **PaddleOCR-VL-1.6**（2026-05-28，v3.6.0）：OmniDocBench v1.6 上 **96.33%**，与 1.5 架构完全兼容、零成本迁移。

来源：https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.6.0 、
https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md

**体积**（HF API `/tree/main`，2026-09-25）：

| 仓库 | 文件 | 大小 |
|---|---|---|
| `PaddlePaddle/PaddleOCR-VL-1.6` | `model.safetensors` | **1828.4 MB** |
| 同上 | `tokenizer.json` + `tokenizer.model` | 12.2 MB |
| `PaddlePaddle/PaddleOCR-VL-1.6-GGUF` | `PaddleOCR-VL-1.6-GGUF.gguf` | 892.4 MB |
| 同上 | `PaddleOCR-VL-1.6-GGUF-mmproj.gguf` | 840.9 MB |

**关键设计约束**（官方原文，对架构选型影响大）：

> 因此，**若需使用 PaddleOCR-VL 的完整能力，必须采用版面分析与 VLM 识别协同的完整流程，而不能仅单独使用 VLM。**
> 如果在使用过程中出现无法复现论文或 PaddleOCR 官网精度、模型输出大量幻觉文本等问题，首先应确认当前使用的是完整的 PaddleOCR-VL 流程，而不是仅使用其中的 VLM 组件。

来源：`docs/version3.x/pipeline_usage/PaddleOCR-VL.md`

**推理方式 × 硬件矩阵**（官方表格摘）：`PaddlePaddle` 与 `Transformers` 两种方式在 **x64 CPU** 上为 ✅；`vLLM` / `SGLang` / `FastDeploy` / `MLX-VLM` 在 x64 CPU 上为 ❌；`PaddlePaddle + llama.cpp` 在 x64 CPU 上为 ✅。即 **PaddleOCR-VL 可以在 x64 CPU 本机跑，但没有 GPU 时后端选择很有限**。

### 2.5 是否有端侧 / 轻量版本

| 类别 | 最轻的官方模型 | 体积 | 是否算端侧 |
|---|---|---|---|
| 版面检测 | PP-DocLayout-S | 4.834 MB | 是（官方定位「高效率」） |
| 版面检测（V 系） | PP-DocLayoutV3 | 124.46 MB (ONNX) | 否 |
| 结构 / 文档解析 | 无轻量版 | — | 否；PP-StructureV3 / PaddleOCR-VL 都是多模块产线 |

**未确认**：官方没有发布 PP-DocLayoutV3 或 PP-StructureV3 的端侧轻量变体。

### 2.6 非 Paddle 对照（仅写一手可确认内容）

**DocLayout-YOLO**（opendatalab/DocLayout-YOLO）
- 论文 arXiv:2410.12628（README 亦链接 2405.14458）
- 仓库代码许可证：**AGPL-3.0**（GitHub API `license.spdx_id`）
- HF 权重仓库 `juliozhao/DocLayout-YOLO-DocStructBench` 模型卡 `license: apache-2.0` —— **权重许可与代码许可不一致**
- HF 仓库内**只有 PyTorch 权重** `doclayout_yolo_docstructbench_imgsz1024.pt`（38.8 MB），**官方未托管 ONNX**
- 官方 DocLayNet 微调结果：DocSynth300K 预训练 + DocLayNet，AP50 93.4 / mAP 79.7
- 仓库最后 push：**2025-04-14**（2026-09-25 查证），维护活跃度低
- 来源：https://github.com/opendatalab/DocLayout-YOLO 、https://huggingface.co/juliozhao/DocLayout-YOLO-DocStructBench

**Surya**（datalab-to/surya）
- **代码 Apache-2.0，模型权重 OpenRAIL-M**（README badge 明确区分 Code License / Model License）
- 官方自述：650M 参数 OCR 模型，olmOCR-bench **83.3%**（自称 3B 以下最高），RTX 5090 上 5 pages/s，内部 91 语言基准 87.2%
- 能力：OCR + 版面分析（表格 / 图 / 页眉等）**含阅读顺序** + 表格识别
- 仓库最后 push：**2026-09-11**，最近 release v0.22.1（2026-07-20）→ 维护活跃
- 无官方 ONNX；官方主推托管平台（$5 免费额度）
- 来源：https://github.com/datalab-to/surya

---

## 3. ONNX 路径

### 3.1 官方是否直接提供 ONNX 权重

**是。** PaddlePaddle 官方 HuggingFace org 下已有大量 `*_onnx` 仓库，内含 `inference.onnx` + `inference.yml`。用 `https://huggingface.co/api/models?author=PaddlePaddle` 拉取（2026-09-25，共 **164** 个模型），筛出所有 `*_onnx` 仓库：

**文字检测 / 识别**
- `PP-OCRv6_{tiny,small,medium}_{det,rec}_onnx` —— 6 个，全部含 `inference.onnx`（另有 `inference.json`）
- `PP-OCRv5_{mobile,server}_{det,rec}_onnx`
- `{en,arabic,cyrillic,devanagari,el,eslav,korean,latin,ta,te,th}_PP-OCRv5_mobile_rec_onnx`（多语种 rec，多数下载量为 0）

**版面与结构**
- `PP-DocLayoutV3_onnx`（124.46 MB）
- `PP-DocLayoutV2_onnx`（204.05 MB）
- `PP-DocLayout_plus-L_onnx`（123.73 MB）
- `PP-DocBlockLayout_onnx`、`RT-DETR-L_{wired,wireless}_table_cell_det_onnx`
- `SLANet_onnx` / `SLANet_plus_onnx` / `SLANeXt_{wired,wireless}_onnx`
- `UVDoc_onnx`、`PP-FormulaNet_plus-L_onnx`、`PP-LCNet_x1_0_{doc_ori,textline_ori,table_cls}_onnx`、`PP-LCNet_x0_25_textline_ori_onnx`

来源：https://huggingface.co/api/models?author=PaddlePaddle （2026-09-25 查证）

**两个缺口值得注意**：
1. **PP-DocLayout-L / PP-DocLayout-M / PP-DocLayout-S 没有官方 ONNX 仓库**（只有 V2 / V3 / plus-L）。
2. PaddleOCR-VL 系列**没有官方 ONNX**；官方提供的是 GGUF（`PaddleOCR-VL-1.6-GGUF`）。

### 3.2 官方转换方式

**路径 A：PaddleX 的 Paddle2ONNX 插件**（官方文档《获取 ONNX 模型》原文命令）

```bash
paddlex --install paddle2onnx
paddlex \
    --paddle2onnx \
    --paddle_model_dir /your/paddle_model/dir \
    --onnx_model_dir /your/onnx_model/output/dir \
    --opset_version 7
```

文档同时提示 Windows 用户需先装 nightly 版 paddlepaddle：

```bash
python -m pip install --pre paddlepaddle -i https://www.paddlepaddle.org.cn/packages/nightly/cpu/
```

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/inference_deployment/others/obtaining_onnx_models.md

**路径 B：PaddleX 高性能推理（`enable_hpi`）**

官方原文（要点）：

> - 结合先验知识自动选择合适的推理后端（Paddle Inference、OpenVINO、ONNX Runtime、TensorRT等），并配置加速策略…
> - **根据需要自动将飞桨静态图模型转换为 ONNX 格式**，以使用更优的推理后端实现加速；
> - 使用 ONNX 模型完成推理。

调用方式：`paddleocr ocr --enable_hpi True ...` 或 `PaddleOCR(enable_hpi=True)`。

**Windows 相关的重要限制**（官方原文）：

> `cpu`：仅使用 CPU 推理。目前支持 **Linux 系统、x86-64 架构处理器**、Python 3.8-3.12。
> 对于 **Windows 系统，目前建议在 Docker 容器或者 WSL 环境中安装**。

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/inference_deployment/local_inference/high_performance_inference.md

> ⚠️ 这一条对「希沃一体机是 Windows 10」是硬约束：**官方的高性能推理（含自动转 ONNX）在 Windows 上不被原生支持，需 Docker / WSL。**

### 3.3 产线级消费 ONNX 的官方约定

PaddleOCR.js 的约定（见 §4.4）：模型包为**未压缩 ustar tar**，必须包含 `inference.onnx` 与 `inference.yml`，且 `inference.yml` 里的 `model_name` 必须与代码里传入的名字完全一致。

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/inference_deployment/cross_platform/browser.md

---

## 4. JS / WASM 运行时可行性

### 4.1 onnxruntime-web

| 项 | 值 | 来源 |
|---|---|---|
| 最新版 | **1.30.0**，发布于 **2026-09-14** | https://registry.npmjs.org/onnxruntime-web |
| 上一个版本 | 1.29.0（2026-08-24） | 同上 |
| dev tag | `1.31.0-dev.20260918-bc8e7ed75` | 同上 |
| 许可证 | MIT | 同上 |
| 依赖 | `onnxruntime-common@1.30.0`、`long`、`platform`、`protobufjs`、`flatbuffers`、`guid-typescript` | 同上 |
| 解包体积 | **137.9 MB**（dist unpackedSize） | 同上 |
| subpath exports | `.`、`./all`、`./jspi`、`./wasm`、`./webgl`、`./webgpu`，以及 7 个 `ort-wasm-*` wasm/mjs 直引 | 同上 |

**WASM EP 状态**：默认 EP。ORT 官方文档原文：

> If you are using ONNX Runtime Web for inferencing **very lightweight models** in you web application, and you want to have a small binary size, you can keep using the default WebAssembly (WASM) execution provider.

**WebGPU EP 状态**：可用，且是官方推荐的加速路径。原文：

> WebGPU is available out-of-box in latest versions of **Chrome and Edge on Windows, macOS, Android and ChromeOS**. It is also available in Firefox behind a flag and Safari Technology Preview.

启用方式（官方原文）：

```js
import * as ort from 'onnxruntime-web/webgpu';           // 打包器导入
const session = await ort.InferenceSession.create(modelPath,
  { executionProviders: ['webgpu'] });                    // 显式指定 EP
```

WebGPU EP 附带能力：Graph Capture（静态 shape + 全 WebGPU kernel 时可用）、IO binding（张量留在 GPU）、`ort.env.webgpu` 配置项。

来源：https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html

**构建层面**：ORT Web 的 wasm 产物可带 `--enable_wasm_threads`（多线程）与 `--enable_wasm_simd`（SIMD）标志，**默认构建不带这两项**；WebGPU / WebNN 走 JSEP（`--use_jsep`，WebNN 另需 `--use_webnn`）。完整产物为 3 组 `.wasm` + `.mjs`。

来源：https://onnxruntime.ai/docs/build/web.html

> 多线程 WASM 需要页面提供 **COOP/COEP** 响应头——这一点由 PaddleOCR.js 文档明确转嫁给宿主（见 §4.4）。

### 4.2 onnxruntime-node 在 Bun 下能否使用

**Bun 官方文档层面（Green）**

Bun 的 Node-API 页面自述：

> most existing Node-API extensions work with Bun out of the box

加载方式：`require("./my-node-module.node")`，或 `process.dlopen`。Node.js 兼容矩阵页面的总方针：

> "If a package works in Node.js but doesn't work in Bun, we consider it a bug in Bun."

来源：https://bun.com/docs/runtime/node-api 、https://bun.com/docs/runtime/nodejs-apis （2026-09-25 查证）

注意：Node-API 页面**未声明实现的 N-API 版本号，未提及 node-gyp、预编译二进制流程，也未列出已知限制**。

**Issue 层面（Linux / macOS Green，Windows 未确认）**

| Issue | 标题 | 状态 | 关键结论 |
|---|---|---|---|
| oven-sh/bun **#30431** | `bun test` 在 onnxruntime-node 测试集上 Linux 段错误 + macOS 退出 panic | **closed 2026-07-24** | 维护者 bot 复现并定位：Linux 侧是 `napi_module_register` 迭代器失效（#29981 修），macOS 侧是 finalizer 间 pending exception 泄漏（#30291 修）。**在 main `df84f8db1` 上用 `ppu-paddle-ocr@v5.3.0` 加载 onnxruntime-node 并建 session，`1 pass, 0 fail, EXIT: 0`** |
| oven-sh/bun **#34065** | macOS 退出时 `SIGTRAP: C++ exception in __cxa_finalize_ranges`（经 `@huggingface/transformers` 用 onnxruntime） | closed 2026-07-17（判为 #30431 重复） | 与上同源 |
| oven-sh/bun **#36307 / #36305** | Windows x64 下 `@huggingface/transformers` 在 `process.dlopen(onnxruntime.dll)` 阶段 segfault | closed 2026-07-29（无法复现） | 维护者 bot 在 Windows x64 + Bun 1.3.14 + 1.4.0-canary 上**无法复现**，推测为机器环境问题：`MSVCP140.dll` 版本不匹配 / VC++ 运行库旧、onnxruntime-node 安装损坏、杀软干扰。建议更新 VC++ 2015-2022 x64 可再发行组件 |
| oven-sh/bun **#28008** | `Bug: Segmentation fault when using ONNX runtime on Windows`（Windows 10 x64） | **OPEN（2026-09-25 查证，最后更新 2026-05-10）** | 栈回溯落在 `onnxruntime_binding.node` → `napi_open_escapable_handle_scope` → `Bun::NapiHandleScopeImpl::reserveSlot` → `JSC::JSCellLock::lock`。另有用户在 2026-05-10 报告在 **Windows 11 + Bun 1.3.13** 上复现同一崩溃 |

**当前 Bun 版本**：最新 release **bun-v1.4.2（2026-09-05）**（https://api.github.com/repos/oven-sh/bun/releases）

**结论**：

- **Linux / macOS：可用。** 官方已修复并验证（修复进入 1.3.14，验证在 1.4.0 main）。
- **Windows：未确认，且有未关闭的崩溃报告。** 这是本项目最关键的未确认项——目标硬件是 Windows 10 希沃一体机。
- 实践注意点一：维护者复现时显式跑了 `bun pm trust --all`（让 onnxruntime-node / protobufjs 的 postinstall 执行），说明 **Bun 默认不执行依赖的 lifecycle script**，需显式信任。
- 实践注意点二：**Bun #15374「`bun build` does not embed binaries from node_modules correctly」仍为 open**（2026-08-04）——若把服务打包成单文件可执行，原生 `.node` / `.dll` 的打包是已知薄弱点。

### 4.3 Paddle.js 的维护状态

**结论：实质停更，不建议作为技术栈依赖。**

`PaddlePaddle/Paddle.js` 实测数据（GitHub API，2026-09-25 查证）：

| 指标 | 值 |
|---|---|
| 仓库 `pushed_at` | **2024-04-03** |
| 默认分支 | `release/v2.2.5` |
| 默认分支最后一次 commit | **2022-11-17**（"Update README.md"） |
| 最近 tags | v2.1.0、v2.0.1、v2.0.0、v1.0（**无 v2.2.x tag**） |
| stars / open issues | 1104 / 109 |
| archived | false（未归档，但已停滞） |
| 许可证 | Apache-2.0 |

npm `@paddlejs/paddlejs-core`：

| 指标 | 值 |
|---|---|
| dist-tags | latest `2.2.0`，beta `2.2.0-beta.3` |
| 最后发布 | **2023-04-26**（`2.2.0-beta.3`） |
| registry modified | **2023-04-26** |

相关生态 `@paddle-js-models/ocr` 最后发布 **2024-03-03**（v4.1.1，ISC）。

来源：https://api.github.com/repos/PaddlePaddle/Paddle.js 、https://registry.npmjs.org/@paddlejs/paddlejs-core 、
https://registry.npmjs.org/@paddle-js-models/ocr

> 官方实际上用 **PaddleOCR.js**（§4.4）取代了 Paddle.js 在 OCR 场景的位置。

### 4.4 官方 PaddleOCR.js

| 项 | 值 | 来源 |
|---|---|---|
| npm 包名 | **`@paddleocr/paddleocr-js`** | https://registry.npmjs.org/@paddleocr/paddleocr-js |
| 最新版 | **0.4.2**，发布于 **2026-06-11** | 同上 |
| 首次发布 | 2026-04-02（0.1.0） | 同上 |
| 许可证 | **Apache-2.0** | 同上 |
| 描述 | "Browser-based OCR SDK powered by PaddleOCR, ONNX Runtime Web and OpenCV.js" | 同上 |
| 依赖 | `onnxruntime-web@^1.22.0`、`@techstark/opencv-js@^4.10.0-release.1`、`clipper-lib`、`js-yaml` | 同上 |
| 源码位置 | PaddleOCR 仓库内 `paddleocr-js/packages/core` | 同上 |
| 首次公告 | PaddleOCR v3.5.0 release note（2026-04-21）：「发布官方浏览器推理 SDK PaddleOCR.js，**支持在浏览器中运行 PP-OCRv5**」 | https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.5.0 |

**官方文档里出现的模型名**：只有 `PP-OCRv5`、`PP-OCRv5_mobile_det`、`PP-OCRv5_mobile_rec`（`lang` + `ocrVersion: "PP-OCRv5"`）。

> ⚠️ **PP-OCRv6 在 PaddleOCR.js 中的支持状态：未确认。** 官方文档通篇没有出现 PP-OCRv6；但提供了「自定义模型」通路——传 `textDetectionModelAsset.url` 指向自建 tar 包，tar 内需含 `inference.onnx` + `inference.yml`，`model_name` 需与传入名一致。理论上可以把 HF 上的 PP-OCRv6 ONNX 打包喂进去，但**官方未声明该组合被测试过**。

**运行时能力**：支持主线程与 Worker 两种模式；`ortOptions.backend` 可选 `wasm` 等；`numThreads` / `simd` 可配；可视化子路径 `@paddleocr/paddleocr-js/viz`。

**宿主职责（官方原文，直接关系到部署约束）**：

> - 启用多线程 WASM 或 WebGPU 时所需的 **COOP/COEP** 等响应头
> - **ORT 环境选项**（如 `wasmPaths`、线程数、SIMD）
> - 使用 **`worker: true`** 时，构建工具需能产出并加载 **module worker**

来源：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/inference_deployment/cross_platform/browser.md

### 4.5 第三方「把 PP-OCR 打包给 JS」的开源库

npm registry 检索结果（`https://registry.npmjs.org/<pkg>`，2026-09-25 查证）。筛选标准：直接基于 PP-OCR 模型 + ONNX 运行时。

| 包名 | 最新版 | 发布日期 | 许可证 | 运行时 | 声明支持的模型 |
|---|---|---|---|---|---|
| `@paddleocr/paddleocr-js`（官方） | 0.4.2 | 2026-06-11 | Apache-2.0 | onnxruntime-web | **PP-OCRv5**（文档口径） |
| `ppu-paddle-ocr` | 6.6.0 | **2026-09-13** | MIT | 自述 Node/Bun/Deno/RN/Worker/浏览器/扩展 | registry 元数据未列版本号 |
| `paddleocr` | 1.2.0 | 2026-07-03 | MIT | ONNX Runtime | 描述原文 "based on **PaddleOCR v5**" |
| `esearch-ocr` | 8.5.2 | 2026-08-13 | Apache-2.0 | `onnxruntime-common@^1.22.0` | 描述 "paddleocr models run on onnx" |
| `@gutenye/ocr-node` | 1.4.9 | 2026-09-19 | MIT | `onnxruntime-node@^1.22.0-rev`、`sharp` | README 称 "Based on PaddleOCR and ONNX runtime" |
| `@gutenye/ocr-browser` | 1.4.9 | 2026-09-19 | MIT | `onnxruntime-web@^1.17.3` | 同上 |
| `paddleocr-browser` | 1.0.4 | 2026-07-17 | MIT | — | "PaddleOCR on browser" |
| `@ocr-web/core` | 0.2.1 | 2026-05-08 | MIT | — | "PP-OCR inference engine for browser & Electron" |
| `paddle-ocr-onnx-models` | 0.2.0 | 2024-11-10 | (缺) | — | 仅模型权重包，已近 2 年未更新 |

**重要的可信度参考**：Bun 官方在 #30431 的验证里用的就是 **`ppu-paddle-ocr@v5.3.0`**（配合 onnxruntime-node），结论是通过。这使 `ppu-paddle-ocr` 成为目前唯一有官方间接背书的第三方库。

> ⚠️ **所有第三方库对 PP-OCRv6 的支持均为未确认。** registry 元数据与可见描述全部停留在 "PaddleOCR v5"。要确认需逐库查源码，本次未做。

**其他相关但非 PP-OCR 的包**（列出以免混淆）：`@xpert-ai/plugin-baidu-ocr`（AGPL-3.0，百度云 + 自建 PaddleOCR-VL 文档转换插件）、`@xpert-ai/plugin-ocr-paddle`（AGPL-3.0）、`paddleocr-skills`（MIT）。

---

## 5. 托管 API

### 5.1 飞桨星河 AI Studio（PaddleOCR 官方 API）

这是 **PaddleOCR 官网 `paddleocr.com` 实际指向的服务**（该域名 302 到 AI Studio，页面文字 "PaddleOCR Redirecting to AI Studio..."）。

| 项 | 值 | 来源 |
|---|---|---|
| 入口 | https://aistudio.baidu.com/paddleocr/task | https://www.paddleocr.com 的跳转目标 |
| 获取 token | https://aistudio.baidu.com/account/accessToken | https://ai.baidu.com/ai-doc/AISTUDIO/Kmfl2ycs0 |
| 鉴权 | HTTP header `"Authorization": f"token {TOKEN}"`（注意是 `token`，**不是** `Bearer`） | 同上 |
| Content-Type | `application/json` | 同上 |
| PP-OCR 端点 | `POST /ocr` | 同上 |
| PP-StructureV3 端点 | `POST /layout-parsing` | https://ai.baidu.com/ai-doc/AISTUDIO/Fmfz6oh2e |
| PaddleOCR-VL 端点 | `POST /layout-parsing` | https://ai.baidu.com/ai-doc/AISTUDIO/2mh4okm66 |
| 接口形态 | **专有 REST（非 OpenAI 兼容）**。原文「请求体和响应体均为 JSON 数据（JSON 对象）」 | https://ai.baidu.com/ai-doc/AISTUDIO/Kmfl2ycs0 |
| 同步 / 异步 | 主示例为**同步** POST；另提供「异步API使用文档」 | 同上 |
| 官方 SDK | Python / TypeScript / Go + CLI（v3.6.0 发布） | https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.6.0 |
| SDK 环境变量 | `PADDLEOCR_ACCESS_TOKEN`、`PADDLEOCR_BASE_URL`（可指向自建代理） | https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/inference_deployment/serving/paddleocr_official_api/typescript.md |

**配额与错误码**（官方《API 配额规则和错误码说明》）：

| 项 | 值 |
|---|---|
| 免费额度 | **每用户每模型 20,000 页/天** |
| 单文件上限 | **1,000 页**（超出只解析前 1000 页） |
| 429 | `超出单日解析最大页数` |
| 403 | Token 不匹配 |
| 413 | Payload 过大 |
| 422 | 参数错误 |
| 500 / 503 / 504 | 服务端错误 / 过载 / 网关超时 |
| 提升配额 | 提供「**免费申请提升配额**」的问卷入口 |

**定价信息：该文档未包含。**（有付费咨询通道，无公开价目表。）

来源：https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam

**未确认**：AI Studio 侧 PP-OCR / PaddleOCR-VL 的具体计费单价。公开文档只给了免费配额。

### 5.2 百度千帆（Qianfan）

**有，但只覆盖两个模型，且不含 PP-OCR 系列。**

**一手证据一**：PaddleOCR 官方仓库 `mcp_server` 中的 provider 定义。

```python
# mcp_server/paddleocr_mcp/selection.py
QIANFAN_SUPPORTED_MODELS = frozenset({"PP-StructureV3", "PaddleOCR-VL"})
SUPPORTED_MODELS = frozenset({"PP-OCRv5", "PP-OCRv5-latin", "PP-OCRv6",
                              "PP-StructureV3", "PaddleOCR-VL", "PaddleOCR-VL-1.5", "PaddleOCR-VL-1.6"})
```

`resolve_model()` 会显式拒绝：`Model 'PP-OCRv6' is not supported with qianfan source.`
（`inference/factory.py` 里 `ocr` 只注册了 LOCAL / AISTUDIO / SELF_HOSTED，**没有 QIANFAN**。）

**一手证据二**：默认 base URL 与鉴权。

```python
# mcp_server/paddleocr_mcp/__main__.py
"--qianfan-base-url", default=os.getenv("PADDLEOCR_MCP_QIANFAN_BASE_URL")
    or "https://qianfan.baidubce.com/v2/ocr"
"--qianfan_api_key", default=os.getenv("PADDLEOCR_MCP_QIANFAN_API_KEY")

# mcp_server/paddleocr_mcp/inference/shared/http_base.py
headers["Authorization"] = f"Bearer {self._api_key}"

# mcp_server/paddleocr_mcp/inference/{paddleocr_vl,pp_structurev3}/qianfan.py
def _get_endpoint(self): return "paddleocr"
```

→ 实际调用：**`POST https://qianfan.baidubce.com/v2/ocr/paddleocr`**，`Authorization: Bearer <api_key>`，body 为 `{"file": <base64 或 URL>, "fileType": 0|1, <camelCase 的产线参数>}`。

**一手证据三**：千帆官方文档确认模型上架与定价。

| 模型 | 上架时间 | 分类 | 定价（官网计费说明原文） |
|---|---|---|---|
| **PP-StructureV3** | **2025-12-12** | 推理服务API V2版本-OCR | 输入 **0.18 元/页**（活动价 0.09 元/页，限时 5 折） |
| **PaddleOCR-VL**（PaddleOCR-VL-0.9B） | **2025-11-28** | 推理服务API V2版本-OCR | 输入 **0.18 元/页**（活动价 0.09 元/页，限时 5 折） |
| Qianfan-OCR-Fast | 2026-02-10 | 推理服务API V2版本-视觉理解 | 输入 0.00045 元/千tokens / 输出 0.0018 元/千tokens |
| DeepSeek-OCR | 2025-11-21 | 推理服务API V2版本-视觉理解 | 输入 0.0003 / 输出 0.0012 元/千tokens |

折扣说明原文：「注：PaddleOCR-VL-0.9B、PP-StructureV3 限时5折优惠，将于 **2026年6月30日 24:00:00 恢复原价**。」
→ **按今天（2026-09-25）计算，五折活动已结束，实际为 0.18 元/页。**

来源：https://cloud.baidu.com/doc/qianfan/s/Kmh4stnjp （模型上架动态）、
https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya （计费说明，含 OCR 价格表）

**接口形态**：千帆这两条走的是「推理服务API V2版本-**OCR**」这条独立通路，body 形状（`file` / `fileType`）与 AI Studio 的 `/ocr`、`/layout-parsing` 一致，**是专有 REST，不是 OpenAI 兼容**。千帆主流的文本/视觉大模型走 OpenAI 兼容，但 OCR 这两个模型不是。

**未确认**：千帆 OCR 的免费额度 / 试用政策。本次未在公开文档中找到。

### 5.3 两条托管路径对比

| 维度 | AI Studio | 千帆 |
|---|---|---|
| PP-OCRv5 / PP-OCRv6 | ✅ | ❌ |
| PP-StructureV3 | ✅ | ✅ |
| PaddleOCR-VL / -1.5 / -1.6 | ✅ | ✅（官方文档只标 PaddleOCR-VL-0.9B） |
| 鉴权 | `Authorization: token <TOKEN>` | `Authorization: Bearer <API_KEY>` |
| 免费额度 | 20,000 页/日/模型 | 未确认 |
| 单价 | 未公开 | 0.18 元/页 |
| OpenAI 兼容 | ❌ | ❌ |

---

## 6. 端侧可行性：官方事实依据

**以下全部为官方公布的原始数字，不含本次调研的任何估算。**

### 6.1 官方耗时（端到端 OCR 产线，s/image）

| 硬件 | 后端 | medium | small | tiny |
|---|---|---|---|---|
| **Intel Xeon 8350C**（服务器 CPU） | PaddlePaddle | 2.05 | 0.79 | **0.32** |
| 同上 | OpenVINO | 1.40 | 0.59 | **0.20** |
| 同上 | ONNX Runtime | 3.31 | 0.61 | **0.22** |
| Apple M4 | PaddlePaddle | 8.82 | 3.07 | 0.96 |
| Apple M4 | ONNX Runtime | 5.55 | 1.29 | **0.35** |
| NVIDIA A100 | PaddlePaddle | 0.29 | 0.25 | 0.13 |

来源：`docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md`

### 6.2 官方体积

| 组合 | ONNX 合计 | 备注 |
|---|---|---|
| PP-OCRv6_tiny (det+rec) | **约 5.96 MB** | 端侧档 |
| PP-OCRv6_small (det+rec) | 约 29.60 MB | 移动端档 |
| PP-OCRv6_medium (det+rec) | 约 132.17 MB | 服务端档 |
| PP-DocLayout-S | 4.834 MB（Paddle 格式官方口径；**无 ONNX**） | 最轻版面模型 |
| PP-DocLayoutV3 | 124.46 MB（ONNX） | 带阅读顺序 |
| PaddleOCR-VL-1.6 | 1828.4 MB（safetensors） | GGUF 版 892.4 + 840.9 MB |

### 6.3 关键空白（必须明确说明）

1. **没有任何官方浏览器 / WASM / WebGPU 耗时数据。** PP-OCRv6 的官方速度表里没有 Node.js、浏览器、onnxruntime-web、WebGPU 任何一行。
2. **没有任何官方低功耗终端数据。** 官方最弱的 CPU 参照是 Intel Xeon 8350C（32 核服务器 CPU）与 Apple M4——这两者与希沃一体机（通常为低功耗 x86 或 ARM SoC）不在同一量级。
3. **因此「能否在一台普通 Windows 一体机的浏览器里本地跑 PP-OCRv6_tiny」在官方数据层面无法判断。** 唯一可用的一手硬事实是**体积（约 6 MB）足够小**，这一点明确有利；耗时必须实测。

---

## 对选型的含义

### A. 能放进 Bun 进程（onnxruntime-node）

**候选**：PP-OCRv6_tiny / small（det+rec）、PP-OCRv5_mobile（det+rec）、PP-DocLayout-S（需自行转 ONNX）、PP-DocLayoutV3（有官方 ONNX）、PP-DocLayout_plus-L、SLANet 系表格、PP-FormulaNet_plus-L。

**证据强度**：
- Linux / macOS：**强**。Bun #30431 已由官方复现、修复并在 1.4.x 上验证通过（用的就是 onnxruntime-node + PP-OCR 类模型的 JS 封装）。
- **Windows：未确认**。Bun #28008（Windows 上加载 `onnxruntime.dll` 段错误）截至 2026-09-25 **仍为 open**，且栈回溯直指 Bun 自己的 Node-API 实现（`NapiHandleScopeImpl::reserveSlot`）。另有 #36307 / #36305 同类报告被维护者判为不可复现并归因于环境（VC++ 运行库 / 杀软）。

**行动建议**：把「服务端推理」放在 **Linux 容器**里，而不是直接跑在希沃的 Windows 上；若必须在 Windows 上跑，先在目标机型做一次 onnxruntime-node 冒烟测试（记录 VC++ 运行库版本），再决定。注意 Bun 默认不执行依赖 postinstall，装完需 `bun pm trust`。

### B. 能放进浏览器（WASM / WebGPU）

**候选**：

- **PP-OCRv5**（mobile det+rec）—— **目前唯一有官方 SDK 明确背书的组合**（`@paddleocr/paddleocr-js` + `ocrVersion: "PP-OCRv5"`）。
- **PP-OCRv6_tiny** —— 体积约 6 MB，理论上完全可行（官方 ONNX 权重已托管），但 **PaddleOCR.js 官方文档未声明支持，属未确认**；可通过 `textDetectionModelAsset` / `textRecognitionModelAsset` 的自定义 tar 通路尝试。
- PP-OCRv6_small（约 30 MB）—— 体积可接受，但同样未确认。
- PP-DocLayoutV3（124 MB ONNX）—— 体积对浏览器首次加载偏大，**且 PaddleOCR.js 只做 OCR 产线**（官方高层入口仅 `PaddleOCR.create()` 一条），要跑版面得自己写 ORT 会话。

**部署约束（官方明说）**：多线程 WASM 或 WebGPU 需要 **COOP/COEP 响应头**；`worker: true` 需要构建工具产出 module worker；`cv.Mat` 在 Worker 模式下不可用。

**WebGPU 可用性**：Chrome / Edge on Windows 开箱可用（官方原话），这对希沃一体机上装 Chrome / Edge 的场景是有利的。

### C. 必须用 Python（PaddlePaddle 原生）或托管 API

**只能用 Python / PaddlePaddle 原生推理的**：

- **PP-OCRv6_medium**（132 MB ONNX，体积与服务端定位都指向 Python 侧）
- **PP-StructureV3** 完整产线（7 个模块的编排，PaddleOCR.js 不提供）
- **PaddleOCR-VL 完整流程**（版面 + VLM 两阶段）。官方明确：**不能只跑 VLM 组件**，否则精度不可复现且会出幻觉。官方矩阵显示 x64 CPU 上只有 `PaddlePaddle` 与 `Transformers` 两种推理方式被标为支持，vLLM / SGLang / FastDeploy 在 x64 CPU 上是 ❌。
- **PaddleX 高性能推理（`enable_hpi`）** —— 官方明确 Windows 需 Docker / WSL，Linux x86-64 才是一等公民。

**适合走托管 API 的**：

- 对精度要求最高、且能接受每页成本与网络依赖的文档解析 → **千帆 PP-StructureV3 或 PaddleOCR-VL，0.18 元/页**，或 **AI Studio，20,000 页/日免费**。
- 若一定要 PP-OCR（检测 + 识别）：**只有 AI Studio 提供**（`POST /ocr`，`Authorization: token ...`），千帆不提供。
- 两条路径都**不是 OpenAI 兼容**，但形态高度相似（`file` + `fileType` 的 JSON POST），可以抽象成同一个 provider 接口 —— **这也正是 PaddleOCR 官方 MCP server 的做法**（`InferenceProvider.AISTUDIO` / `QIANFAN` 共用 `HTTPInferenceBase`，只差 base URL 与 header 前缀）。项目要做「多后端可切换」，可以直接照抄这个抽象。

### D. 建议优先补齐的 4 个信息缺口

在写技术方案前，以下 4 项本次均未能从一手来源确认：

1. **Bun + onnxruntime-node 在目标希沃机型的 Windows 10 上是否稳定**（Bun #28008 未关闭）。
2. **PP-OCRv6_tiny 在希沃一体机浏览器里 WASM / WebGPU 的实际单页耗时** —— 官方零数据，只能实测。
3. **`@paddleocr/paddleocr-js` 是否能吃 PP-OCRv6 的自定义 tar 包** —— 官方文档只演示 PP-OCRv5，需用 HF 上的 `PP-OCRv6_tiny_{det,rec}_onnx` 实测一次。
4. **千帆 OCR 的免费额度**（AI Studio 已确认 20,000 页/日，千帆未找到公开说明）。
