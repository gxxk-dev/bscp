"""共享的测试接缝。

**先造三份不同字节的 fixture。** 简报 §5-18 点名了这条：原型那几条级联测试投的
两份用的是同一个假 PDF，按内容哈希去重之后就只剩 2 块，**断言变得毫无意义**。
去重是这个系统的身份规则，fixture 不跟着它走就等于把回归网剪断了。
"""

from __future__ import annotations

import io
import json
import os
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from bscp import config
from bscp.api import create_app
from bscp.sessions import SessionStore


def png_bytes(width: int, height: int, *, seed: int = 0) -> bytes:
    """真 PNG。内容随 `seed` 变，所以不同 seed 一定是不同的字节。"""
    buf = io.BytesIO()
    im = Image.new("RGB", (width, height))
    im.putdata(
        [
            ((x * 7 + seed) % 256, (y * 13 + seed) % 256, seed % 256)
            for y in range(height)
            for x in range(width)
        ]
    )
    im.save(buf, format="PNG")
    return buf.getvalue()


def jpeg_bytes(width: int, height: int, *, seed: int = 0) -> bytes:
    buf = io.BytesIO()
    im = Image.new("RGB", (width, height), (seed * 37 % 256, 80, 160))
    im.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


#: 三份**不同字节**的图。命名固定，用例里按名字取。
FIXTURE_A = png_bytes(100, 100, seed=1)
FIXTURE_B = png_bytes(140, 90, seed=2)
FIXTURE_C = jpeg_bytes(300, 200, seed=3)

#: 真·大文件：**不可压缩**的像素，所以 PNG 之后还有 4MB 出头。
#: 梯度图会被 PNG 压到几十 KB，那样的文件永远触发不了 1MB 这条线，
#: 断言就成了「测了个寂寞」——它是绿的，但它什么都没验。
def big_png(width: int = 1200, height: int = 1200) -> bytes:
    buf = io.BytesIO()
    Image.frombytes("RGB", (width, height), os.urandom(width * height * 3)).save(
        buf, format="PNG", compress_level=1
    )
    return buf.getvalue()


BIG_PNG = big_png()

#: 假 docx / pdf / txt。内容不对，闸门靠扩展名与魔数判，不靠「像不像」。
FAKE_DOCX = b"PK\x03\x04" + b"\x00" * 256
FAKE_PDF = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n" + b"0" * 256
FAKE_TXT = "这不是图片，也不是 PDF。\n".encode()


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """每个用例都从「测试钩子关、构建产物不指向」的状态开始。"""
    monkeypatch.delenv(config.ENV_VAR_TEST_HOOKS, raising=False)
    monkeypatch.delenv(config.ENV_VAR_STATIC_DIR, raising=False)
    monkeypatch.delenv(config.ENV_VAR_ENV, raising=False)
    monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
    monkeypatch.delenv(config.ENV_VAR_WORKERS, raising=False)


def make_client(app: FastAPI) -> httpx.AsyncClient:
    """`raise_app_exceptions=False`：**必须关掉**，否则 500 的断言收不到响应
    （Starlette 的 ServerErrorMiddleware 会把异常重新抛给测试进程）。"""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://bscp.test",
    )


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with make_client(create_app()) as c:
        yield c


@pytest.fixture
async def hooked_client() -> AsyncIterator[httpx.AsyncClient]:
    """开着测试钩子的客户端。"""
    os.environ[config.ENV_VAR_TEST_HOOKS] = "1"
    async with make_client(create_app()) as c:
        yield c
    os.environ.pop(config.ENV_VAR_TEST_HOOKS, None)


@pytest.fixture
async def client_with_store() -> AsyncIterator[tuple[httpx.AsyncClient, SessionStore]]:
    """客户端 + 它那个 app 的 store。

    「现在有几个会话活着」原本是从无鉴权的 `/api/healthz` 上读的。那条已经收成
    `{"status":"ok"}`（见 `api.healthz` 的 docstring：`testHooks` / `bytesHeld`
    在无鉴权端点上等于给攻击者递了一张实时里程表）。想在**没有**测试钩子的
    app 上观察会话数，就走这里——进程内的测试不需要 HTTP 这道门。
    """
    app = create_app()
    async with make_client(app) as c:
        yield c, app.state.sessions


@pytest.fixture
def app() -> FastAPI:
    return create_app()


# ---------------------------------------------------------------- 投放辅助


def part(filename: str, data: bytes, content_type: str = "image/png") -> tuple[str, Any]:
    """multipart 里的一份文件，字段名 `files`（投放端点的参数名）。"""
    return ("files", (filename, data, content_type))


def named_part(field: str, filename: str, data: bytes) -> tuple[str, Any]:
    """字段名自定义的一份文件。"""
    return (field, (filename, data, "image/png"))


async def post_drop(
    client: httpx.AsyncClient,
    session_id: str,
    parts: list[tuple[str, Any]],
    client_keys: list[str] | None = None,
) -> dict[str, Any]:
    """投一批文件。`client_keys=None` 表示不带该字段，验服务端退回下标。"""
    data: dict[str, Any] = {}
    if client_keys is not None:
        data["clientKeys"] = json.dumps(client_keys)
    r = await client.post(
        f"/api/sessions/{session_id}/artifacts", data=data, files=list(parts)
    )
    assert r.status_code == 200, r.text
    return r.json()


async def new_session(client: httpx.AsyncClient) -> str:
    r = await client.post("/api/sessions")
    assert r.status_code == 201, r.text
    return str(r.json()["sessionId"])
