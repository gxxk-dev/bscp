"""投放：闸门、流式哈希、逐项 verdict、内容哈希身份。

这些断言全部打**真实服务端**（`ASGITransport` 走完整 app），不是直接调
`ingest_one`。理由：挂载顺序、错误信封、`UploadFile` 的 spool 行为这些都只在
HTTP 路径上才存在，只测纯函数等于把最会坏的那一层排除在回归网之外。
"""

from __future__ import annotations

import hashlib
import io
import re
import zlib
from pathlib import Path

import httpx
import pytest
from PIL import Image

from bscp import config
from bscp.ingest import (
    CORRUPT_IMAGE,
    DOCX_NOT_SUPPORTED,
    EMPTY_FILE,
    NOT_IMAGE_OR_PDF,
    PDF_RASTERIZER_PENDING,
    PIXEL_COUNT_EXCEEDED,
    REJECT_CODES,
    SESSION_BUDGET_EXCEEDED,
)
from tests.conftest import (
    FAKE_DOCX,
    FAKE_PDF,
    FAKE_TXT,
    FIXTURE_A,
    FIXTURE_B,
    FIXTURE_C,
    new_session,
    part,
    png_bytes,
    post_drop,
)


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 闸门


@pytest.mark.parametrize(
    ("name", "data", "content_type", "code"),
    [
        ("试卷.docx", FAKE_DOCX, "application/octet-stream", DOCX_NOT_SUPPORTED),
        ("试卷.doc", FAKE_DOCX, "application/msword", DOCX_NOT_SUPPORTED),
        ("讲义.pdf", FAKE_PDF, "application/pdf", PDF_RASTERIZER_PENDING),
        ("讲义.PDF", FAKE_PDF, "application/pdf", PDF_RASTERIZER_PENDING),
        ("说明.txt", FAKE_TXT, "text/plain", NOT_IMAGE_OR_PDF),
        ("空.png", b"", "image/png", EMPTY_FILE),
        # 扩展名说了是 PNG、内容却不是 → corrupt_image，**不是** not_image_or_pdf：
        # 这两句给操作者的出路不一样。
        ("坏.png", b"not a png at all", "image/png", CORRUPT_IMAGE),
        # 截断的 PNG：头部有、像素数据不完整。verify() 在这里抛。
        ("截断.png", FIXTURE_A[: len(FIXTURE_A) // 2], "image/png", CORRUPT_IMAGE),
    ],
)
async def test_gate_rejects_with_a_precise_code(
    client: httpx.AsyncClient, name: str, data: bytes, content_type: str, code: str
) -> None:
    sid = await new_session(client)
    body = await post_drop(client, sid, [part(name, data, content_type)])
    (item,) = body["items"]
    assert item["status"] == "rejected"
    assert item["code"] == code
    assert code in REJECT_CODES
    # 被拒的文件**不变成任何东西**（AC 第 7 条）。
    state = (await client.get(f"/api/sessions/{sid}")).json()
    assert state["artifacts"] == []
    assert state["regions"] == []


async def test_pdf_disguised_without_extension_is_still_pdf(client: httpx.AsyncClient) -> None:
    """魔数认 PDF：拖拽完全绕过 `accept="image/*"`，闸门必须在处理器里。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("无扩展名", FAKE_PDF, "application/octet-stream")])
    assert body["items"][0]["code"] == PDF_RASTERIZER_PENDING


async def test_image_without_extension_is_still_accepted(client: httpx.AsyncClient) -> None:
    """反向：拖拽没有选择器可依赖。**内容说了算**，扩展名只是提示。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("无扩展名", FIXTURE_A, "image/png")])
    assert body["items"][0]["status"] == "accepted"


