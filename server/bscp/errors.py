"""错误信封：一次一种形状。

**必须同时接 `StarletteHTTPException` / `RequestValidationError` / `Exception` 三个。**
少接一个，客户端就得多一套错误解析逻辑，而 spec 明令禁止那种「拿到 HTML 之后
`res.json()` 抛 `SyntaxError`」的白屏。

码集（与简报 §3.3 对齐）：

| code | 状态 | 含义 |
| --- | --- | --- |
| `session_expired` | 410 | 曾存在，TTL 到了 |
| `session_unknown` | 410 | 从没见过：进程重启，或 id 记错 |
| `artifact_unknown` | 410 | 会话在、资源不在 |
| `region_unknown` | 410 | 会话与资源在、区域不在 |
| `payload_too_large` | 413 | 超过 [`config.MAX_BYTES_HARD`] 防崩闸门 |
| `bad_request` | 400 | 请求体本身不合法 |
| `route_not_found` | 404 | `/api/*` 下没有这个端点（含未开启的测试钩子） |
| `method_not_allowed` | 405 | 端点在，方法不对 |
| `frontend_not_built` | 503 | `BSCP_STATIC_DIR` 不存在 |
| `too_many_sessions` | 503 | 同时活着的会话数到了 `config.MAX_SESSIONS` |
| `server_error` | 500 | 服务端出错了，堆栈只进日志 |

`server_unreachable` 是**纯客户端码**（`fetch` 自己就失败了，压根没拿到响应），
服务端**不**用它：那样「网络断了」和「服务端崩了」会在同一个码下混掉两条不同的出路。

**为什么「没见过」也是 410 而不是 404**：404 在一个 SPA 里与「路由不存在」不可区分。
而「从没见过」和「见过但没了」对操作者是同一个处境——**刷新了，或者等太久了**——
所以给同一个码、同一条出路。ADR-0014 明写「不是 404，更不是白屏」。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config

log = logging.getLogger("bscp.errors")

#: 「不落盘」这条不变量的最后一道：连错误响应也不许被缓存。
NO_STORE = "no-store"

#: 每种状态的默认 `message` / `remedy`。`message` 是**可读的中文**，
#: 因为它有可能直接被前端原样显示；具体到某一份文件的措辞由前端的
#: `messages.ts` 按 `code + params` 渲染，服务端不替 UI 写句子。
SERVER_ERROR_CODE = "server_error"
SERVER_ERROR_MESSAGE = "服务端出错了，重投一次。"

_CATALOG: dict[str, tuple[int, str, str, str]] = {
    "session_expired": (
        410,
        "这一次的准备已经在服务端释放了（30 分钟没有操作）。",
        "页位图只在服务端内存里保留 30 分钟；刷新页面或等太久都会释放。",
        "restart",
    ),
    "session_unknown": (
        410,
        "这一次的准备已经不在服务端了。",
        "可能是刷新了页面，也可能是服务端重启了；两者都不会把页位图留在本地。",
        "restart",
    ),
    "artifact_unknown": (
        410,
        "这份资源已经不在这一次的准备了。",
        "重新投放它就会重新登记。",
        "restart",
    ),
    "region_unknown": (
        410,
        "这个区域已经不在这一次的准备了。",
        "重新投放它就会重新切分。",
        "restart",
    ),
    "payload_too_large": (
        413,
        "这一份太大了。",
        "首版单份资源有体积上限；缩小或拆开之后再投。",
        "shrink",
    ),
    "bad_request": (
        400,
        "这一次的请求没读懂。",
        "重新操作一次。",
        "retry",
    ),
    "route_not_found": (
        404,
        "没有这个接口。",
        "这是接口路径的问题，不是操作的问题。",
        "none",
    ),
    "method_not_allowed": (
        405,
        "这个接口不接受这种操作。",
        "这是接口方法的问题，不是操作的问题。",
        "none",
    ),
    "frontend_not_built": (
        503,
        "前端的构建产物不在。",
        "先在 prototype/ 里跑一次 build，再让服务端指向它。",
        "retry",
    ),
    "too_many_sessions": (
        503,
        "同时进行的准备太多，服务端先歇一会儿。",
        "这一台机器上一次只服务几节课；等前面的过期，或者少开几个浏览器标签。",
        "retry",
    ),
    "server_error": (
        500,
        SERVER_ERROR_MESSAGE,
        "详情在服务端日志里，按 traceId 找。",
        "retry",
    ),
}



class ApiError(Exception):
    """带完整信封的领域错误。

    抛出它的地方不需要关心状态码：`raise ApiError("session_expired", sessionId=sid)`
    就够了，状态码与默认文案从 [`_CATALOG`] 取。
    """

    def __init__(self, code: str, *, status_code: int | None = None, **extra: Any) -> None:
        catalog = _CATALOG.get(code)
        if catalog is None:  # pragma: no cover - 拼错码是编程错误
            raise KeyError(f"未登记的错误码：{code}")
        default_status, message, detail, remedy = catalog
        self.code = code
        self.status_code = status_code or default_status
        self.message = message
        self.detail = detail
        self.remedy = remedy
        # `retryable` 只有 5xx 与「重投一次能好」的错误才为真；410 全是 false，
        # 因为重投不会把一份已经释放的会话变回来。
        self.retryable = self.status_code >= 500 or code in {"bad_request"}
        self.extra = extra
        super().__init__(f"{code}: {message}")

    def envelope(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "detail": self.detail,
            "remedy": self.remedy,
            "retryable": self.retryable,
        }
        error.update(self.extra)
        return {"error": error}


def _envelope(
    *,
    code: str,
    message: str,
    detail: str,
    remedy: str,
    retryable: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": code,
        "message": message,
        "detail": detail,
        "remedy": remedy,
        "retryable": retryable,
    }
    if extra:
        error.update(extra)
    return {"error": error}


def _respond(status_code: int, envelope: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=envelope,
        headers={"Cache-Control": NO_STORE},
    )


def _from_catalog(code: str, status_code: int | None, extra: dict[str, Any] | None) -> JSONResponse:
    default_status, message, detail, remedy = _CATALOG[code]
    status = status_code or default_status
    return _respond(
        status,
        _envelope(
            code=code,
            message=message,
            detail=detail,
            remedy=remedy,
            retryable=status >= 500 or code == "bad_request",
            extra=extra,
        ),
    )


def install(app: FastAPI) -> None:
    """把三个处理器装到 app 上。"""

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _respond(exc.status_code, exc.envelope())

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # 401/403 在本服务里不该出现（没有账号、没有鉴权）；StaticFiles 的 404 会走到这里。
        code = {
            404: "route_not_found",
            405: "method_not_allowed",
            413: "payload_too_large",
        }.get(exc.status_code, "bad_request")
        # StaticFiles 的 404 detail 是字符串，其它来源可能是结构化的。
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return _from_catalog(code, exc.status_code, {"detail": detail})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # 字段细节进 `detail`，但 message 仍然是那句可读的中文——操作者不该看到 pydantic 的
        # loc/type 术语，那属于开发期。
        return _from_catalog("bad_request", 400, {"detail": exc.errors()[0].get("msg", "")})

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # 堆栈只进服务端日志。响应里只有 traceId 与一句「重投一次」。
        trace_id = uuid.uuid4().hex[:12]
        log.exception("未处理异常 traceId=%s path=%s", trace_id, request.url.path)
        return _respond(
            500,
            _envelope(
                code=SERVER_ERROR_CODE,
                message=SERVER_ERROR_MESSAGE,
                detail="详情在服务端日志里，按 traceId 找。",
                remedy="retry",
                retryable=True,
                extra={"traceId": trace_id},
            ),
        )


__all__ = [
    "ApiError",
    "NO_STORE",
    "SERVER_ERROR_CODE",
    "install",
    "config",
]
