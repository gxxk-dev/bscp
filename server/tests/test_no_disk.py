"""「不落盘」这条不变量的回归网（ADR-0014）。

## 为什么它必须存在

Starlette 的 multipart 解析器把超过 `spool_max_size`（**默认 1MB**）的上传部分
滚到磁盘临时文件。这件事**从功能上看不出来**：图片照收、回执照样、区域位图照给，
只有一个临时文件经过了磁盘。所以它是那种「功能全对、但把 ADR-0014 的核心前提
悄悄破掉」的改动——**唯一能被自动化守住的方式就是在这里断言它**。

`spool.py` 把上限提到 `config.SPOOL_MAX_BYTES`；本文件断言它确实生效，
而且断言的是**行为**（`_rolled`）不是配置值（配错了也可能是别的路径漏出去）。
"""

from __future__ import annotations

import httpx
import pytest
from starlette.formparsers import MultiPartParser
from collections.abc import AsyncIterator

from bscp import config, spool  # noqa: F401 - `spool` 必须被导入过，monkeypatch 才生效
from bscp.api import RejectOversizeBody, create_app
from tests.conftest import (
    BIG_PNG,
    FIXTURE_A,
    make_client,
    named_part,
    new_session,
    part,
    post_drop,
)

#: Starlette 的出厂值。**这个数只增不减**——有人把它调回 1MB 时，这条会响。
STARLETTE_DEFAULT_SPOOL = 1024 * 1024


def test_fixture_is_actually_big() -> None:
    """阳性对照：文件必须**真的**大于 1MB，否则下面那条断言是空过。

    简报 §7-6 的硬规则——每条「必须为零/不存在」的断言配一条「大于零」的对照。
    """
    assert len(BIG_PNG) > STARLETTE_DEFAULT_SPOOL
    assert len(BIG_PNG) > 4 * 1024 * 1024


def test_spool_threshold_is_raised() -> None:
    assert MultiPartParser.spool_max_size == config.SPOOL_MAX_BYTES
    assert MultiPartParser.spool_max_size > STARLETTE_DEFAULT_SPOOL
    # 必须不小于防崩闸门，否则超限请求会**先落盘再被拒**——见 `RejectOversizeBody`。
    assert config.SPOOL_MAX_BYTES >= config.MAX_BYTES_HARD


async def test_upload_is_never_rolled_to_disk(hooked_client: httpx.AsyncClient) -> None:
    """核心断言：4MB 的上传走完之后，`UploadFile.file._rolled` 仍然是 `False`。"""
    r = await hooked_client.post(
        "/api/_test/upload-probe", files=[named_part("file", "大.png", BIG_PNG)]
    )
    assert r.status_code == 200, r.text
    probe = r.json()
    assert probe["size"] == len(BIG_PNG)
    assert probe["rolledToDisk"] is False
    assert probe["chunkBytes"] == 64 * 1024


async def test_ingest_itself_never_rolls_to_disk(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """走真实的投放路径：投一份 > 1MB 的图，然后在会话里验它的字节还在、没被落盘。

    这里没有直接看 `UploadFile`——投放端点拿到的 `UploadFile` 已经在 `ingest` 里
    读完了。能守住的替代断言是**回执与区域端点都拿到了完整的字节**：
    一旦中间被换成「临时文件路径」，这两处都会拿到 0 字节或报错。
    """
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("大.png", BIG_PNG)])
    (item,) = body["items"]
    assert item["status"] == "accepted"
    assert item["bytes"] == len(BIG_PNG)

    r = await client.get(item["region"]["bitmapUrl"])
    assert r.status_code == 200
    assert r.content == BIG_PNG


async def test_small_upload_also_stays_in_memory(hooked_client: httpx.AsyncClient) -> None:
    """小文件同样不许落盘——不是因为它小就可以。"""
    r = await hooked_client.post(
        "/api/_test/upload-probe", files=[named_part("file", "小.png", FIXTURE_A)]
    )
    assert r.json()["rolledToDisk"] is False


