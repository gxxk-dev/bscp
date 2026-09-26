# bscp 服务端

「课前准备」的会话在**进程内存**里（[ADR-0014](../../docs/adr/0014-session-holds-page-bitmaps-in-memory.md)）。
这个包是投放一张图片并投出去（#4）的那一段：闸门、内容哈希身份、区域位图、
错误信封。会话、编排、区域小图的生命周期全在**前端**。

## 跑起来

```sh
cd server
uv sync
uv run pytest                                    # 92 条，全过
uv run uvicorn --factory bscp.api:create_app --port 8000 --workers 1
```

前端要先 build：

```sh
cd prototype && bun run build
cd ../server && uv run uvicorn --factory bscp.api:create_app --port 8000 --workers 1
```

`/` 会拿到 `prototype/dist/index.html`，`/api/*` 走 API，**同一个 origin**——
测的和部署的是同一份字节（简报 §1.4）。

开发时前端热更新走 vite：`cd prototype && bun run dev`。`vite.config.ts` 里**已经配好**
`/api` → `http://127.0.0.1:8000` 的 proxy，所以另开一个终端跑上面那条 uvicorn 就能连上。
**客户端的 API 路径一律写相对路径 `/api/...`**：不许出现指向 `localhost:8000` 的
`VITE_API_BASE`，也不装 `CORSMiddleware`——它会一路掩盖配错的 proxy 进生产。
proxy 只存在于 dev；测的和部署的仍然是同一份字节、同一个 origin。

## `--workers 1` 是硬约束

会话在进程内存里。多 worker 的故障表现是：

> 健康检查正常 · 静态资源正常 · 投进去在 A 进程 · 下个请求到 B 进程 · **随机 410**

这是最难查的一类——没有任何一项单独看是错的。`BSCP_ENV=production` 且
worker 数 > 1 时**启动即失败**。uvicorn 0.54 不再往子进程写 `WEB_CONCURRENCY`，
所以 `api.detect_workers` 读的是**父进程的 argv**（`/proc/<ppid>/cmdline` 里的
`--workers`）；显式设 `BSCP_WORKERS=1` 永远最准。

⚠️ **`/proc` 是 Linux 专有的，而目标平台是 Windows 10 的希沃一体机。**
在那里第二层探测恒返回 `None`，于是这道守卫会**静默放过多 worker 的启动**——
症状恰好就是它存在的理由所描述的那个。探测不到时 `check_runtime` 会 `log.warning`
一次，但那是提醒不是拦截。Windows 上请显式设置：

```cmd
set BSCP_WORKERS=1
set BSCP_ENV=production
uv run uvicorn --factory bscp.api:create_app --port 8000
```

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `BSCP_STATIC_DIR` | `../prototype/dist` | 构建产物目录。目录不存在时 `/` 给**明确的 503**（`frontend_not_built`），不是 HTML 404 |
| `BSCP_ENV` | `development` | `production` 时启用启动形态断言 |
| `BSCP_TEST_HOOKS` | 关 | `=1` 时才注册 `/api/_test/*` |
| `BSCP_WORKERS` | 从父进程 argv 推断 | 显式声明 worker 数 |

## 端点

```
POST   /api/sessions                                         → 201
GET    /api/sessions/{sid}                                   → 200 | 410
DELETE /api/sessions/{sid}                                   → 204 | 410
POST   /api/sessions/{sid}/artifacts                         → 200（恒 200）
GET    /api/sessions/{sid}/artifacts/{aid}                   → 200 | 410   #5/#9 预留，#4 前端不调
GET    /api/sessions/{sid}/artifacts/{aid}/regions/{rid}      → 200 位图 | 410
GET    /api/healthz                                           → 200
POST   /api/_test/reset | /api/_test/expire | /api/_test/upload-probe   仅 BSCP_TEST_HOOKS=1
```

**投放端点恒 200。** 混着收与拒靠逐项 verdict 表达；批次级 4xx 会吞掉部分回执，
恰好毁掉「一次回执逐个点名」。

### 投放请求长什么样

```
POST /api/sessions/{sid}/artifacts
  files:      一份文件一个 part，字段名 `files`，**顺序即回执顺序**
  clientKeys: 可选，JSON 数组，与 files 等长同序
```

`clientKeys` 是客户端给每份文件起的键。multipart 的 part 名被 `list[UploadFile]`
吃掉了，拿不回这个信息，所以走一个平行的表单字段。**长度对不上就退回下标**——
是降级不是拒绝（端点恒 200）。同名文件是合法的，只有 clientKey（或下标）
能把回执对回自己那一个 `File`。

## 拒收码

服务端只给 `code + params`，**句子由前端 `messages.ts` 渲染**——拒绝理由是格式决定
（服务端权威），句子是 UI 副本。

