"""测试接缝。**`BSCP_TEST_HOOKS=1` 时才注册。**

**flag 关闭时路由根本不注册**，不是「注册了再拒绝」——一个无鉴权的
`POST /api/_test/reset` 常驻在生产上就是「一键清空所有会话」的 DoS 开关。
`api.create_app` 里那句 `if config.test_hooks_enabled(): app.include_router(...)`
是这条不变量的全部实现，`tests/test_api.py` 里有它的阴性对照。

这三条都是**外部行为**的接缝：客户端看得见的结果，不是内部状态的偷看。
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel

from .ingest import CHUNK_BYTES
from . import config
from .sessions import SessionStore, get_store

router = APIRouter(prefix="/api/_test", tags=["test-hooks"])


class ExpireResult(BaseModel):
    sessionId: str
    expired: bool


class ResetResult(BaseModel):
    cleared: int


class UploadProbe(BaseModel):
    """`UploadFile` 在解析完之后长什么样。"""

    name: str
    size: int
    sha256: str
    #: **不落盘这条不变量的断言点。**
    #: Starlette 默认 1MB 就把上传滚到磁盘临时文件（`spool_max_size`），
    #: 功能全对、只是有文件经过了磁盘。`spool.py` 把上限抬到 32MB，
    #: 于是 `_rolled` 应当恒为 `False`。
    rolledToDisk: bool
    chunkBytes: int


class Diagnostics(BaseModel):
    """运行形态与内存占用。

    曾经挂在无鉴权的 `/api/healthz` 上，那等于给校园网上的任何人递了一张
    实时里程表：`testHooks: true` 直接告诉他那个无鉴权的
    `POST /api/_test/reset` 在那儿，`bytesHeld` 让他精确看到自己把一体机撑到
    多少。健康检查只需要 `{"status":"ok"}`，其余的挪到这里。
    """

    env: str
    testHooks: bool
    sessions: int
    bytesHeld: int
    maxSessions: int
    sessionBytesBudget: int


@router.get("/diagnostics", response_model=Diagnostics)
async def diagnostics(store: SessionStore = Depends(get_store)) -> Diagnostics:
    """`env` / `sessions` / `bytesHeld`。**只在测试钩子开启时存在。**

    e2e 用它确认自己打的是**这一次 spawn 起来的那个**服务端，而不是上一轮
    残留在同一端口上的旧进程（见 `tools/e2e.mjs` 的 `waitForServer`）。
    """
    return Diagnostics(
        env=config.env_name(),
        testHooks=config.test_hooks_enabled(),
        sessions=store.count(),
        bytesHeld=store.bytes_held(),
        maxSessions=config.MAX_SESSIONS,
        sessionBytesBudget=config.SESSION_BYTES_BUDGET,
    )


@router.post("/reset", response_model=ResetResult)
async def reset(store: SessionStore = Depends(get_store)) -> ResetResult:
    return ResetResult(cleared=store.clear())


@router.post("/expire", response_model=ExpireResult)
async def expire(
    sessionId: str = Query(..., description="要立刻过期的会话 id"),
    store: SessionStore = Depends(get_store),
) -> ExpireResult:
    """让一个会话立刻过期，不等 TTL。e2e 用它造「会话没了」那条错误路径。

    是把 `last_seen` 拨到过去，**不是**删掉——所以下一个请求拿到的是
    `session_expired`（见过、现已不在），那才是操作者真会撞上的那个码。
    """
    return ExpireResult(sessionId=sessionId, expired=store.expire(sessionId))


@router.post("/upload-probe", response_model=UploadProbe)
async def upload_probe(file: UploadFile = File(...)) -> UploadProbe:
    """把一个上传读完，报出它有没有被滚到磁盘。

    **只读不存**：读完就丢，不进会话。存在的唯一理由是
    `tests/test_no_disk.py` 需要一个能看见 `UploadFile.file._rolled` 的地方。
    """
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = await file.read(CHUNK_BYTES)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    spooled = file.file
    return UploadProbe(
        name=file.filename or "",
        size=size,
        sha256=digest.hexdigest(),
        rolledToDisk=bool(getattr(spooled, "_rolled", False)),
        chunkBytes=CHUNK_BYTES,
    )
