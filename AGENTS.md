# 板上重排（bscp）

## 这是什么

校内白板要展示的资源（试卷、讲义、PDF、图片等）排版往往不适合直接投屏，
放上去之后显示效果不对。这个应用把资源**整页栅格化**，在位图上**自动切分区域**并摊到
画布上，让操作者拍板后按预期展示，同时允许手动拆分和拖动。

**场景范围（决定了后面每一条约束）**：上课前临时把资料摆好、投出去、用完就关。
**不是讲课工具**——授课过程中的操作用希沃白板完成，不在这里。因此这个产品
**只解决重排**：不做留存、不做检索、不做导航。

- 形态：**PWA + SPA**，主要跑在希沃一体机（Windows 10）的大屏触控环境里
- 主用户是站在大屏前的操作者，通常只盯着屏幕的某一个角落看，所以 UI 偏小、信息密度高，
  常用操作要靠近手指自然落点，细节见下面「UI 约束」
- 资源一律**先栅格化成位图再看**：不读 PDF 文字层、不解析 DOCX 结构，
  区域**永远是裁切位图**，不做任何形式的文字重建（[ADR-0008](docs/adr/0008-image-only-rasterize-first.md)）
- **提高可读性靠切分粒度，不靠提高分辨率**：切得更碎，每块占的屏幕面积更大；
  「分辨率过低」是伪需求
- **首版只收图片与 PDF**，栅格化在服务端用 PyMuPDF 完成；DOCX 推迟
  （[ADR-0009](docs/adr/0009-rasterize-server-side-pdf-images-only.md)）
- 不是纯静态应用：AI 调用和资源处理都在服务端，**需要后端**（不是纯 SPA）

## 术语

- **资源（artifact）**：被投放的原始文件，只服务这一轮管线，栅格化后不保留原件
- **栅格化（rasterize）**：把 PDF/DOCX 整页转成位图，解析的前置步骤
- **区域（region）**：栅格图上裁切出的一块位图内容
- **碎开（scatter）**：解析产出区域后，整份资源在画布上裂成若干块、轻微分离但保留相对位置
- **语义单元（semantic unit）**：几块区域合起来构成的完整意思（一道题），AI 提议、可手工改
- **拍板（confirm）**：操作者接受或修改 AI 的裁切建议
- **编排（arrangement）**：操作者把区域摆到画布上，**纯人工**——AI 从不摆放
- **决策模型（decision model）**：负责版面检测与区域分割的专用视觉模型

术语以 `CONTEXT.md` 为准；本文件不重复维护词汇表。

## AI 边界

- AI **只提议**拆分与分组，**从不摆放**（[ADR-0010](docs/adr/0010-ai-proposes-only-arrangement-is-manual.md)）
- 两个提议都可被操作者推翻：裁切可改（拍板），分组可拆可合

## UI 约束

- 目标环境是**大屏 + 触控**，同时适配鼠标操作
- 操作者只看屏幕局部，所以：控件偏小、常驻控件少、常用动作靠近顺手位置
- 视觉规范遵循 design skill（`~/.claude/skills/design`），Tailwind CSS

## AI 调用约束

- LLM 与决策模型的调用**一律在服务端**完成
- API key、baseURL 绝不下发到客户端，客户端只调用本站 API
- LLM 与决策模型都要支持**多后端可切换**（同一份配置可以在几个后端之间换用）

## Agent skills

### Issue tracker

Issue 以 GitHub Issues 的形式管理，用 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个默认 triage 角色标签（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：仓库根目录一份 `CONTEXT.md`，决策记录在 `docs/adr/`。见 `docs/agents/domain.md`。

### 规格与原型

首版规格在 `docs/specs/0001-v1.md`。规格里那 12 条交互不变量有原型作证，
`prototype/` 是它们不可替代的来源，不要当成用完就扔的临时物；动交互前先跑
`cd prototype && bun run smoke`。见 `docs/specs/0001-v1.md` 的「原型的地位」。

## 调研笔记

`docs/research/` 存放带一手来源引用的调研结论。写代码前先看有没有相关的笔记。