async def test_pixel_count_gate(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """#4 自带的防崩闸门。与 ADR-0019 的 30MB 闸门是**两条**。

    它之所以仍然是本项目自己的闸门、而不是靠 Pillow 自带的那道：Pillow 的
    检查在 `Image.open` **读尺寸时**就抛异常，而 `ingest_batch` 是列表推导，
    一个文件抛出去会让整批其它文件连回执都没有——那正是「端点恒 200」要防的。
    下面紧跟着的 `test_decompression_bomb_is_a_verdict_not_a_500` 就是那道断言。
    """
    monkeypatch.setattr(config, "MAX_PIXELS", 1000)
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("大.png", png_bytes(100, 100), "image/png")])
    (item,) = body["items"]
    assert item["code"] == PIXEL_COUNT_EXCEEDED
    assert item["params"]["limit"] == 1000
    assert item["params"]["width"] == 100
    assert item["params"]["height"] == 100
    assert item["params"]["pixels"] == 10000


def _png_declaring(width: int, height: int) -> bytes:
    """一颗**声明**了巨大尺寸的 PNG，只有几百字节。

    改真 PNG 的 IHDR 并**重算它的 CRC**：签名 8 字节 + 长度 4 + "IHDR" 4，
    宽高各 4 字节大端，接着 13 字节 IHDR 数据、再 4 字节 CRC（覆盖
    `"IHDR"` + 那 13 字节）。CRC 不对的话 `Image.open` 会先把它当坏文件，
    于是测到的是 `corrupt_image` 而不是我们要验的那条闸门。

    IDAT 里装的是原来那张 100×100 的图——`Image.open` 与 `verify()` 都不解码，
    所以只有 IHDR 里的那两个数会被读到。这正是「#4 刻意不解码」的现实后果：
    一颗 138 字节的文件就能声明 2 亿像素。
    """
    raw = bytearray(png_bytes(100, 100, seed=1))
    raw[16:20] = width.to_bytes(4, "big")
    raw[20:24] = height.to_bytes(4, "big")
    crc = zlib.crc32(bytes(raw[12:29])) & 0xFFFFFFFF
    raw[29:33] = crc.to_bytes(4, "big")
    return bytes(raw)


async def test_decompression_bomb_is_a_verdict_not_a_500(
    client: httpx.AsyncClient,
) -> None:
    """Pillow 的 bomb 阈值（≈179M px）之上必须是**逐项 verdict**，不是 500。

    `Image.open` 读头就会跑 `_decompression_bomb_check`，早于任何解码。`_probe_image`
    读头时把 `Image.MAX_IMAGE_PIXELS` 设成 `None`（我们不解码，关掉没有代价），
    把真实宽高取出来，判定交给本项目那道更严的 `MAX_PIXELS`。

    没有这一条时：一颗 200M px 的 PNG 让 `ingest_batch` 的列表推导抛出去，
    整批返回 500、同批其它文件的回执全部蒸发，客户端把它当「服务端崩了」，
    而重投必然再 500。
    """
    bomb = _png_declaring(20_000, 10_000)  # 200M px
    assert len(bomb) < 512, "闸门测试不该自己先撑爆内存"

    sid = await new_session(client)
    # 混着投：必须**只有**炸弹那份被拒，好图照拿回执（AC「一次回执逐个点名」）。
    body = await post_drop(
        client, sid, [part("炸弹.png", bomb), part("好图.png", FIXTURE_A)]
    )

    rejected, accepted = body["items"]
    assert rejected["code"] == PIXEL_COUNT_EXCEEDED
    assert rejected["params"]["width"] == 20_000
    assert rejected["params"]["height"] == 10_000
    assert rejected["params"]["pixels"] == 200_000_000
    assert rejected["params"]["limit"] == config.MAX_PIXELS
    assert accepted["status"] == "accepted"


async def test_bomb_does_not_poison_the_rest_of_the_batch(
    client: httpx.AsyncClient,
) -> None:
    """**顺序**也重要：炸弹排在前面，好图排在后面，回执一个都不能少。"""
    sid = await new_session(client)
    body = await post_drop(
        client,
        sid,
        [part("炸弹.png", _png_declaring(20_000, 10_000)), part("a.png", FIXTURE_A)],
    )
    assert [i["status"] for i in body["items"]] == ["rejected", "accepted"]
    assert body["items"][0]["code"] == PIXEL_COUNT_EXCEEDED


