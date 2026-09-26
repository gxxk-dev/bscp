"""HTTP 表面：内容类型、挂载顺序、测试钩子的开关、区域恒等直通。

简报 §7-5 给的对策原文是「加一条集成测试『所有 API 错误都返回 JSON content-type』」。
它是简报 §2.1 那张文件表之外的一个文件——因为那三个「不许做的事」里，
没有一条能靠 `test_ingest.py` 顺带守住。
"""

from __future__ import annotations

from typing import Any

import io
from dataclasses import replace

import httpx
import pytest

from bscp import config
from bscp.api import cache_policy
from bscp.sessions import Crop, SessionStore
from tests.conftest import (
    BIG_PNG,
    FAKE_PDF,
    FIXTURE_A,
    make_client,
    named_part,
    new_session,
    part,
    post_drop,
)

UNKNOWN = "01ARZ3NDEKTSV4RRFFQ69G5FAV"


# ---------------------------------------------------------------- JSON 契约


async def test_unknown_api_path_is_json_not_html(client: httpx.AsyncClient) -> None:
    """/api/* 下的任何 404 都必须是 JSON。

    HTML 会让 `res.json()` 抛 `SyntaxError` —— spec 把那个白屏列为禁止状态。
    """
    for path in ("/api/nope", "/api/sessions/x/y/z", "/api/_test/reset"):
        r = await client.get(path)
        assert r.status_code == 404, path
        assert r.headers["content-type"].startswith("application/json"), path
        assert r.json()["error"]["code"] == "route_not_found", path


async def test_api_routes_are_registered_before_the_static_mount(
    client: httpx.AsyncClient,
) -> None:
    """阳性对照：`/api/*` 命中的是路由，不是 `StaticFiles`。

    挂载顺序写反的症状是这一条——`/api/healthz` 返回一张 HTML 404，
    页面全白，而**所有其它测试照样绿**。
    """
    r = await client.get("/api/healthz")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["status"] == "ok"


async def test_410_envelope_is_actionable(client: httpx.AsyncClient) -> None:
    """「会话没了」是操作者看得懂的明确错误（AC 第 18 条）。"""
    r = await client.get(f"/api/sessions/{UNKNOWN}")
    assert r.status_code == 410
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == "no-store"
    error = r.json()["error"]
    assert error["code"] == "session_unknown"
    # 三样东西：状态码、JSON、中文与一条出路。前端 `ErrorScreen` 靠它们。
    assert error["message"] and "服务端" in error["message"]
    assert error["detail"]
    assert error["remedy"] == "restart"
    assert error["retryable"] is False
    assert error["sessionId"] == UNKNOWN


async def test_expired_session_says_expired_not_unknown(
    hooked_client: httpx.AsyncClient,
) -> None:
    """两个不同的码、同一句可读的话、同一条出路——但**不能混成一个**。

    「见过但过期了」是 `session_expired`；「从没见过」是 `session_unknown`。
    那个钩子把 `last_seen` 拨到过去而不是删掉，就是为了能验到前者。
    """
    sid = await new_session(hooked_client)
    r = await hooked_client.post(f"/api/_test/expire?sessionId={sid}")
    assert r.status_code == 200 and r.json()["expired"] is True

    got = await hooked_client.get(f"/api/sessions/{sid}")
    assert got.status_code == 410
    assert got.json()["error"]["code"] == "session_expired"
    assert got.json()["error"]["remedy"] == "restart"

    # 阳性对照：一个真的从没见过的 id。
    never = await hooked_client.get(f"/api/sessions/{UNKNOWN}")
    assert never.json()["error"]["code"] == "session_unknown"
    assert never.status_code == 410