| code | params | 出路 |
| --- | --- | --- |
| `docx_not_supported` | `filename` | 另存为 PDF 或截图再投 |
| `not_image_or_pdf` | `filename` | 首版只收图片与 PDF |
| `pdf_rasterizer_pending` | `filename` | #4 唯一挡 PDF 的码，**#5 删掉这一支** |
| `pixel_count_exceeded` | `width` `height` `pixels` `limit` | #4 自带的防崩闸门 |
| `empty_file` / `corrupt_image` | `filename` | 换一份 |
| `file_too_large` | `limit` | 单份太大。**逐项**拒，不升级成批次 413 |
| `session_budget_exceeded` | `limit` `held` | 这一轮持有的页位图到上限了。**逐项**拒 |

**`file_too_large` 与整批 413 是同一件事的两条路。** `MAX_FILE_BYTES`（单份，32MB）
必须**小于** `MAX_BYTES_HARD`（整批，128MB），所以任何一份超限的文件永远先被逐项闸门
接住，得到 200 + 上面那一行；413 只兜「一份份都合法、加起来太离谱」——那种情况下一条
回执都没有，只有 `payload_too_large`。曾经这两个常量**相等**，于是单份 40MB 先撞 413，
把同一批里其它文件的回执一起吞掉，恰好毁掉逐项闸门存在的理由。
`tests/test_ingest.py::test_one_oversize_file_is_a_verdict_not_a_413` 守着这条。

`pixel_count_exceeded` 与 ADR-0019 的 30MB 闸门是**两条**：#4 这条只保证「一个请求不会
把进程撑爆」，没有任何产品含义，ADR-0019 那条属于 #5。

## 不落盘

页位图只在内存里。上传路径上唯一会碰磁盘的是 Starlette 的
`SpooledTemporaryFile(max_size=spool_max_size)`——**默认 1MB**，
超过就滚到磁盘临时文件。那件事**从功能上看不出来**：图片照收、回执照样、
区域位图照给，只有一个文件经过了磁盘。所以：

- `bscp/spool.py` 导入即把 `spool_max_size` 提到 `config.SPOOL_MAX_BYTES`（128MB）
- `api.RejectOversizeBody` 在**读取请求体之前**拒掉超限请求，**两条路都堵**：
  带 `Content-Length` 的按头拒；**分块编码的数流**——只做前一条时，
  `Transfer-Encoding: chunked`（没有 `Content-Length`）会一路走到解析器，
  在 `spool_max_size` 处落成磁盘临时文件，之后才被逐项闸门以 `file_too_large`
  拒掉。功能全对，只是一份大文件经过了磁盘。
- `tests/test_no_disk.py` 断言 `UploadFile.file._rolled is False`，分块编码那条
  还配了**阳性对照**：摘掉预检中间件之后同一条请求**确实**会落盘

`config._check_invariants()` 在导入期就检查 `SPOOL_MAX_BYTES >= MAX_BYTES_HARD`
与 `MAX_BYTES_HARD > MAX_FILE_BYTES`：这两条破了，「不落盘」或「逐项回执」就破了。

## 资源耗尽

一体机通常只有 8GB，而 `POST /api/sessions` **无鉴权**（ADR-0014 的会话模型没有账号
这一层），校园网上任何能连到端口的人都能调它。两道上限：

- `config.MAX_SESSIONS`（64）：同时活着的会话数。满了直接 503 `too_many_sessions`，
  **不静默挤掉别人正在用的**——挤掉会让那个人的下一发请求变成一句莫名的 410
- `config.SESSION_BYTES_BUDGET`（128MB，单会话）：超了给**逐项**
  `session_budget_exceeded`，同一批里其它文件照拿回执（抛异常会掀掉整批）
  在 `_accepted` 追加 `Page` **之前**判。每次投放都续期，所以「一直投」原本等于
  「一直涨且永不过期」

`/api/healthz` **只回 `{"status":"ok"}`**。它无鉴权，而它曾经一并回 `env` /
`testHooks` / `sessions` / `bytesHeld`——`testHooks: true` 等于直接告诉对方那个
无鉴权的 `POST /api/_test/reset` 在哪儿，`bytesHeld` 是资源耗尽攻击的实时里程表。
诊断信息挪到 `BSCP_TEST_HOOKS=1` 才注册的 `GET /api/_test/diagnostics`。

## 会话

- 过期判定走 **`time.monotonic()`**。墙钟会被 NTP 校时拨动，也会被一体机的
  休眠/唤醒跳过一段。`datetime.now(UTC)` 只用来算给前端看的 `expiresAt`。
- TTL 30 分钟无活动，从**最后一次用到会话的请求**起算。
- **解析中豁免**（`PARSE_PIN_MAX`，= 2 × TTL）。它必须**大于 TTL**，否则是死代码：
  请求进来时 `last_seen` 被刷新，解析期间没人再碰它——一份 10 页的资料解析了
  25 分钟，`last_seen + 30min` 一到扫掠器就会在解析还在跑的时候把它回收。
