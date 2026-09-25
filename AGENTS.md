# 板上重排（bscp）

## 这是什么

校内白板要展示的资源（试卷、讲义、PDF、图片、Office 文档等）排版往往不适合直接投屏，
放上去之后显示效果不对。这个应用对资源做**自动分割、重排、OCR**，让它按预期展示，
同时允许手动拆分和拖动。

- 形态：**PWA + SPA**，主要跑在希沃一体机（Windows 10）的大屏触控环境里
- 主用户是站在大屏前的操作者，通常只盯着屏幕的某一个角落看，所以 UI 偏小、信息密度高，
  常用操作要靠近手指自然落点，细节见下面「UI 约束」
- 不是纯静态应用：AI 调用和资源处理都在服务端

## 术语

- **资源（artifact）**：被投放的原始文件，例如一份 PDF 试卷
- **区域（region）**：从资源里切出来的一块内容
- **版面（layout）**：一个资源切分之后，区域在大屏上的摆放方案
- **决策模型（decision model）**：负责版面检测、OCR、区域分割的专用视觉模型
- **重排（reflow）**：依据资源内容重新组织版面，让它按预期展示

术语以 `CONTEXT.md` 为准；本文件不重复维护词汇表。

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

## 调研笔记

`docs/research/` 存放带一手来源引用的调研结论。写代码前先看有没有相关的笔记。
