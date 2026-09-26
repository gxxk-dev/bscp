"""区域位图端点。

#4 是**恒等直通**：`crop` 等于全页时直接 `return page.data`，
**一个字节都不解码**（ADR-0008：区域永远是裁切位图，#4 里就是整页位图本身）。

#5 需要把下面 `_crop` 的裁切那一支接上。**接的时候注意它现在已经是正确写法**：
`Image.crop()` 给你的是原始像素，**不是任何图片格式**——早先这里写的是
`im.crop(box).tobytes()`，那会把裸 RGB 字节配上 `image/png` 的 Content-Type
发出去，浏览器收到一个 200、内容类型自相矛盾、又解不开的响应。正因为那一支在
#4 里走不到，这个错不会被任何测试照到，所以现在它被 `tests/test_api.py` 用一个
真的非全页 crop 覆盖住。

前端契约不动：回执里 `crop` 早就带上真实裁切框了，客户端渲染 `bitmapUrl` 时
根本不知道服务端有没有真的裁过。
"""

from __future__ import annotations

import io

from fastapi import APIRouter, Depends, Response
from PIL import Image

from .errors import ApiError
from .sessions import Artifact, Page, Region, SessionStore, get_store, is_full_page

router = APIRouter(prefix="/api/sessions/{session_id}/artifacts", tags=["regions"])

#: 恒等直通时用的缓存策略。`/api/*` 一律 `no-store`（`api.py` 的中间件），
#: `ETag` 留着是给 #13 的 service worker 判断「同一份资源没变过」用的——
#: 它**不是**给浏览器缓存用的，投屏期的前端已经把位图物化成 blob 了（简报 §7-12）。
_IMMUTABLE = "private, max-age=0, must-revalidate"

#: 裁切那一支统一重新编码成这个格式。**不能沿用 `page.media_type`**：
#: 解码一张 JPEG 再编码成 JPEG 出来的字节是另一张图，而 `#4` 承诺的
#: 「区域永远是裁切位图」对格式没有要求，对「能不能显示」有。
_CROP_FORMAT = "PNG"
_CROP_MEDIA_TYPE = "image/png"


def _crop(page: Page, region: Region) -> tuple[bytes, str]:
    """把一页裁成一个区域。返回 `(字节, Content-Type)`。**#4 只走恒等直通。**"""
    if is_full_page(region.crop, region.pixel):
        return page.data, page.media_type
    # ---- 以下 #4 走不到；#5 接 PyMuPDF 时在这里落地。
    # 刻意不缩放：提高可读性靠切分粒度，不靠提高分辨率（ADR-0008）。
    with Image.open(io.BytesIO(page.data)) as im:
        box = (
            region.crop.x,
            region.crop.y,
            region.crop.x + region.crop.w,
            region.crop.y + region.crop.h,
        )
        # `crop()` 给的是**原始像素**。必须 `save()` 进容器再取字节，
        # `.tobytes()` 出来的东西不是任何图片格式。
        buf = io.BytesIO()
        im.crop(box).save(buf, format=_CROP_FORMAT)
        return buf.getvalue(), _CROP_MEDIA_TYPE


def _lookup(store: SessionStore, session_id: str, artifact_id: str, region_id: str):
    session = store.get(session_id)
    artifact: Artifact | None = session.artifacts.get(artifact_id)
    if artifact is None:
        raise ApiError("artifact_unknown", sessionId=session_id, artifactId=artifact_id)
    region = session.find_region(artifact_id, region_id)
    if region is None:
        raise ApiError(
            "region_unknown",
            sessionId=session_id,
            artifactId=artifact_id,
            regionId=region_id,
        )
    page = next((p for p in artifact.pages if p.index == region.page), None)
    if page is None:  # pragma: no cover - 区域与页同生共死
        raise ApiError("region_unknown", sessionId=session_id, regionId=region_id)
    return session, region, page


@router.get(
    "/{artifact_id}/regions/{region_id}",
    response_class=Response,
    responses={200: {"content": {"image/*": {}}}, 410: {"content": {"application/json": {}}}},
)
async def region_bitmap(
    session_id: str,
    artifact_id: str,
    region_id: str,
    store: SessionStore = Depends(get_store),
) -> Response:
    """区域位图。200 = 位图字节，410 = 会话/资源/区域没了。

    `store.get` 已经顺手续期了（ADR-0014：从最后一次用到会话的请求起算）。
    投屏期间前端**不再请求这里**，所以投屏不续期——那是客户端的义务，
    服务端只需要保证「不请求就不续期」这一条成立。
    """
    _, region, page = _lookup(store, session_id, artifact_id, region_id)
    identity = is_full_page(region.crop, region.pixel)
    data, media_type = _crop(page, region)
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "ETag": f'"{artifact_id}"',
            "Cache-Control": _IMMUTABLE,
            "X-Bscp-Crop-Mode": "identity" if identity else "cropped",
        },
    )