- **投屏期间不续期**：那是客户端的义务，服务端只需要保证「不请求就不续期」成立。
- 「从没见过」与「见过但过期了」都是 410，但码不同（`session_unknown` /
  `session_expired`）。404 在一个 SPA 里与「路由不存在」不可区分，而客户端
  拿到 HTML 时 `res.json()` 抛 `SyntaxError`——那正是 spec 禁止的白屏。

## 挂载顺序

```
include_router(regions.router)
include_router(test_router)      # 仅 BSCP_TEST_HOOKS=1
include_router(api_router)       # 里面那条 /api/{rest_of_path:path} 兜底必须最后
app.mount("/", StaticFiles(...)) # 静态挂载必须最后
```

两处顺序都是硬约束，而且**写错的后果是静默的**：

- 静态挂载放到 `include_router` 前面 → `/api/*` 被 StaticFiles 吃掉、返回 HTML 404
  → 客户端 `res.json()` 抛 `SyntaxError` = 白屏，而**所有其它测试照样绿**
- 兜底路由放到具体路由前面 → 区域端点与测试钩子全部变成 404

`tests/test_api.py` 里有「所有 API 路径的 content-type 都是 JSON」守着它。

## 缓存头

**只有 `/assets/*` 允许被缓存**（`public, max-age=31536000, immutable`），
其余一律 `no-store`——包括 `index.html` 与 `/api/*`。课堂一体机的浏览器缓存
横跨不同的课次：一个留着上一节课 `index.html` 的壳去打新版本的 `/api/*`，
是最难复现的一类故障。

区域位图是**唯一**显式豁免的（`private, max-age=0, must-revalidate` + `ETag`）：
它不可变，而通用策略不该抹掉处理器自己的判断。

## 区域位图

#4 是**恒等直通**：`crop` 等于全页时直接 `return page.data`，**一个字节都不解码**。
所以 `tests/test_api.py` 断言的是**逐字节相等**——任何重编码都会改变它，
而重编码就是「偷偷提高/降低分辨率」的第一步。

Pillow 在 `ingest.py` 里只碰两处：`Image.open` 读头部拿尺寸与格式、`im.verify()`
验完整性。**不解码、不裁切、不缩放、不重编码**（[ADR-0008](../../docs/adr/0008-image-only-rasterize-first.md)）。

⚠️ **Pillow 自带的 decompression-bomb 保护在 `Image.open` 读尺寸时就会跑**
（`PIL/Image.py` 的 `_decompression_bomb_check`，位置在任何解码之前），阈值是
`2 * MAX_IMAGE_PIXELS` ≈ 179M px。它拦的是**头部**而不是解码，而它抛的是异常——
落到 `ingest_batch` 的列表推导里，一颗 200M px 的 PNG 会让**整批**文件连回执都没有
（500 而不是 `pixel_count_exceeded`）。所以 `ingest._probe_image` 读头时把
`Image.MAX_IMAGE_PIXELS` 设成 `None`，把真实宽高取出来，判定交给本项目那道更严的
`config.MAX_PIXELS`（40M）。我们不解码，关掉它没有代价。
`tests/test_ingest.py::test_decompression_bomb_is_a_verdict_not_a_500` 守着这条。

#5 只需要把 `regions.py` 的 `Image.crop()` 分支接通、把 `ingest.py` 的
`pdf_rasterizer_pending` 那一支删掉。前端契约一动不动。

## 测试

| 文件 | 守的是 |
| --- | --- |
| `test_sessions.py` | TTL 边界、续期、解析豁免与它的兜底。**不 sleep**——`sweep(now=t+1801)` 把时钟做成参数 |
| `test_ingest.py` | 闸门、逐项 verdict、内容哈希身份（ADR-0015） |
| `test_no_disk.py` | `_rolled is False` |
| `test_api.py` | JSON content-type、挂载顺序、钩子开关、缓存头、启动形态 |

测试全部打**完整 app**（`httpx.ASGITransport`），不是直接调纯函数：挂载顺序、
错误信封、`UploadFile` 的 spool 行为这些都只在 HTTP 路径上才存在。

**fixture 先造三份不同字节的图**（`FIXTURE_A/B/C`）。用同一个假 PDF 投两次，按内容
哈希去重之后就只剩 1 块，断言全部变成空过——去重是这个系统的身份规则，
fixture 不跟着它走就等于把回归网剪断了。

每条「必须为零 / 必须不存在」的断言都配一条「大于零」的阳性对照
（`test_fixture_is_actually_big`、`test_the_flag_is_read_when_the_app_is_built`）——
否则它们在类名改掉之后会 fail-open。

## 不在 #4 里

PyMuPDF 与 PDF 路径（#5）· 页数与 30MB 闸门（#5）· 视觉层（#6）· 拍板改框（#7）·
LLM 语义分组与 `unit`（#8）· 重跑解析（#9）· 4K 根字号（#12）· PWA 离线壳（#13）。
详见 `docs/specs/0001-v1.md` 与 `docs/adr/`。
