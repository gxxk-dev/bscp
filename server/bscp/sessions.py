"""会话：一轮「课前准备」的进程内存状态。

**页位图只在内存里，不落盘**（ADR-0014）。一次会话 = 一个 id + 一张
「资源哈希 → 页位图」的表 + 一张区域表；进程一重启全没。

## 为什么用 `time.monotonic()`

过期判定走 **`time.monotonic()`**，不碰墙钟。墙钟会被 NTP 校时拨动，也会被
一体机的休眠/唤醒跳过一段——两种情况都会让一个「还有 12 分钟」的资料突然变成
「已经超时 1 小时」，或者反过来。单调钟只跟着进程自己的流逝走。

`datetime.now(UTC)` 只用来算给前端看的 `expiresAt`，那个值本来就是估计：
它跟单调钟之间没有任何耦合。
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import Request

from . import config
from .errors import ApiError

# Crockford base32：去掉 I L O U，避免操作者把 id 抄错。
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def new_session_id(now: float | None = None) -> str:
    """26 字符、按时间排序的会话 id（ULID 形状：前 10 位是毫秒时间戳 + 16 位随机）。

    排序性是为了日志里能一眼看出「这个会话比那个老」，不是为了当主键用。
    """
    ms = int((time.time() if now is None else now) * 1000)
    return _encode(ms, 10) + _encode(secrets.randbits(80), 16)


@dataclass(frozen=True, slots=True)
class Crop:
    """相对页位图的裁切框。#4 恒等于 `{0, 0, W, H}`。"""

    x: int
    y: int
    w: int
    h: int

    def as_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True, slots=True)
class Size:
    """像素尺寸。**注意与 `bytes` 同名不同义**——回执里两个都要给，别复用字段名。"""

    w: int
    h: int

    def as_dict(self) -> dict[str, int]:
        return {"w": self.w, "h": self.h}

    @property
    def area(self) -> int:
        return self.w * self.h


@dataclass(slots=True)
class Page:
    """一页位图。图片的「页位图」就是收到的原始字节——不解码、不重编码。"""

    index: int
    pixel: Size
    data: bytes
    media_type: str


@dataclass(slots=True)
class Artifact:
    """一份资源。身份是内容哈希（ADR-0015），`display_name` 只是显示属性。"""

    artifact_id: str
    display_name: str
    byte_length: int
    pages: list[Page]
    region_seq: int = 0

    def next_region_id(self) -> str:
        self.region_seq += 1
        return str(self.region_seq)


@dataclass(frozen=True, slots=True)
class Region:
    """一块区域。#4 里 = 整张图，裁切框恒等于全页。"""

    region_id: str
    artifact_id: str
    page: int
    crop: Crop
    pixel: Size

    @property
    def id(self) -> str:
        """全画布唯一：`${artifactId}#${regionId}`。

        **绝不能**用「第几次投放的第几份」这种计数（原型 `model.ts:370` 的 `a${i+1}` 就是
        这么写的）——第二次投放会撞出第二个 `a1`，`key` 重复、React 静默复用或丢块、
        `[data-id="a1"]` 一次选中两个元素。见简报 §7-2。
        """
        return f"{self.artifact_id}#{self.region_id}"


def full_page_crop(pixel: Size) -> Crop:
    """#4 的区域 = 整页。#5 换掉这一行，切分逻辑才有地方长出来。"""
    return Crop(0, 0, pixel.w, pixel.h)


def is_full_page(crop: Crop, pixel: Size) -> bool:
    """裁切框是否就是整页——恒等直通的判据（见 `regions.py`）。"""
    return crop == full_page_crop(pixel)


def bitmap_url(session_id: str, artifact_id: str, region_id: str) -> str:
    """区域位图 URL。**相对路径**——见简报 §1.4，不许出现指向 localhost 的绝对 URL。"""
    return f"/api/sessions/{session_id}/artifacts/{artifact_id}/regions/{region_id}"


@dataclass(slots=True)
class Session:
    id: str
    created_at: float
    last_seen: float
    inflight: int = 0
    parse_started_at: float | None = None
    artifacts: dict[str, Artifact] = field(default_factory=dict)
    #: 区域按登记顺序排列。#4 每份资源只切一块，#5 切多块时顺序就是页序。
    regions: list[Region] = field(default_factory=list)

    # ------------------------------------------------------------ 续期

    def touch(self, now: float) -> None:
        """从「最后一次用到会话的请求」起算 TTL（ADR-0014）。"""
        self.last_seen = now

    def pinned(self, now: float) -> bool:
        """解析中不因 TTL 被回收——但只豁免 [`config.PARSE_PIN_MAX`]。

        兜底是必须的：一次卡死的解析否则会让这份资料永远占着内存。
        """
        if self.inflight <= 0:
            return False
        if self.parse_started_at is None:
            return True
        return now - self.parse_started_at < config.PARSE_PIN_MAX

    @contextmanager
    def pin(self, now: float | None = None) -> Iterator[None]:
        moment = time.monotonic() if now is None else now
        self.inflight += 1
        # 多次并发解析时保留最早的那个开始时间：那才是这份资源可能的最长占用。
        if self.parse_started_at is None:
            self.parse_started_at = moment
        try:
            yield
        finally:
            self.inflight -= 1
            if self.inflight == 0:
                self.parse_started_at = None

    # ------------------------------------------------------------ 过期

    def expired(self, now: float, ttl: int = config.TTL_SECONDS) -> bool:
        if self.pinned(now):
            return False
        return now - self.last_seen > ttl

    def expires_at(self) -> str:
        """给前端看的墙钟估计值。**不参与**过期判定（见模块 docstring）。"""
        deadline = datetime.now(UTC) + timedelta(seconds=config.TTL_SECONDS)
        return deadline.isoformat().replace("+00:00", "Z")

    # ------------------------------------------------------------ 形状

    def region_ids(self) -> list[str]:
        return [r.id for r in self.regions]

    def find_region(self, artifact_id: str, region_id: str) -> Region | None:
        for region in self.regions:
            if region.artifact_id == artifact_id and region.region_id == region_id:
                return region
        return None

    def bytes_held(self) -> int:
        """这一个会话持有的页位图总字节。`ingest` 的内存预算闸门读它。"""
        return sum(len(p.data) for a in self.artifacts.values() for p in a.pages)

    def as_dict(self) -> dict[str, Any]:
        """会话的对外形状。页位图本体不在里面——那是另一个端点的事。"""
        return {
            "sessionId": self.id,
            "expiresAt": self.expires_at(),
            "artifacts": [
                {
                    "artifactId": a.artifact_id,
                    "displayName": a.display_name,
                    "bytes": a.byte_length,
                    "pageCount": len(a.pages),
                }
                for a in self.artifacts.values()
            ],
            "regions": [
                {
                    "id": r.id,
                    "artifactId": r.artifact_id,
                    "displayName": self.artifacts[r.artifact_id].display_name,
                    "page": r.page,
                    "crop": r.crop.as_dict(),
                    "pixel": r.pixel.as_dict(),
                    "bitmapUrl": bitmap_url(self.id, r.artifact_id, r.region_id),
                }
                for r in self.regions
            ],
        }


