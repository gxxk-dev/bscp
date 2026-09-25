# 视觉层自托管：n-serv 上用 Python 版 PaddleOCR

版面检测与 OCR 跑在 n-serv 的 Linux 容器里，用 PaddleOCR 的 Python 原生推理实现。
决策层（付费 LLM 或决策模型）走远端 API——**两层分开选后端**。

理由：这一层是幂等的，结果可按资源内容哈希缓存，因此自托管的边际成本为零；
而按次计费的托管 API 会随使用量线性累积。更重要的是精度上限：调研确认
PP-StructureV3 完整产线、PaddleOCR-VL 完整流程、PP-OCRv6_medium 都只有 Python
原生推理能跑，且官方明确警告 PaddleOCR-VL 不能只跑 VLM 组件——否则精度不可复现
且会出幻觉（见 `docs/research/decision-models.md`）。

## Considered Options

- **全托管**：AI Studio（20,000 页/日免费）或千帆（0.18 元/页）。省运维，
  但精度封顶在服务商提供的产线，且按次计费。
- **浏览器 WASM**：不给服务器负载，但官方 SDK 只声明支持 PP-OCRv5，
  PP-OCRv6 未确认，且官方零浏览器耗时数据。

## Consequences

- 视觉层与决策层的后端策略不同，接口必须**分开设计**，不能合并成一个「AI 客户端」。
- 服务端需要 Python + PaddlePaddle 运行时。调研已确认 PaddleX 高性能推理官方
  **不支持 Windows 原生**（需 Docker / WSL），因此这一层只能待在 Linux 容器里
  ——这反过来锁定了后端位置。
- 两层结果都缓存，但失效条件不同：视觉层按资源内容哈希，决策层还要算上
  模型后端与提示的变化。