async def test_wrong_method_on_a_static_path_is_405_json(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """`/api/*` 下方法不对给的是 404（那条 JSON 兜底路由 catch 住了它），
    而静态资源上的方法不对给 405。两者都必须是 JSON。
    """
    from bscp.api import create_app

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html>")

    monkeypatch.setenv(config.ENV_VAR_STATIC_DIR, str(dist))
    async with make_client(create_app()) as c:
        r = await c.post("/index.html")
    assert r.status_code == 405
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "method_not_allowed"


async def test_wrong_method_under_api_is_404_not_405(client: httpx.AsyncClient) -> None:
    """记一笔：那条 JSON 兜底路由注册在最后、且接受所有方法，
    所以 `/api/*` 下「路径不存在 + 方法不对」统一是 404 而不是 405。

    这是有意的——**JSON 比状态码精确**更重要，而 405 在这里没有任何出路价值。
    """
    r = await client.delete("/api/healthz")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "route_not_found"


# ---------------------------------------------------------------- 测试钩子的开关


async def test_hooks_are_not_registered_when_the_flag_is_off(
    client: httpx.AsyncClient,
) -> None:
    """flag 关闭时路由**根本不注册**——不是注册了再拒绝。

    一个无鉴权的 `POST /api/_test/reset` 常驻在生产上就是「一键清空所有会话」的
    DoS 开关（简报 §2.1）。
    """
    assert config.test_hooks_enabled() is False
    for method, path in (
        ("POST", "/api/_test/reset"),
        ("POST", "/api/_test/expire?sessionId=x"),
        ("POST", "/api/_test/upload-probe"),
    ):
        r = await client.request(method, path, files=[part("a.png", FIXTURE_A)])
        assert r.status_code == 404, path
        assert r.json()["error"]["code"] == "route_not_found", path


async def test_hooks_reset_clears_every_session(hooked_client: httpx.AsyncClient) -> None:
    """阳性对照：flag 打开时它们**确实**在工作。"""
    assert config.test_hooks_enabled() is True
    for _ in range(3):
        await new_session(hooked_client)
    diag = (await hooked_client.get("/api/_test/diagnostics")).json()
    assert diag["sessions"] == 3
    assert diag["testHooks"] is True

    r = await hooked_client.post("/api/_test/reset")
    assert r.status_code == 200 and r.json()["cleared"] == 3
    assert (await hooked_client.get("/api/_test/diagnostics")).json()["sessions"] == 0


async def test_the_flag_is_read_when_the_app_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """开关读的是 **建 app 时**的环境，不是导入时的快照。

    于是同一个进程里可以有一个开着钩子的 app 和一个没开的，**互不可见**——
    走的还是 HTTP 断言，因为「路由有没有注册」这件事只有从外面看得见。
    """
    from bscp.api import create_app

    monkeypatch.delenv(config.ENV_VAR_TEST_HOOKS, raising=False)
    async with make_client(create_app()) as without:
        paths = (
            "/api/_test/reset",
            "/api/_test/expire?sessionId=x",
            "/api/_test/upload-probe",
        )
        for path in paths:
            r = await without.post(path, files=[part("a.png", FIXTURE_A)])
            assert r.status_code == 404, path

    monkeypatch.setenv(config.ENV_VAR_TEST_HOOKS, "1")
    async with make_client(create_app()) as with_hooks:
        r = await with_hooks.post("/api/_test/reset")
        assert r.status_code == 200 and r.json()["cleared"] == 0
        r = await with_hooks.post(
            "/api/_test/upload-probe", files=[named_part("file", "a.png", FIXTURE_A)]
        )
        assert r.status_code == 200 and r.json()["sha256"]


# ---------------------------------------------------------------- 区域位图


async def test_region_is_an_identity_pass_through(client: httpx.AsyncClient) -> None:
    """裁切框等于全页时直接返回原始字节——**一个字节都不解码**（ADR-0008）。

    逐字节相等是这条最强的形式：任何重编码都会改变它，而重编码就是「偷偷提高/降低
    分辨率」的第一步。
    """
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("扫描件.png", BIG_PNG)])
    item = body["items"][0]

    r = await client.get(item["region"]["bitmapUrl"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["x-bscp-crop-mode"] == "identity"
    assert r.headers["etag"] == f'"{item["artifactId"]}"'
    assert r.content == BIG_PNG
    assert r.content is not item  # 不是同一个对象，只是等值


async def test_region_url_uses_a_relative_path(client: httpx.AsyncClient) -> None:
    """客户端所有 API 路径写相对路径。不许出现指向 localhost:8000 的绝对 URL——
    那样 `StaticFiles` 托管（同源）就白做了（简报 §1.4）。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    url = body["items"][0]["region"]["bitmapUrl"]
    assert url.startswith("/api/")
    assert "://" not in url


async def test_region_of_unknown_artifact_is_410(client: httpx.AsyncClient) -> None:
    sid = await new_session(client)
    r = await client.get(f"/api/sessions/{sid}/artifacts/sha256:{'0' * 64}/regions/1")
    assert r.status_code == 410
    assert r.json()["error"]["code"] == "artifact_unknown"


async def test_region_of_unknown_region_is_410(client: httpx.AsyncClient) -> None:
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    aid = body["items"][0]["artifactId"]
    r = await client.get(f"/api/sessions/{sid}/artifacts/{aid}/regions/9999")
    assert r.status_code == 410
    assert r.json()["error"]["code"] == "region_unknown"
    assert r.json()["error"]["regionId"] == "9999"


async def test_a_real_crop_returns_a_decodable_image(
    client: httpx.AsyncClient,
) -> None:
    """非全页裁切那一支必须吐出**能被解码的图片**，不是裸像素。

    #4 里 `crop` 恒等于全页，所以这一支走不到——正因如此它曾经写成
    `im.crop(box).tobytes()`：那是未编码的原始 RGB 字节，却配上
    `page.media_type` 当 Content-Type 发出去。浏览器会收到一个 200、
    内容类型自相矛盾、又解不开的响应，而这恰恰是「区域永远是裁切位图」
    这条不变量守着的地方。#5 接多区域时就会踩到。

    这里手动把一个区域的 `crop` 改成非全页，让这一支真的被执行。
    """
    from PIL import Image as PILImage

    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    item = body["items"][0]

    session = client._transport.app.state.sessions.get(sid)  # type: ignore[union-attr]
    # `Region` 是 frozen 的，所以换掉表里那一条，而不是改它的字段。
    # 100×100 的 fixture 裁成中间 60×40，**不缩放**。
    idx = next(
        i for i, r in enumerate(session.regions) if r.artifact_id == item["artifactId"]
    )
    session.regions[idx] = replace(session.regions[idx], crop=Crop(20, 30, 60, 40))

    r = await client.get(item["region"]["bitmapUrl"])
    assert r.status_code == 200
    assert r.headers["x-bscp-crop-mode"] == "cropped"
    assert r.headers["content-type"] == "image/png"

    # Content-Type 说它是 PNG，它就**必须**是 PNG——否则前端 `<img>` 解不出来。
    with PILImage.open(io.BytesIO(r.content)) as im:
        assert im.format == "PNG"
        assert im.size == (60, 40)


async def test_artifact_metadata_never_returns_the_original_bytes(
    client: httpx.AsyncClient,
) -> None:
    """原件在登记时就被吸收进页位图，不另存（ADR-0014/0011）。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", BIG_PNG)])
    aid = body["items"][0]["artifactId"]
    r = await client.get(f"/api/sessions/{sid}/artifacts/{aid}")
    assert r.status_code == 200
    payload = r.json()
    assert payload["artifactId"] == aid
    assert payload["bytes"] == len(BIG_PNG)
    assert payload["pageCount"] == 1
    assert not any(isinstance(v, str) and len(v) > 200 for v in payload.values())


# ---------------------------------------------------------------- 会话生命周期


async def test_delete_then_touch_is_410(client: httpx.AsyncClient) -> None:
    """「用完就走」，之后一律 410。"""
    sid = await new_session(client)
    await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    assert (await client.delete(f"/api/sessions/{sid}")).status_code == 204
    r = await client.get(f"/api/sessions/{sid}")
    assert r.status_code == 410
    assert r.json()["error"]["code"] == "session_unknown"


async def test_open_page_does_not_burn_a_session(
    client_with_store: tuple[httpx.AsyncClient, SessionStore],
) -> None:
    """**懒建**：打开页面不建会话，第一次拖放/点选才建。"""
    client, store = client_with_store
    before = store.count()
    assert (await client.get("/api/healthz")).status_code == 200
    assert store.count() == before
    assert before == 0
    await new_session(client)
    assert store.count() == 1


async def test_healthz_reveals_nothing_but_liveness(client: httpx.AsyncClient) -> None:
    """`/api/healthz` 无鉴权，所以它只回 `status`。

    `testHooks` 等于告诉对方那个无鉴权的 `POST /api/_test/reset` 在哪儿；
    `bytesHeld` 是资源耗尽攻击的实时里程表；`env` 告诉他这是哪种部署形态。
    这三个键曾经都在这里。
    """
    body = (await client.get("/api/healthz")).json()
    assert body == {"status": "ok"}
    assert (await client.get("/api/_test/diagnostics")).status_code == 404


async def test_healthz_still_works_with_hooks_on(hooked_client: httpx.AsyncClient) -> None:
    """健康检查不能因为诊断信息搬走就坏掉——`e2e` 与部署探针都靠它。"""
    assert (await hooked_client.get("/api/healthz")).json() == {"status": "ok"}


# ---------------------------------------------------------------- 缓存头


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/index.html", "no-store"),
        ("/api/healthz", "no-store"),
        ("/api/sessions/x", "no-store"),
        ("/assets/index-D1vQ2ab.js", "public, max-age=31536000, immutable"),
        ("/vite.svg", "no-store"),
    ],
)
def test_cache_policy(path: str, expected: str) -> None:
    """**只有 `/assets/*` 允许被缓存。**

    课堂一体机的浏览器缓存横跨不同的课次：一个留着上一节课 `index.html` 的壳
    去打新版本的 `/api/*`，是最难复现的一类故障。
    """
    assert cache_policy(path) == expected


