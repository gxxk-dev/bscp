"""app 工厂、路由、静态挂载、缓存头。

## 挂载顺序是**硬约束**

```
include_router(api_router)      <- 必须在前面
include_router(regions.router)
app.mount("/", MissingBuild())  <- 在后面
```

写反了 `/api/*` 会被 `StaticFiles` 吃掉、返回一张 HTML 404，客户端
`res.json()` 抛 `SyntaxError`，表现是**白屏**——而 spec 把白屏列为禁止状态
（简报 §7-5）。`tests/test_api.py` 里有「所有 API 路径的 content-type 都是
JSON」的断言守着它。

再加一条 `/api/{rest_of_path:path}` 的 JSON 404 兜底：即使将来有人调换了顺序，
`/api/*` 也不会漏出 HTML。测试钩子关掉时的 `/api/_test/*` 也走这里。

## 单进程

`--workers 1`（ADR-0014 把会话放在进程内存）。`BSCP_ENV=production` 且
`WEB_CONCURRENCY>1` 时**启动即失败**——多 worker 的故障表现是「健康检查正常、
静态资源正常、随机 410」，属于最难查的一类（简报 §7-9）。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, File, Form, Response, UploadFile
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers

from . import config, errors, regions
from .config import ENV_VAR_WORKERS
from .errors import ApiError
from .ingest import ingest_batch
from .sessions import SessionStore, get_store
from .testhooks import router as test_router

log = logging.getLogger("bscp.api")

#: vite 的产物目录。带 hash 的文件名 + 永不失效的缓存头是标准做法。
_ASSET_PREFIX = "/assets/"
#: multipart 的信封开销（boundary、part 头、CRLF）。只用来给 413 的预检留余量。
_MULTIPART_OVERHEAD = 1024 * 1024


def _json(status_code: int, payload: dict[str, Any]) -> Response:
    return Response(
        content=json.dumps(payload, ensure_ascii=False).encode(),
        status_code=status_code,
        media_type="application/json",
        headers={"Cache-Control": errors.NO_STORE},
    )


def detect_workers() -> int | None:
    """尽力搞清「这个进程是几个 worker 里的一个」。搞不清就返回 `None`。

    三层，越靠前越可信：

    1. `BSCP_WORKERS` —— 显式声明。永远最准，也是测试唯一能驱动的入口。
    2. **父进程的 argv**。uvicorn 0.54 **不再**往子进程里写 `WEB_CONCURRENCY`
       （实测子进程里它是 `None`），所以只读那个环境变量等于没写。
       直接读 `/proc/<ppid>/cmdline` 里的 `--workers`。
    3. `WEB_CONCURRENCY` —— 老版本 uvicorn 与某些启动器仍然写它。

    第 2 层是 Linux 专有的。在别的平台上这一层返回 `None`，
    于是守卫退化成「靠 README 与测试」，而不是假装自己有信号。
    """
    declared = os.environ.get(ENV_VAR_WORKERS)
    if declared and declared.isdigit():
        return int(declared)
    from_argv = _workers_from_parent_argv()
    if from_argv is not None:
        return from_argv
    legacy = os.environ.get("WEB_CONCURRENCY")
    return int(legacy) if legacy and legacy.isdigit() else None


def _workers_from_parent_argv() -> int | None:
    try:
        with open(f"/proc/{os.getppid()}/cmdline", "rb") as fh:
            argv = fh.read().split(b"\0")
    except OSError:
        return None
    for i, token in enumerate(argv):
        text = token.decode("utf-8", "replace")
        if text == "--workers" and i + 1 < len(argv):
            value = argv[i + 1].decode("utf-8", "replace")
            return int(value) if value.isdigit() else None
        if text.startswith("--workers="):
            value = text.removeprefix("--workers=")
            return int(value) if value.isdigit() else None
    return None


def check_runtime() -> None:
    """启动形态断言。生产环境多 worker 直接拒绝启动，别等随机 410。

    理由：会话在进程内存里（ADR-0014）。多 worker 时「投进去在 A 进程、
    下个请求到 B 进程」会随机 410，而健康检查、静态资源、全局 410 **一切正常**——
    这是最难查的一类故障（简报 §7-9）。
    """
    if config.env_name() != config.ENV_PRODUCTION:
        return
    workers = detect_workers()
    if workers is not None and workers > 1:
        raise RuntimeError(
            f"BSCP_ENV=production 但 worker 数是 {workers}。"
            "会话在进程内存里（ADR-0014），多 worker 会让「投进去在 A 进程、"
            "下个请求到 B 进程」随机 410。请用 --workers 1。"
        )
    if workers is None:
        # 探测不到**不等于**只有一个 worker。目标平台是 Windows 10 的希沃一体机，
        # 而 `/proc/<ppid>/cmdline` 是 Linux 专有的——那里这一层恒返回 None，
        # 于是这道守卫会静默放过多 worker 的启动，症状恰好就是它存在的理由所
        # 描述的那个：健康检查正常、静态资源正常、随机 410。所以至少喊一声。
        log.warning(
            "BSCP_ENV=production 但探测不到 worker 数，"
            "多 worker 这道守卫在当前平台上无效。请显式设置 %s=1。",
            ENV_VAR_WORKERS,
        )


# ---------------------------------------------------------------- 路由

api_router = APIRouter(prefix="/api", tags=["api"])


@api_router.get("/healthz")
async def healthz() -> dict[str, str]:
    """健康检查。**只有 `status`**。

    它无鉴权，而 `/api/healthz` 在校园网的暴露面上是最容易被人先摸到的那个
    端点。曾经这里还回 `env` / `testHooks` / `sessions` / `bytesHeld`：
    `testHooks: true` 等于直接告诉对方那个无鉴权的 `POST /api/_test/reset`
    在哪儿，`bytesHeld` 是资源耗尽攻击的实时里程表。健康检查本来也只需要
    「还活着」这一句，其余的挪到 `BSCP_TEST_HOOKS=1` 才注册的
    `GET /api/_test/diagnostics`。
    """
    return {"status": "ok"}


@api_router.post("/sessions", status_code=201)
async def create_session(store: SessionStore = Depends(get_store)) -> Response:
    """**懒建**：第一次拖放/点选时才建，打开页面不烧会话。"""
    session = store.create()
    return _json(201, {"sessionId": session.id, "expiresAt": session.expires_at()})


@api_router.get("/sessions/{session_id}")
async def read_session(session_id: str, store: SessionStore = Depends(get_store)) -> dict[str, Any]:
    """200 | 410。**从来没见过也是 410**——见 `errors` 模块 docstring。"""
    return store.get(session_id).as_dict()


@api_router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, store: SessionStore = Depends(get_store)) -> Response:
    """用完就走。前端「重新开始」调它。未知 id 走 410，不是 204。"""
    store.get(session_id)
    store.delete(session_id)
    return Response(status_code=204)


@api_router.get("/sessions/{session_id}/artifacts/{artifact_id}")
async def read_artifact(
    session_id: str, artifact_id: str, store: SessionStore = Depends(get_store)
) -> dict[str, Any]:
    """资源元数据。**#5/#9 预留，#4 前端不调。**

    刻意**不返回原始字节**：原件在登记时就被吸收进页位图本身，
    而「页位图不落盘、不另存原件」（ADR-0014/0011）。要位图请走 regions 端点。
    """
    session = store.get(session_id)
    artifact = session.artifacts.get(artifact_id)
    if artifact is None:
        raise ApiError("artifact_unknown", sessionId=session_id, artifactId=artifact_id)
    return {
        "artifactId": artifact.artifact_id,
        "displayName": artifact.display_name,
        "bytes": artifact.byte_length,
        "pageCount": len(artifact.pages),
    }


@api_router.post("/sessions/{session_id}/artifacts")
async def upload_artifacts(
    session_id: str,
    files: list[UploadFile] = File(..., description="一次投放的全部文件，顺序即回执顺序"),
    clientKeys: str = Form("", description="JSON 字符串数组，与 files 等长、同序；留空则用下标"),
    store: SessionStore = Depends(get_store),
) -> dict[str, Any]:
    """投放端点。**恒 200**，混着收与拒靠逐项 verdict 表达。

    ## `clientKey` 怎么来

    multipart 里一个 part 只有一个名字，FastAPI 的 `list[UploadFile]` 把 part 名
    （`files`）吃掉了，拿不回客户端给每份文件起的键。所以客户端额外发一个
    `clientKeys` 字段（JSON 数组），**长度与 `files` 相同、顺序一致**。

    长度对不上就退回下标字符串——回执照样能按 `items` 下标对齐，
    只是丢掉了「同名文件也认得出来」的那一层。这是**降级，不是拒绝**：
    投放端点恒 200（简报 §3.1）。
    """
    session = store.get(session_id)
    keys = _client_keys(clientKeys, len(files))
    uploads = list(zip(keys, files, strict=True))
    return await ingest_batch(session, uploads)


def _client_keys(raw: str, count: int) -> list[str]:
    """把 `clientKeys` 字段解成每份文件一个键。

    **降级而不是拒绝**：投放端点恒 200。长度对不上就退回下标——回执照样能按
    `items` 下标对齐，只是丢掉了「同名文件也认得出来」的那一层。
    """
    if not raw:
        return [str(i) for i in range(count)]
    try:
        parsed = json.loads(raw)
    except ValueError:
        log.warning("clientKeys 不是合法 JSON，退回下标：%r", raw[:80])
        return [str(i) for i in range(count)]
    if not isinstance(parsed, list) or len(parsed) != count:
        got = len(parsed) if isinstance(parsed, list) else "非数组"
        log.warning("clientKeys 长度 %s 与文件数 %d 不符，退回下标", got, count)
        return [str(i) for i in range(count)]
    return [str(k) for k in parsed]


@api_router.api_route(
    "/{rest_of_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def api_not_found(rest_of_path: str) -> None:
    """`/api/*` 的 JSON 404 兜底。

    存在的理由不是「友好」，是**防 HTML 漏出**：`res.json()` 拿到 HTML 会抛
    `SyntaxError`，而 spec 把那个白屏列为禁止状态（简报 §7-5）。
    """
    raise ApiError("route_not_found", path=f"/api/{rest_of_path}")


# ---------------------------------------------------------------- 静态挂载


class MissingBuild(StaticFiles):
    """构建产物不在时给**明确的 503**，不是 HTML 404。

    `check_dir=False` 是必须的：`dist/` 是 gitignore 的，
    刚 clone 下来的仓库里它根本不存在，app 工厂不该在 import 时就炸。

    `html=True` 让 `/` 落到 `index.html`，也让以后的深链接可用。
    #4 的产品外壳没有前端路由，但**为它留一个开关**比等 #5 才发现白屏便宜。
    """

    def __init__(self, directory: Path) -> None:
        super().__init__(directory=str(directory), check_dir=False, html=True)
        self.directory_path = directory

    async def check_config(self) -> None:
        """Starlette 1.7 在**每个请求**上检查目录（`check_dir=False` 时才走这里）。

        覆盖它，把 `RuntimeError` 换成一条说得清的 503——`dist/` 是 gitignore 的，
        「忘了 build」是现场的常态，不是 500。

        **路径只进日志，不进响应体**：这条 503 无鉴权，而绝对路径会把部署目录、
        操作系统账号名与安装布局一起递出去。`hint` 已经足够让人知道该做什么。
        """
        if not self.directory_path.is_dir():
            log.error("BSCP_STATIC_DIR 指向的目录不存在：%s", self.directory_path)
            raise ApiError(
                "frontend_not_built",
                directory=self.directory_path.name,
                hint="cd prototype && bun run build",
            )

    def lookup_path(self, path: str):  # type: ignore[override]
        if not self.directory_path.is_dir():
            log.error("BSCP_STATIC_DIR 指向的目录不存在：%s", self.directory_path)
            raise ApiError(
                "frontend_not_built",
                directory=self.directory_path.name,
                hint="cd prototype && bun run build",
            )
        return super().lookup_path(path)


# ---------------------------------------------------------------- 中间件


class RejectOversizeBody:
    """在**解析请求体之前**拒掉超大的请求。

    为什么非要有这一层：`SPOOL_MAX_BYTES` 有上限，所以一个超大上传会被
    multipart 解析器**先滚到磁盘**、再被 `ingest` 逐项拒掉。那就破了
    「不落盘」（ADR-0014）——而这件事从功能上看不出来。

    两条路都堵死，而不是只堵一条：
    - 带 `Content-Length` 的：头里就有数，直接 413。
    - 分块编码的（`Transfer-Encoding: chunked`，**没有** `Content-Length`）：
      数流。这里包一层 `receive` 累计字节，越过上限就 413。

    只做前一条时，分块编码会一路走到解析器那里、在 `SPOOL_MAX_BYTES` 处落到
    磁盘临时文件，然后才被逐项闸门以 `file_too_large` 拒掉——功能全对，
    只是一份 40MB 的 part 已经经过了磁盘。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    def _too_large(self, length: int) -> Response:
        return _json(
            413,
            {
                "error": {
                    "code": "payload_too_large",
                    "message": "这一次的投放太大了。",
                    "detail": (
                        f"整次请求超过 "
                        f"{config.MAX_BYTES_HARD} 字节的防崩上限。"
                        "少投几份，或者缩小之后再投。"
                    ),
                    "remedy": "shrink",
                    "retryable": False,
                    "limit": config.MAX_BYTES_HARD,
                    "contentLength": length,
                }
            },
        )

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = config.MAX_BYTES_HARD + _MULTIPART_OVERHEAD
        raw = Headers(scope=scope).get("content-length")
        if raw is not None:
            try:
                length: int | None = int(raw)
            except ValueError:
                length = None
            if length is not None:
                if length > limit:
                    await self._too_large(length)(scope, receive, send)
                    return
                # 头可信：直接放行，**不要**把请求体再抄一份。普通上传都是这条
                # 路，多一次 `b"".join` 就是多一份峰值内存。
                await self.app(scope, receive, send)
                return

        # 没有 content-length（或它不可信）就数流。关键在于**越界之后不再把字节
        # 交给下游**：multipart 解析器只有在拿到超量的字节之后才会去滚磁盘临时
        # 文件，所以掐在这里就等于掐在它落盘之前。
        #
        # 代价是把请求体暂存在内存里，上限就是 `limit`。这与 `spool_max_size`
        # 的内存路径是同一笔开销（Starlette 本来也会把这些字节放在内存里），
        # 而且有界。正常客户端发 FormData 一律带 Content-Length，走不到这里。
        buffered: list[bytes] = []
        seen = 0
        overflow = False
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            body = message.get("body", b"")
            seen += len(body)
            # 无论越没越界都先看 `more_body`：客户端把流发完之后 `receive()`
            # 会一直挂着等下一块，所以这一行必须无条件执行。
            more = bool(message.get("more_body", False))
            if seen > limit:
                overflow = True
                buffered.clear()
            elif not overflow:
                buffered.append(body)
            if not more:
                break

        if overflow:
            await self._too_large(seen)(scope, receive, send)
            return

        payload = b"".join(buffered)

        async def replay() -> dict[str, Any]:
            nonlocal payload
            if not payload:
                return {"type": "http.request", "body": b"", "more_body": False}
            chunk, payload = payload, b""
            return {"type": "http.request", "body": chunk, "more_body": False}

        await self.app(scope, replay, send)


