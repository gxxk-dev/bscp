"""投放：闸门 + 流式 SHA-256 + 尺寸探测 + 逐项 verdict。

**这个投放端点恒 200。** 混着收与拒必须靠「200 + 逐项 verdict」表达：
批次级 4xx 会吞掉部分回执，恰好毁掉 AC「一次回执逐个点名」。

## Pillow 在这里只碰两处

`Image.open`（读头部拿像素尺寸与格式）与 `im.verify()`（验完整性）。
**不解码、不裁切、不缩放、不重编码。** 图片的「页位图」就是收到的原始字节——
所以 `regions.py` 的恒等直通是真正的零解码，一个字节都不动（ADR-0008）。

## 为什么读头部时要临时关掉 Pillow 的 bomb 检查

Pillow 的 decompression-bomb 保护**在 `Image.open` 读尺寸时就会跑**
（`PIL/Image.py` 的 `_decompression_bomb_check`，位置在任何解码之前），
超过 `2 * MAX_IMAGE_PIXELS`（≈179M px）时抛 `DecompressionBombError`。

那条保护对本项目是**错的形状**：它抛异常，而 `ingest_batch` 是列表推导，
一个文件抛出去会让**整批**其它文件连回执都没有——恰好是「端点恒 200 +
一次回执逐个点名」要防的事。实测一颗 200M px 的 PNG 会得到 500 而不是一条
`pixel_count_exceeded`。

所以 [`_probe_image`] 读尺寸时把 `Image.MAX_IMAGE_PIXELS` 设成 `None`，
把真实宽高取出来，判定交给 [`config.MAX_PIXELS`]（40M，比 Pillow 那道严格
得多）——它在下游本来就有，产出的是一条带宽高、可操作的逐项 verdict。
我们**不解码**，所以关掉它没有任何代价。

## 换 PyMuPDF 只碰这个文件

#5 把 PDF 变成真路径时，`pdf_rasterizer_pending` 这一支删掉、多页展开与页数闸门
在这里加。`regions.py` 换成 `Image.crop()` + 编码，前端契约一动不动。
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError

from . import config
from .sessions import Artifact, Page, Region, Session, Size, bitmap_url, full_page_crop

log = logging.getLogger("bscp.ingest")

#: 哈希的读块大小。「不要整读进内存再 hash」：这块大小就是内存的抖动上限。
CHUNK_BYTES = 64 * 1024

#: 嗅探用：够认出 PDF 就行。
SNIFF_BYTES = 5

# ---------------------------------------------------------------- 拒收码

DOCX_NOT_SUPPORTED = "docx_not_supported"
NOT_IMAGE_OR_PDF = "not_image_or_pdf"
PDF_RASTERIZER_PENDING = "pdf_rasterizer_pending"
PIXEL_COUNT_EXCEEDED = "pixel_count_exceeded"
EMPTY_FILE = "empty_file"
CORRUPT_IMAGE = "corrupt_image"
FILE_TOO_LARGE = "file_too_large"
SESSION_BUDGET_EXCEEDED = "session_budget_exceeded"

#: 全部拒收码。前端 `messages.ts` 按这张表出话术。
REJECT_CODES = (
    DOCX_NOT_SUPPORTED,
    NOT_IMAGE_OR_PDF,
    PDF_RASTERIZER_PENDING,
    PIXEL_COUNT_EXCEEDED,
    EMPTY_FILE,
    CORRUPT_IMAGE,
    FILE_TOO_LARGE,
    SESSION_BUDGET_EXCEEDED,
)

#: 扩展名 → 拒收码。**扩展名优先于内容嗅探**，因为 DOCX 是个 ZIP 容器：
#: Pillow 打不开它，于是纯靠内容判会得到 `corrupt_image`——那是句错误的话，
#: 而操作者需要听到的是「首版不收 Word、另存为 PDF 再投」（ADR-0009 的负面路径）。
_EXT_GATES = {
    ".doc": DOCX_NOT_SUPPORTED,
    ".docx": DOCX_NOT_SUPPORTED,
    ".rtf": DOCX_NOT_SUPPORTED,
    ".wps": DOCX_NOT_SUPPORTED,
    ".odt": DOCX_NOT_SUPPORTED,
}

#: 认得出的图片扩展名。**不是闸门**，只用来把「扩展名说了是图片、但 Pillow 打不开」
#: 判成 `corrupt_image` 而不是 `not_image_or_pdf`——这两句给操作者的出路不一样。
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".avif"}

#: 图片格式 → Content-Type。Pillow 报的是格式名，这里翻成媒体类型。
_MEDIA_TYPES = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "GIF": "image/gif",
    "BMP": "image/bmp",
    "WEBP": "image/webp",
    "TIFF": "image/tiff",
    "AVIF": "image/avif",
}


@dataclass(frozen=True, slots=True)
class _Streamed:
    """一次流式读取的结果。

    `data` 在已判定拒收、或已越过体积闸门时是 `None`——白读进内存的东西不留。
    `overflow` 表示中途撞上了 `MAX_BYTES_HARD`；此时仍然把请求体**读干净**，
    否则连接会留下未消费的字节。
    """

    sha256: str
    size: int
    data: bytes | None
    head: bytes
    overflow: bool


async def _stream_digest(upload: UploadFile, *, keep: bool) -> _Streamed:
    """**流式**算 SHA-256，绝不先整读进内存再 hash。

    `keep=False` 时只留哈希与字节数，字节本身丢掉——已经按扩展名拒收的文件
    没有理由占着内存。越过 `MAX_BYTES_HARD` 之后同样只留计数，不留字节。
    """
    digest = hashlib.sha256()
    chunks: list[bytes] | None = [] if keep else None
    head = b""
    size = 0
    overflow = False
    while True:
        chunk = await upload.read(CHUNK_BYTES)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
        if len(head) < SNIFF_BYTES:
            head += chunk[: SNIFF_BYTES - len(head)]
        if chunks is not None:
            if overflow or size > config.MAX_FILE_BYTES:
                # 越界了：从这一刻起只读不存，内存到此为止。
                overflow = True
                chunks = None
            else:
                chunks.append(chunk)
    return _Streamed(
        sha256=digest.hexdigest(),
        size=size,
        data=b"".join(chunks) if chunks is not None else None,
        head=head,
        overflow=overflow,
    )


@contextlib.contextmanager
def _read_header_without_bomb_check() -> Iterator[None]:
    """读图片头部期间临时关掉 Pillow 自己的 bomb 检查。

    它拦的是**头部**而不是解码（本项目刻意不解码），阈值 179M px 比我们要的
    40M 宽得多，而且抛出的是异常——落到 `ingest_batch` 的列表推导里会掀掉整批
    回执。关掉它只是为了把真实宽高取出来，判定仍然由 [`config.MAX_PIXELS`] 做。

    没有 await，所以不存在让别的任务看见这个中间态的窗口。
    """
    saved = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        yield
    finally:
        Image.MAX_IMAGE_PIXELS = saved


def _probe_image(data: bytes) -> tuple[Size, str] | None:
    """`Image.open` 读头部 + `im.verify()` 验完整性。**不解码像素。**

    返回 `(像素尺寸, Content-Type)`；Pillow 打不开或文件被截断时返回 `None`。
    像素数**不在这里判**——那道闸门在 `ingest_one`，它需要 `filename` 才能出话术。
    """
    try:
        with (
            _read_header_without_bomb_check(),
            Image.open(io.BytesIO(data)) as im,
        ):
            width, height = im.size
            fmt = (im.format or "").upper()
            # verify() 会读遍整个文件流，但**不解码**；截断的图片在这里抛。
            im.verify()
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        # 上面已经把 bomb 检查关掉了，这两个正常走不到。留着是为了「万一哪天
        # Pillow 换了实现」时不至于变成一条 500——`ingest_one` 的 docstring
        # 承诺的是「闸门的答案是数据，不是异常」。
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        return None
    return Size(width, height), _MEDIA_TYPES.get(fmt, f"image/{fmt.lower() or 'unknown'}")


def _reject(code: str, client_key: str, size: int, **params: Any) -> dict[str, Any]:
    return {
        "clientKey": client_key,
        "status": "rejected",
        "code": code,
        "params": {str(k): v for k, v in params.items()},
        "bytes": size,
    }


def _accepted(
    session: Session,
    client_key: str,
    *,
    filename: str,
    size: int,
    sha256: str,
    pixel: Size,
    media_type: str,
    data: bytes,
) -> dict[str, Any]:
    """登记（或命中已有）一份资源，并回一条 accepted verdict。

    **身份是内容哈希**（ADR-0015）：
    - 同 hash 换名重投 → `alreadyPresent=true`，**不新增资源、不新增区域、不移动**
    - 同名不同内容 → 落成两份（名字只是显示属性，不参与相等判断）
    - `displayName` 只在**首次登记**时写入，之后永不覆盖
    """
    artifact_id = f"sha256:{sha256}"
    existing = session.artifacts.get(artifact_id)
    if existing is not None:
        region = session.find_region(artifact_id, "1")
        if region is None:  # pragma: no cover - 资源与区域同生共死，这里只是不假设
            log.warning("资源 %s 存在但没有区域 #1，就地补上", artifact_id)
            existing.pages.append(Page(index=1, pixel=pixel, data=data, media_type=media_type))
            region = Region("1", artifact_id, 1, full_page_crop(pixel), pixel)
            existing.region_seq = 1
            session.regions.append(region)
        return _accepted_item(
            session.id, client_key, existing, region, already_present=True
        )

    artifact = Artifact(
        artifact_id=artifact_id,
        display_name=filename,
        byte_length=size,
        pages=[Page(index=1, pixel=pixel, data=data, media_type=media_type)],
    )
    region = Region(artifact.next_region_id(), artifact_id, 1, full_page_crop(pixel), pixel)
    session.artifacts[artifact_id] = artifact
    session.regions.append(region)
    return _accepted_item(session.id, client_key, artifact, region, already_present=False)


def _accepted_item(
    session_id: str,
    client_key: str,
    artifact: Artifact,
    region: Region,
    *,
    already_present: bool,
) -> dict[str, Any]:
    return {
        "clientKey": client_key,
        "status": "accepted",
        "artifactId": artifact.artifact_id,
        # 首次登记时的名字。命中已有资源时**回既有名字**，不回这次的——
        # 「角标上显示的是该资源首次登记时的文件名」（ADR-0015）。
        "displayName": artifact.display_name,
        "bytes": artifact.byte_length,
        "pageCount": config.PAGES_PER_ARTIFACT,
        "alreadyPresent": already_present,
        "region": {
            "id": region.id,
            "page": region.page,
            "crop": region.crop.as_dict(),
            "pixel": region.pixel.as_dict(),
            "bitmapUrl": bitmap_url(session_id, artifact.artifact_id, region.region_id),
        },
    }


async def ingest_one(session: Session, upload: UploadFile, client_key: str) -> dict[str, Any]:
    """处理一个上传件，产出**一条** verdict。永不抛错——闸门的答案是数据，不是异常。"""
    filename = (upload.filename or "").strip()
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""

    # 1) 扩展名闸门。DOCX/PDF 在 #4 一律拒，且**不读内容**——省内存也省时间。
    if ext in _EXT_GATES:
        return _reject(_EXT_GATES[ext], client_key, upload.size or 0, filename=filename)
    if ext == ".pdf":
        # #4 唯一挡 PDF 的码。**#5 删掉这一支**，它是 #5 存在的最后一块拼图。
        return _reject(PDF_RASTERIZER_PENDING, client_key, upload.size or 0, filename=filename)

    # 2) 流式哈希。字节留在内存里——页位图不落盘（ADR-0014），
    #    所以「读完就扔」在这里做不到，只能用内存换磁盘。
    streamed = await _stream_digest(upload, keep=True)

    # 3) 逐项 verdict。顺序有意义：先说「太大/空」，再问是不是 PDF，最后才问 Pillow。
    if streamed.overflow:
        # 逐项拒，而不是给整批一个 413：批次级 4xx 会吞掉同一批里其他文件的回执。
        return _reject(
            FILE_TOO_LARGE,
            client_key,
            streamed.size,
            filename=filename,
            limit=config.MAX_FILE_BYTES,
        )
    if streamed.size == 0:
        return _reject(EMPTY_FILE, client_key, 0, filename=filename)

    data = streamed.data or b""
    if data[:5] == b"%PDF-" or streamed.head == b"%PDF-":
        return _reject(PDF_RASTERIZER_PENDING, client_key, streamed.size, filename=filename)

    probed = _probe_image(data)
    if probed is None:
        code = CORRUPT_IMAGE if ext in _IMAGE_EXTS else NOT_IMAGE_OR_PDF
        return _reject(code, client_key, streamed.size, filename=filename)
    pixel, media_type = probed

    # 4) 防崩闸门。与 ADR-0019 的 30MB 闸门是**两条**，别混。
    if pixel.area > config.MAX_PIXELS:
        return _reject(
            PIXEL_COUNT_EXCEEDED,
            client_key,
            streamed.size,
            filename=filename,
            width=pixel.w,
            height=pixel.h,
            pixels=pixel.area,
            limit=config.MAX_PIXELS,
        )

    # 5) 会话内存预算。**在登记之前**判：超了给一条逐项 verdict，
    #    同一批里其它文件照拿回执——抛异常会掀掉整批（与投放端点恒 200 冲突）。
    #    每次投放都会续期，所以「一直投」原本等于「一直涨且永不过期」。
    held = session.bytes_held()
    if held + streamed.size > config.SESSION_BYTES_BUDGET:
        return _reject(
            SESSION_BUDGET_EXCEEDED,
            client_key,
            streamed.size,
            filename=filename,
            limit=config.SESSION_BYTES_BUDGET,
            held=held,
        )

    # 6) 登记。解析中豁免 TTL（ADR-0014），虽然图片这条短路径几乎不占时间。
    with session.pin():
        return _accepted(
            session,
            client_key,
            filename=filename or "未命名",
            size=streamed.size,
            sha256=streamed.sha256,
            pixel=pixel,
            media_type=media_type,
            data=data,
        )


async def ingest_batch(
    session: Session, uploads: list[tuple[str, UploadFile]]
) -> dict[str, Any]:
    """一次投放的整批回执。

    `items` 顺序**与请求里的文件顺序一致**；每项带 `clientKey`（客户端生成），
    所以同名文件是合法的——只有 clientKey 能把回执对回自己那一个 `File`。
    """
    items = [await ingest_one(session, upload, key) for key, upload in uploads]
    return {"items": items, "expiresAt": session.expires_at()}


__all__ = [
    "CORRUPT_IMAGE",
    "DOCX_NOT_SUPPORTED",
    "EMPTY_FILE",
    "FILE_TOO_LARGE",
    "NOT_IMAGE_OR_PDF",
    "PDF_RASTERIZER_PENDING",
    "PIXEL_COUNT_EXCEEDED",
    "REJECT_CODES",
    "SESSION_BUDGET_EXCEEDED",
    "ingest_batch",
    "ingest_one",
]