class SessionStore:
    """进程内的会话表。**单进程**：多 worker 会让 A 进程建的会话在 B 进程上必然 410，
    而健康检查、静态资源、全局 410 一切正常——最难查的一类故障（简报 §7-9）。"""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        ttl: int = config.TTL_SECONDS,
    ) -> None:
        self._clock = clock
        self._ttl = ttl
        self._sessions: dict[str, Session] = {}

    # ------------------------------------------------------------ 基本操作

    def create(self) -> Session:
        """新建一个会话。

        `POST /api/sessions` **无鉴权**（ADR-0014 的会话模型没有账号这一层），
        校园网上任何能连到端口的人都能循环调它，而空会话一样占满 30 分钟 TTL。
        所以这里有一道进程级上限，满了直接拒绝——**不静默挤掉别人正在用的**，
        挤掉会让那个人的下一发请求变成一句莫名其妙的 410。
        """
        if len(self._sessions) >= config.MAX_SESSIONS:
            raise ApiError("too_many_sessions", limit=config.MAX_SESSIONS, active=len(self._sessions))
        now = self._clock()
        session = Session(id=new_session_id(), created_at=now, last_seen=now)
        self._sessions[session.id] = session
        return session

    def get(self, session_id: str, *, now: float | None = None, touch: bool = True) -> Session:
        """取一个会话，顺手做**惰性过期**与续期。

        「从没见过」与「见过但过期了」是两个不同的码（`session_unknown` /
        `session_expired`），但都是 410、同一句可读的话、同一条出路。
        """
        moment = self._clock() if now is None else now
        session = self._sessions.get(session_id)
        if session is None:
            raise ApiError("session_unknown", sessionId=session_id)
        if session.expired(moment, self._ttl):
            del self._sessions[session_id]
            raise ApiError("session_expired", sessionId=session_id)
        if touch:
            session.touch(moment)
        return session

    def delete(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    # ------------------------------------------------------------ 扫掠

    def sweep(self, now: float | None = None) -> list[str]:
        """回收过期的会话。**时钟做成参数**，所以单测不需要 sleep。

        解析中的会话豁免，但受 `PARSE_PIN_MAX` 兜底。
        """
        moment = self._clock() if now is None else now
        gone = [sid for sid, s in self._sessions.items() if s.expired(moment, self._ttl)]
        for sid in gone:
            del self._sessions[sid]
        return gone

    # ------------------------------------------------------------ 测试接缝

    def expire(self, session_id: str, *, now: float | None = None) -> bool:
        """让一个会话**立刻过期**，不等 TTL。`/api/_test/expire` 用。

        注意是「把 `last_seen` 拨到过去」，**不是**从表里删掉：真实情况下客户端
        撞到的是 `session_expired`（「见过、现已不在」），而 `session_unknown`
        是「从没见过」。把钩子做成直接删除，e2e 就永远验不到前者——而那才是
        操作者真会遇到的路径。
        """
        session = self._sessions.get(session_id)
        if session is None:
            return False
        moment = self._clock() if now is None else now
        session.touch(moment - self._ttl - 1)
        return True

    def clear(self) -> int:
        n = len(self._sessions)
        self._sessions.clear()
        return n

    # ------------------------------------------------------------ 杂项

    def count(self) -> int:
        return len(self._sessions)

    def bytes_held(self) -> int:
        return sum(
            len(p.data)
            for s in self._sessions.values()
            for a in s.artifacts.values()
            for p in a.pages
        )


# ---------------------------------------------------------------- 依赖注入


def get_store(request: Request) -> SessionStore:
    """FastAPI 依赖。store 挂在 app state 上，不做模块级单例——
    测试要能造一个干净的 app。"""
    store: SessionStore = request.app.state.sessions
    return store


__all__ = [
    "Artifact",
    "Crop",
    "Page",
    "Region",
    "Session",
    "SessionStore",
    "Size",
    "bitmap_url",
    "full_page_crop",
    "get_store",
    "is_full_page",
    "new_session_id",
]