def cache_policy(path: str) -> str:
    """缓存头策略。**只有 `/assets/*` 允许被缓存**，其余一律 `no-store`。

    课堂一体机的浏览器缓存横跨不同的课次：一个留着上一节课 `index.html` 的壳
    去打新版本的 `/api/*`，是最难复现的一类故障。
    """
    if path.startswith(_ASSET_PREFIX):
        return "public, max-age=31536000, immutable"
    return errors.NO_STORE


class ApplyCachePolicy:
    """给响应补 `Cache-Control`——**处理器自己设过的不动**。

    `regions.py` 给位图显式设了 `private, max-age=0, must-revalidate` + `ETag`，
    那是它对「同一份资源永不变」的判断，不该被通用策略抹掉。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        policy = cache_policy(scope.get("path", ""))

        async def send_wrapper(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", policy.encode()))
            await send(message)

        await self.app(scope, receive, send_wrapper)


# ---------------------------------------------------------------- 工厂


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """后台扫掠任务。TTL 靠「请求时惰性过期」也成立，但没人请求时会一直占着内存。"""
    check_runtime()
    stop = asyncio.Event()
    store: SessionStore = app.state.sessions

    async def sweeper() -> None:
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=config.SWEEP_INTERVAL_SECONDS)
            if stop.is_set():
                break
            try:
                gone = store.sweep()
            except Exception:  # pragma: no cover - 扫掠失败不该拖垮进程
                log.exception("会话扫掠失败")
                continue
            if gone:
                log.info("回收了 %d 个会话", len(gone))

    task = asyncio.create_task(sweeper(), name="bscp-session-sweeper")
    try:
        yield
    finally:
        stop.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


def create_app() -> FastAPI:
    app = FastAPI(
        title="bscp",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.sessions = SessionStore()
    app.state.started_at = time.monotonic()
    errors.install(app)

    # 中间件是后进先出：预检必须在最外层，先于任何请求体读取。
    app.add_middleware(ApplyCachePolicy)
    app.add_middleware(RejectOversizeBody)

    # ---- 顺序即契约。
    # 具体路由先注册，`api_router` 里那条 `/api/{rest_of_path:path}` 兜底**最后**——
    # 它 catch 的是「`/api/*` 下没有任何别的路由匹配」，所以谁在它前面谁说了算。
    # 写错了的后果是静默的：区域端点与测试钩子会全部变成 404。
    app.include_router(regions.router)
    if config.test_hooks_enabled():
        app.include_router(test_router)
    app.include_router(api_router)
    # 静态挂载**最后**。写反了 `/api/*` 会被 StaticFiles 吃掉、返回 HTML 404，
    # 客户端 `res.json()` 抛 SyntaxError = 白屏。
    app.mount("/", MissingBuild(config.static_dir()), name="static")
    return app