async def test_one_oversize_file_is_a_verdict_not_a_413(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单份超限走**逐项** `file_too_large`，不是整批 413。

    曾经 `MAX_FILE_BYTES == MAX_BYTES_HARD`，于是任何一份超限的文件都先把整批
    顶过 413 的预检线——那条批次级 4xx 会把同一批里其它文件的回执一起吞掉，
    恰好是这两条闸门存在的理由要避免的事。
    """
    assert config.MAX_BYTES_HARD > config.MAX_FILE_BYTES, (
        "整批硬闸门必须宽于逐项闸门，否则单份超限永远先撞 413"
    )
    monkeypatch.setattr(config, "MAX_FILE_BYTES", 1024)
    sid = await new_session(client)
    r = await client.post(
        f"/api/sessions/{sid}/artifacts",
        files=[part("太大.png", b"\x89PNG" + b"0" * 4096)],
    )
    assert r.status_code == 200, r.text
    (item,) = r.json()["items"]
    assert item["code"] == "file_too_large"
    assert item["params"]["limit"] == 1024


async def test_session_byte_budget_rejects_only_the_overflowing_item(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单会话内存预算：超了给**逐项** verdict，同批其它文件照收。

    每次投放都 `touch()` 续期，所以「一直投」原本等于「一直涨且永不过期」。
    一体机通常只有 8GB，而 `POST /api/sessions` 无鉴权。
    """
    monkeypatch.setattr(config, "SESSION_BYTES_BUDGET", len(FIXTURE_A) + len(FIXTURE_B) // 2)
    sid = await new_session(client)
    body = await post_drop(
        client, sid, [part("第一份.png", FIXTURE_A), part("第二份.png", FIXTURE_B)]
    )
    first, second = body["items"]
    assert first["status"] == "accepted"
    assert second["code"] == SESSION_BUDGET_EXCEEDED
    assert second["params"]["limit"] == config.SESSION_BYTES_BUDGET
    assert second["params"]["held"] == len(FIXTURE_A)


async def test_budget_rejection_keeps_the_endpoint_at_200(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """预算是闸门不是异常：整批恒 200，一条回执不少。"""
    monkeypatch.setattr(config, "SESSION_BYTES_BUDGET", 1)
    sid = await new_session(client)
    r = await client.post(
        f"/api/sessions/{sid}/artifacts",
        files=[part("a.png", FIXTURE_A), part("b.png", FIXTURE_B)],
    )
    assert r.status_code == 200
    assert [i["code"] for i in r.json()["items"]] == [
        SESSION_BUDGET_EXCEEDED,
        SESSION_BUDGET_EXCEEDED,
    ]


# ---------------------------------------------------------------- 逐项 verdict


async def test_mixed_batch_is_always_200_and_names_every_item(client: httpx.AsyncClient) -> None:
    """混着收与拒**恒 200**，逐项点名，每项带文件名与体积（AC 第 6 条）。"""
    sid = await new_session(client)
    parts = [
        part("第一张.png", FIXTURE_A),
        part("讲义.pdf", FAKE_PDF, "application/pdf"),
        part("第二张.png", FIXTURE_B),
        part("作文.docx", FAKE_DOCX, "application/octet-stream"),
    ]
    body = await post_drop(client, sid, parts, client_keys=["k0", "k1", "k2", "k3"])

    items = body["items"]
    assert [i["clientKey"] for i in items] == ["k0", "k1", "k2", "k3"]
    assert [i["status"] for i in items] == [
        "accepted",
        "rejected",
        "accepted",
        "rejected",
    ]
    # 每一项都带自己的体积。**逐项**给，不是只给收下那批的合计。
    assert [i["bytes"] for i in items] == [
        len(FIXTURE_A),
        len(FAKE_PDF),
        len(FIXTURE_B),
        len(FAKE_DOCX),
    ]
    # 被拒的也要说得出是哪一份、多大。
    assert items[1]["params"]["filename"] == "讲义.pdf"
    assert items[3]["params"]["filename"] == "作文.docx"
    assert body["expiresAt"].endswith("Z")


async def test_item_order_matches_request_order(client: httpx.AsyncClient) -> None:
    """同名文件是合法的——顺序 + clientKey 是把它对回自己那一个 `File` 的唯一办法。"""
    sid = await new_session(client)
    parts = [part("同名.png", d) for d in (FIXTURE_A, FIXTURE_B, FIXTURE_C)]
    body = await post_drop(client, sid, parts, client_keys=["第一份", "第二份", "第三份"])
    assert [i["clientKey"] for i in body["items"]] == ["第一份", "第二份", "第三份"]
    # 三份不同字节 = 三个不同的 artifactId。**必须先造三份不同字节的 fixture**：
    # 投同一个假 PDF 两次，按内容哈希去重之后就只剩 1 块，断言全部变成空过。
    assert len({i["artifactId"] for i in body["items"]}) == 3


async def test_client_keys_fall_back_to_index_when_absent(client: httpx.AsyncClient) -> None:
    """不带 `clientKeys` 时退回下标。这是降级，不是拒绝——端点恒 200。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("a.png", FIXTURE_A), part("b.png", FIXTURE_B)])
    assert [i["clientKey"] for i in body["items"]] == ["0", "1"]


async def test_client_keys_length_mismatch_falls_back_to_index(client: httpx.AsyncClient) -> None:
    sid = await new_session(client)
    body = await post_drop(
        client, sid, [part("a.png", FIXTURE_A), part("b.png", FIXTURE_B)], client_keys=["只有一个"]
    )
    assert [i["clientKey"] for i in body["items"]] == ["0", "1"]


# ---------------------------------------------------------------- 内容哈希身份


async def test_same_bytes_under_two_names_dedupes(client: httpx.AsyncClient) -> None:
    """同内容 = 同一份资源，不管叫什么（ADR-0015）。"""
    sid = await new_session(client)
    first = await post_drop(client, sid, [part("卷子.png", FIXTURE_A)])
    second = await post_drop(client, sid, [part("卷子(1).png", FIXTURE_A)])

    assert first["items"][0]["alreadyPresent"] is False
    assert second["items"][0]["alreadyPresent"] is True
    assert second["items"][0]["artifactId"] == first["items"][0]["artifactId"] == sha(FIXTURE_A)

    state = (await client.get(f"/api/sessions/{sid}")).json()
    assert len(state["artifacts"]) == 1
    # 零新增区域。
    assert len(state["regions"]) == 1


async def test_first_registered_name_is_never_overwritten(client: httpx.AsyncClient) -> None:
    """`displayName` 只在**首次登记**时写入。"""
    sid = await new_session(client)
    await post_drop(client, sid, [part("第一次.pdf.png", FIXTURE_A)])
    second = await post_drop(client, sid, [part("第二次.pdf.png", FIXTURE_A)])
    assert second["items"][0]["displayName"] == "第一次.pdf.png"
    state = (await client.get(f"/api/sessions/{sid}")).json()
    assert state["artifacts"][0]["displayName"] == "第一次.pdf.png"
    assert state["regions"][0]["displayName"] == "第一次.pdf.png"


async def test_already_present_adds_nothing_at_all(client: httpx.AsyncClient) -> None:
    """`alreadyPresent` ⇒ 不新增资源、不新增区域、**不移动**。"""
    sid = await new_session(client)
    await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    before = (await client.get(f"/api/sessions/{sid}")).json()
    assert len(before["regions"]) == 1

    again = await post_drop(client, sid, [part("a-again.png", FIXTURE_A)])
    after = (await client.get(f"/api/sessions/{sid}")).json()
    assert again["items"][0]["alreadyPresent"] is True
    assert after["artifacts"] == before["artifacts"]
    assert after["regions"] == before["regions"]


async def test_same_name_different_bytes_becomes_two(client: httpx.AsyncClient) -> None:
    """同名不同内容 = 两份。文件名不参与任何相等判断。"""
    sid = await new_session(client)
    await post_drop(client, sid, [part("同名.png", FIXTURE_A)])
    await post_drop(client, sid, [part("同名.png", FIXTURE_B)])

    state = (await client.get(f"/api/sessions/{sid}")).json()
    assert len(state["artifacts"]) == 2
    assert len(state["regions"]) == 2
    assert {a["displayName"] for a in state["artifacts"]} == {"同名.png"}


async def test_region_ids_are_globally_unique_and_content_derived(
    client: httpx.AsyncClient,
) -> None:
    """区域 id = `${artifactId}#${regionId}`。

    绝不能用「第几次投放的第几份」——第二次投放会撞出第二个 `a1`，`key` 重复、
    React 静默复用或丢块、`[data-id="a1"]` 一次选中两个元素（简报 §7-2）。
    """
    sid = await new_session(client)
    await post_drop(client, sid, [part("a.png", FIXTURE_A)])
    await post_drop(client, sid, [part("b.png", FIXTURE_B)])
    state = (await client.get(f"/api/sessions/{sid}")).json()

    ids = [r["id"] for r in state["regions"]]
    assert len(ids) == len(set(ids)) == 2
    for region in state["regions"]:
        assert region["id"] == f"{region['artifactId']}#1"
    assert FIXTURE_A != FIXTURE_B


# ---------------------------------------------------------------- 回执形状


async def test_accepted_item_shape(client: httpx.AsyncClient) -> None:
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("扫描件.png", FIXTURE_B)])
    (item,) = body["items"]

    assert set(item) == {
        "clientKey",
        "status",
        "artifactId",
        "displayName",
        "bytes",
        "pageCount",
        "alreadyPresent",
        "region",
    }
    assert item["bytes"] == len(FIXTURE_B)
    assert item["pageCount"] == 1
    region = item["region"]
    with Image.open(io.BytesIO(FIXTURE_B)) as im:
        assert (im.width, im.height) == (140, 90)
    assert region["pixel"] == {"w": 140, "h": 90}
    # #4 的区域 = 整张图，裁切框恒等于全页。
    assert region["crop"] == {"x": 0, "y": 0, "w": 140, "h": 90}
    assert region["page"] == 1
    assert region["bitmapUrl"] == f"/api/sessions/{sid}/artifacts/{item['artifactId']}/regions/1"
    # `pixel` 是像素、`bytes` 是字节。**同名不同义**，别复用字段名。
    assert region["pixel"] != {"bytes": item["bytes"]}


async def test_server_does_not_resize(client: httpx.AsyncClient) -> None:
    """服务端**不做任何缩放**，`pixel` 恒为原图自然尺寸（小图不放大，ADR-0008）。"""
    sid = await new_session(client)
    body = await post_drop(client, sid, [part("小图.png", png_bytes(17, 23), "image/png")])
    assert body["items"][0]["region"]["pixel"] == {"w": 17, "h": 23}


# ---------------------------------------------------------------- 归属与 410


async def test_drop_into_unknown_session_is_410(client: httpx.AsyncClient) -> None:
    """投放也要 410，不是 404。"""
    r = await client.post(
        "/api/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV/artifacts",
        files=[part("a.png", FIXTURE_A)],
    )
    assert r.status_code == 410
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "session_unknown"
    assert r.headers["cache-control"] == "no-store"


async def test_drop_without_files_is_400_not_html(client: httpx.AsyncClient) -> None:
    sid = await new_session(client)
    r = await client.post(f"/api/sessions/{sid}/artifacts")
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "bad_request"


# ------------------------------------------------- 客户端与服务端的表不许分家

_FRONTEND = Path(__file__).resolve().parent.parent.parent / "prototype" / "src"


def _read_frontend(name: str) -> str:
    path = _FRONTEND / name
    if not path.is_file():
        pytest.skip(f"找不到前端源码 {path}（只装了 server/ 时跳过）")
    return path.read_text(encoding="utf-8")


def test_client_and_server_agree_on_the_extension_gate() -> None:
    """`ingest.ts` 的 `DOCX_EXT` 与 `ingest.py` 的 `_EXT_GATES` 必须是同一批扩展名。

    两边各有一句注释说「改这张表时同步改那张表」。**注释不是回归网**：给服务端
    `_EXT_GATES` 加一个 `.pages`（或者从 `DOCX_EXT` 里删掉 `.wps`），全部测试
    照绿、构建照绿、e2e 照绿——e2e 的 fixture 只有 `.docx`/`.pdf`/`.png` 三种
    名字，两张表在这些输入上恰好给出同一批码，差集永远碰不到。

    真正的分歧要等真机上有人拖一个 `.wps` 或 `.pages` 进来才炸，那时拖拽路径说
    「首版不收 Word」而选择器/服务端说「不是图片也不是 PDF」——正是本仓反复点名
    要治的「同一个问题两个答案」。
    """
    py_source = Path(__file__).resolve().parent.parent / "bscp" / "ingest.py"
    py = re.search(r"_EXT_GATES = \{(.*?)\n\}", py_source.read_text(encoding="utf-8"), re.S)
    assert py, "服务端 `_EXT_GATES` 的形状变了，这条断言得跟着改"
    server_exts = set(re.findall(r'"(\.[a-z0-9]+)"\s*:', py.group(1)))
    assert server_exts, "服务端扩展名表解析成了空集——正则该跟代码一起改"

    ts = _read_frontend("ingest.ts")
    m = re.search(r"DOCX_EXT = /\\\.\(([^)]*)\)\$/i", ts)
    assert m, "客户端 `DOCX_EXT` 的形状变了，这条断言得跟着改"
    client_exts: set[str] = set()
    for piece in m.group(1).split("|"):
        # `docx?` 里可选的是**紧挨 `?` 的那个字母**。去掉它与不去掉都收进来，
        # 于是 `.doc` 与 `.docx` 两侧都能对上。
        if "?" in piece:
            head = piece.split("?")[0]
            client_exts.add(f".{head[:-1]}")
            client_exts.add(f".{head}")
        else:
            client_exts.add(f".{piece}")
    assert client_exts, "客户端扩展名表解析成了空集——正则该跟代码一起改"

    assert client_exts == server_exts, (
        "客户端与服务端的 Word 扩展名表分家了："
        f"只有客户端有 {sorted(client_exts - server_exts)}，"
        f"只有服务端有 {sorted(server_exts - client_exts)}"
    )


def test_client_knows_every_reject_code_the_server_can_emit() -> None:
    """`messages.REJECT_CODES` 必须**逐项**等于服务端的 `REJECT_CODES`。

    服务端加一个码而前端没跟上时，`rejectCopy` 会退到 UNKNOWN 那一支，操作者
    读到的是「没投上（服务端没给理由）」——一句正确但无用的话，而所有测试仍然绿。
    """
    ts = _read_frontend("messages.ts")
    listed = re.search(r"REJECT_CODES = \[(.*?)\]", ts, re.S)
    assert listed, "客户端 `REJECT_CODES` 的形状变了，这条断言得跟着改"
    client_codes = set(re.findall(r'"([a-z0-9_]+)"', listed.group(1)))
    assert client_codes, "客户端拒收码表解析成了空集——正则该跟代码一起改"

    assert client_codes == set(REJECT_CODES), (
        "拒收码表分家了："
        f"只有服务端有 {sorted(set(REJECT_CODES) - client_codes)}，"
        f"只有客户端有 {sorted(client_codes - set(REJECT_CODES))}"
    )


def test_every_reject_code_has_real_client_copy() -> None:
    """每个码都得有**真的话术**，不能落到 UNKNOWN。

    `REJECT_CODES` 里有码而 `COPY` 里没有，就是操作者会读到「没投上（服务端没给
    理由）」的那一类——那句话正确、无用，而且没有任何断言会响。
    """
    ts = _read_frontend("messages.ts")
    block = re.search(r"const COPY: Record<.*?> = \{(.*?)\n\};", ts, re.S)
    assert block, "客户端 `COPY` 的形状变了，这条断言得跟着改"
    implemented = set(re.findall(r"^  ([a-z0-9_]+):", block.group(1), re.M))
    assert implemented, "客户端话术表解析成了空集——正则该跟代码一起改"

    missing = set(REJECT_CODES) - implemented
    assert not missing, f"这些拒收码没有话术，会退到 UNKNOWN：{sorted(missing)}"