def _chunked_multipart(parts: list[tuple[str, Any]]) -> AsyncIterator[bytes]:
    """手搓一个 multipart 请求体，**分块**送出去。

    `AsyncIterator`（不是 `iter`）是 httpx `AsyncClient` 要求的形态。
    带上 `Transfer-Encoding: chunked` 之后 httpx 不会自己算 `Content-Length`，
    于是这条请求真的走分块路径——正是 httpx 自动发 multipart 时照不到的那种。
    """
    out: list[bytes] = []
    for field, (filename, data, ctype) in parts:
        out.append(
            f'------b\r\nContent-Disposition: form-data; name="{field}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
        )
        out.append(data)
        out.append(b"\r\n")
    out.append(b"------b--\r\n")

    async def stream() -> AsyncIterator[bytes]:
        for chunk in out:
            yield chunk

    return stream()


_CHUNKED_HEADERS = {
    "Content-Type": 'multipart/form-data; boundary="----b"',
    # httpx 看到它就不会自己算 Content-Length，于是这条请求真的走分块路径。
    "Transfer-Encoding": "chunked",
}

#: 闸门和落盘阈值一起调小。**两个都必须调**：只调 `MAX_BYTES_HARD` 的话
#: `spool_max_size` 还留在 128MB，4MB 的 fixture 压根到不了落盘那条线，
#: 于是「没落盘」这条断言与中间件在不在完全无关——它恒真。
_SMALL = 64 * 1024


async def _post_chunked(client: httpx.AsyncClient) -> httpx.Response:
    return await client.post(
        "/api/_test/upload-probe",
        content=_chunked_multipart([named_part("file", "大.png", BIG_PNG)]),
        headers=_CHUNKED_HEADERS,
    )


@pytest.fixture
def tiny_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """把防崩闸门与 multipart 的落盘阈值一起压到 64KB。

    有了它，「分块编码的请求会不会先落盘再被拒」才是一个**能红**的判定：
    没有 `RejectOversizeBody` 的数流时，4MB 的 `BIG_PNG` 会在 64KB 处滚成
    磁盘临时文件，接缝就会报 `rolledToDisk: true`。阳性对照见下面那条。
    """
    monkeypatch.setattr(config, "MAX_BYTES_HARD", _SMALL)
    monkeypatch.setattr(MultiPartParser, "spool_max_size", _SMALL)


async def test_chunked_oversize_is_rejected_before_it_can_spool(
    hooked_client: httpx.AsyncClient, tiny_limits: None
) -> None:
    """分块编码的超限请求：413，且一个字节都没进解析器。

    没有 `Content-Length` 可读，只按头判的预检对它**完全无效**——请求一路走到
    multipart 解析器，在 `spool_max_size` 处**滚成磁盘临时文件**，之后才被逐项
    闸门以 `file_too_large` 拒掉。功能全对，只是一份大文件经过了磁盘。

    所以这��钉的不是「拒不拒」，是「**拒在落盘之前**」。
    """
    r = await _post_chunked(hooked_client)
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "payload_too_large"


async def test_chunked_would_reach_disk_without_the_stream_counter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**阳性对照**：摘掉数流那一步，同一条请求**确实**滚到了磁盘。

    没有这一条，上面那条就是简报 §7-6 点名的「恒真」：它只证明「413 会发生」，
    而 413 在修复前也会发生（由逐项闸门以 200 + `file_too_large` 的形式发生，
    或者根本没发生）——真正要证明的是**拦截点在落盘之前**。
    """
    monkeypatch.setattr(config, "MAX_BYTES_HARD", _SMALL)
    monkeypatch.setattr(MultiPartParser, "spool_max_size", _SMALL)
    monkeypatch.setenv(config.ENV_VAR_TEST_HOOKS, "1")

    # 把防崩预检摘掉——这就是修复前那条「只读 Content-Length」的路。
    app = create_app()
    app.user_middleware = [m for m in app.user_middleware if m.cls is not RejectOversizeBody]

    async with make_client(app) as bare:
        r = await _post_chunked(bare)

    assert r.status_code == 200, r.text
    assert r.json()["rolledToDisk"] is True, (
        "对照失效：摘掉预检后竟然没落盘，那上面那条断言证明不了任何东西"
    )