async def test_region_sets_its_own_cache_control(client: httpx.AsyncClient) -> None:
    """处理器自己设过的 `Cache-Control` 不被通用策略抹掉。

    阳性对照：`/api/*` 的默认是 `no-store`，区域位图是唯一显式豁免的那一个——
    因为它是不可变的，而且带着 `ETag`。
    """
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    r = await client.get(body["items"][0]["region"]["bitmapUrl"])
    assert r.headers["cache-control"] == "private, max-age=0, must-revalidate"

    r = await client.get(f"/api/sessions/{sid}")
    assert r.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------- 静态资源


async def test_missing_build_gives_503_not_html(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """`dist/` 是 gitignore 的，app 工厂不该在 import 时就炸；
    但真去取的时候要给一句**说得清**的话。"""
    from bscp.api import create_app

    monkeypatch.setenv(config.ENV_VAR_STATIC_DIR, str(tmp_path / "没有这个目录"))
    async with make_client(create_app()) as c:
        r = await c.get("/")
    assert r.status_code == 503
    assert r.headers["content-type"].startswith("application/json")
    error = r.json()["error"]
    assert error["code"] == "frontend_not_built"
    assert "bun run build" in error["hint"]


async def test_missing_build_does_not_leak_the_install_path(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """503 的响应体里**不许有绝对路径**。

    这条 503 无鉴权，而校园网上任何能连到端口的人 `curl /` 一下就能拿到
    部署目录、操作系统账号名与安装布局。路径进日志（`api.MissingBuild`），
    body 里只留目录名——`hint` 已经足够让人知道该做什么。
    """
    from bscp.api import create_app

    secret = tmp_path / "部署布局不许外泄"
    monkeypatch.setenv(config.ENV_VAR_STATIC_DIR, str(secret))
    async with make_client(create_app()) as c:
        r = await c.get("/")

    body = r.text
    assert r.status_code == 503
    assert str(secret) not in body, "响应体里出现了绝对路径"
    assert str(tmp_path) not in body, "响应体里出现了父目录"
    # 只留目录名：够认出「是哪一个 dist」，不够拼出部署布局。
    assert r.json()["error"]["directory"] == secret.name


async def test_root_serves_index_html_when_built(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """有产物时 `/` 落到 `index.html`，同源，测与部署是同一份字节。"""
    from bscp.api import create_app

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>bscp</title>")
    (dist / "assets" / "app-D1vQ2ab.js").write_text("console.log(1)")

    monkeypatch.setenv(config.ENV_VAR_STATIC_DIR, str(dist))
    async with make_client(create_app()) as c:
        r = await c.get("/")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")
        assert "bscp" in r.text
        assert r.headers["cache-control"] == "no-store"

        r = await c.get("/assets/app-D1vQ2ab.js")
        assert r.status_code == 200
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


# ---------------------------------------------------------------- 超大请求


async def test_oversize_body_is_rejected_before_it_is_parsed(client: httpx.AsyncClient) -> None:
    """`Content-Length` 预检跑在**读取请求体之前**。

    没有这一层，一个 200MB 的上传会先被 multipart 解析器滚到磁盘、再被 `ingest` 拒掉——
    「不落盘」就破了，而那件事从功能上看不出来。
    """
    sent = False

    class ExplodingStream(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[no-untyped-def]
            nonlocal sent
            sent = True
            yield b"x" * 1024

    r = await client.post(
        "/api/sessions",
        content=ExplodingStream(),
        headers={
            "content-type": "multipart/form-data; boundary=x",
            "content-length": str(config.MAX_BYTES_HARD * 4),
        },
    )
    assert r.status_code == 413
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "payload_too_large"
    assert r.json()["error"]["limit"] == config.MAX_BYTES_HARD
    assert sent is False, "预检应该发生在读请求体之前"


async def test_per_item_too_large_stays_200(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """逐项太大**不许**升级成批次级 4xx——那会吞掉同一批里其他文件的回执。"""
    monkeypatch.setattr(config, "MAX_FILE_BYTES", 4096)
    sid = await new_session(client)
    body = await post_drop(
        client, sid, [part("小.png", FIXTURE_A), part("大.png", BIG_PNG)]
    )
    assert [i["status"] for i in body["items"]] == ["accepted", "rejected"]
    assert body["items"][1]["code"] == "file_too_large"
    assert body["items"][1]["params"]["limit"] == 4096
    # 收下的那一份**真的**收下了，回执没被吞。
    assert body["items"][0]["artifactId"].startswith("sha256:")


# ---------------------------------------------------------------- 启动形态


def test_production_with_multiple_workers_refuses_to_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """多 worker 的故障是「健康检查正常、静态资源正常、随机 410」——最难查的一类。

    与其等随机 410，不如启动就拒绝。
    """
    from bscp.api import check_runtime

    monkeypatch.setenv(config.ENV_VAR_ENV, "production")
    monkeypatch.setenv(config.ENV_VAR_WORKERS, "4")
    with pytest.raises(RuntimeError, match="--workers 1"):
        check_runtime()


def test_single_worker_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    from bscp.api import check_runtime

    monkeypatch.setenv(config.ENV_VAR_ENV, "production")
    monkeypatch.setenv(config.ENV_VAR_WORKERS, "1")
    check_runtime()


def test_development_ignores_worker_count(monkeypatch: pytest.MonkeyPatch) -> None:
    from bscp.api import check_runtime

    monkeypatch.setenv(config.ENV_VAR_WORKERS, "8")
    check_runtime()


def test_worker_count_is_detected_without_the_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`BSCP_WORKERS` 不设时退回读父进程 argv。

    **只读 `WEB_CONCURRENCY` 是不够的**：uvicorn 0.54 实测**不**往子进程里写它
    （子进程里它是 `None`），那个守卫会安静地什么都不做——正是它本该拦住的那种故障。
    """
    from bscp.api import detect_workers

    monkeypatch.delenv(config.ENV_VAR_WORKERS, raising=False)
    monkeypatch.setenv("WEB_CONCURRENCY", "3")
    assert detect_workers() == 3  # 老启动器仍有效

    monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
    # 测不到就返回 None，**不猜**。守卫会退化成「靠 README 与测试」。
    assert detect_workers() in (1, None)


# ---------------------------------------------------------------- 端点清单


async def test_pdf_rejection_does_not_register_a_resource(client: httpx.AsyncClient) -> None:
    """#4 唯一挡 PDF 的码就是 `pdf_rasterizer_pending`；#5 删掉这一支。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("讲义.pdf", FAKE_PDF, "application/pdf")])
    assert body["items"][0]["code"] == "pdf_rasterizer_pending"
    assert (await client.get(f"/api/sessions/{sid}")).json()["artifacts"] == []


def test_app_state_has_a_fresh_store() -> None:
    """store 挂在 app state 上，不做模块级单例——测试要能造一个干净的 app。"""
    from bscp.api import create_app

    a, b = create_app(), create_app()
    assert a.state.sessions is not b.state.sessions
