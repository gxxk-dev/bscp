"""会话：TTL、续期、解析豁免、410 码。

**不 sleep 测 TTL。** `SessionStore` 的时钟是注入的，`sweep(now=t+1801)` 把
「过了 30 分钟」变成一次函数调用。真的 `time.sleep(1801)` 是一条三十分钟的
测试，而且它在 CI 上必然超时——那种测试跑过一次之后就没人再跑第二次。
"""

from __future__ import annotations

import pytest

from bscp import config
from bscp.errors import ApiError
from bscp.sessions import Artifact, Page, SessionStore, Size

TTL = config.TTL_SECONDS


class Clock:
    """可推进的单调钟。`t` 就是「距会话创建的秒数」。"""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def store(clock: Clock) -> SessionStore:
    return SessionStore(clock=clock)


# ---------------------------------------------------------------- 生命周期


def test_create_get_delete(store: SessionStore) -> None:
    session = store.create()
    assert store.get(session.id) is session
    assert store.count() == 1
    assert store.delete(session.id) is True
    assert store.delete(session.id) is False
    assert store.count() == 0


def test_ids_are_unique_and_time_sorted() -> None:
    ids = [SessionStore().create().id for _ in range(50)]
    assert len(set(ids)) == 50
    assert all(len(i) == 26 for i in ids)
    # ULID 形状：同毫秒内单调递增，前 10 位是时间戳。
    assert [i[:10] for i in ids] == sorted(i[:10] for i in ids)


def test_unknown_session_is_410_session_unknown(store: SessionStore) -> None:
    with pytest.raises(ApiError) as caught:
        store.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")
    err = caught.value
    assert err.code == "session_unknown"
    assert err.status_code == 410
    # 「从没见过」也是 410：404 在 SPA 里与「路由不存在」不可区分。
    assert err.retryable is False
    assert err.remedy == "restart"
    assert err.envelope()["error"]["sessionId"] == "01ARZ3NDEKTSV4RRFFQ69G5FAV"


# ---------------------------------------------------------------- TTL


def test_ttl_boundary_is_exactly_1800_seconds(store: SessionStore, clock: Clock) -> None:
    """边界判据是 `>` 不是 `>=`——恰好 1800s 时还没过期。

    两次检查用**两个**会话：第一次 `get` 会续期，用同一个会话量第二次就量到 1s 了。
    """
    on_edge = store.create()
    store.get(on_edge.id, now=on_edge.created_at + TTL, touch=False)
    assert store.get(on_edge.id, now=on_edge.created_at + TTL, touch=False) is on_edge

    past = store.create()
    with pytest.raises(ApiError) as caught:
        store.get(past.id, now=past.created_at + TTL + 1, touch=False)
    assert caught.value.code == "session_expired"
    assert caught.value.status_code == 410


def test_sweep_takes_the_clock_as_a_parameter(store: SessionStore, clock: Clock) -> None:
    """`sweep(now=t+1801)`——不 sleep 测 TTL。"""
    session = store.create()
    t = session.created_at
    assert store.sweep(now=t + 1800) == []
    assert store.sweep(now=t + 1801) == [session.id]
    assert store.count() == 0


def test_touch_renews_from_the_last_use(store: SessionStore, clock: Clock) -> None:
    """TTL 从**最后一次用到会话的请求**起算，不是从创建起算。"""
    session = store.create()
    t = session.created_at
    for _ in range(5):
        t += 1700
        store.get(session.id, now=t)
    # 已经过了 8500s，但每一次都在续期，会话应当还在。
    assert store.sweep(now=t + 1) == []
    assert store.sweep(now=t + TTL + 1) == [session.id]


def test_sweep_is_not_a_necessary_condition_for_expiry(store: SessionStore, clock: Clock) -> None:
    """没人请求时也该被回收——否则过期只靠「下一次访问」触发，内存就一直占着。"""
    session = store.create()
    with pytest.raises(ApiError) as caught:
        store.get(session.id, now=session.created_at + TTL + 1)
    assert caught.value.code == "session_expired"
    # 访问本身就把它摘掉了，不需要再扫一次。
    assert store.count() == 0


# ---------------------------------------------------------------- 解析豁免


def test_parsing_session_is_exempt_from_ttl(store: SessionStore, clock: Clock) -> None:
    """ADR-0014：解析中的会话不因 TTL 被回收。

    这是「解析豁免」存在的**全部理由**：请求进来时 `last_seen` 被刷新，解析期间没人
    再碰它。一份 10 页的资料解析 25 分钟之后，`last_seen + 30min` 一到，扫掠器就会
    在解析还在跑的时候把它回收——下一个请求撞上 410，而操作者什么也没做错。
    """
    session = store.create()
    t = session.created_at
    with session.pin(now=t):
        clock.t = t + TTL + 1
        assert store.sweep(now=clock.t) == []
        assert store.get(session.id, now=clock.t) is session


def test_parse_pin_has_a_backstop(store: SessionStore, clock: Clock) -> None:
    """豁免只豁免 `PARSE_PIN_MAX`——否则一次卡死的解析会让这份资料永远占着内存。"""
    assert config.PARSE_PIN_MAX > TTL, "豁免上限小于 TTL 时它是一段死代码"
    session = store.create()
    t = session.created_at
    with session.pin(now=t):
        clock.t = t + config.PARSE_PIN_MAX - 1
        assert store.sweep(now=clock.t) == []
        clock.t = t + config.PARSE_PIN_MAX
        assert store.sweep(now=clock.t) == [session.id]


def test_pin_is_released_even_when_the_body_raises(store: SessionStore) -> None:
    session = store.create()
    with pytest.raises(ValueError), session.pin():
        assert session.inflight == 1
        raise ValueError("炸了")
    assert session.inflight == 0
    assert session.parse_started_at is None
    assert not session.pinned(session.created_at + 10**6)


def test_concurrent_pins_keep_the_earliest_start(store: SessionStore) -> None:
    session = store.create()
    with session.pin(now=100.0):
        with session.pin(now=500.0):
            # 两个并发解析，最长的占用由最早的那个决定。
            assert session.parse_started_at == 100.0
        # 内层退出不解除外层的占用。
        assert session.inflight == 1
        assert session.parse_started_at == 100.0
    assert session.inflight == 0


# ---------------------------------------------------------------- 墙钟隔离


def test_expiry_never_reads_the_wall_clock(store: SessionStore, clock: Clock) -> None:
    """`expires_at()` 只是给前端看的估计值，判过期只看单调钟。"""
    session = store.create()
    assert session.expires_at().endswith("Z")
    # 单调钟没动：无论墙钟怎么跳（这里根本不碰它），会话都不过期。
    assert store.sweep(now=session.created_at) == []


# ---------------------------------------------------------------- 测试接缝


def test_expire_hook_ages_the_session_rather_than_deleting_it(
    store: SessionStore, clock: Clock
) -> None:
    """/api/_test/expire 把 `last_seen` 拨到过去，**不是**删掉。

    删掉的话，e2e 撞到的就永远是 `session_unknown`（从没见过），而
    `session_expired`（见过、现已不在）那条路径一次都验不到。
    """
    session = store.create()
    assert store.expire(session.id) is True
    assert store.expire(session.id) is True  # 还在表里，所以第二次也找得到
    assert store.expire("从来没有过的 id") is False
    with pytest.raises(ApiError) as caught:
        store.get(session.id)
    assert caught.value.code == "session_expired"
    # 访问本身把它摘掉了——不需要再扫一次。
    assert store.count() == 0


def test_clear_drops_everything(store: SessionStore) -> None:
    for _ in range(3):
        store.create()
    assert store.clear() == 3
    assert store.count() == 0


def test_session_count_is_capped(store: SessionStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """同时活着的会话数有上限。

    `POST /api/sessions` 无鉴权（ADR-0014 的会话模型没有账号这一层），校园网上
    任何能连到端口的人都能循环调它，而**空会话一样占满 30 分钟 TTL**。
    没有上限时，一个循环脚本就能把一体机的会话表撑满，而健康检查一切正常。
    """
    monkeypatch.setattr(config, "MAX_SESSIONS", 3)
    for _ in range(3):
        store.create()
    with pytest.raises(ApiError) as caught:
        store.create()
    assert caught.value.code == "too_many_sessions"
    assert caught.value.status_code == 503
    assert caught.value.retryable is True
    # 前三个**一个都没被挤掉**——挤掉会让那个人的下一发请求变成一句莫名的 410。
    assert store.count() == 3


def test_the_cap_frees_up_again_once_sessions_expire(
    store: SessionStore, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """上限不是死锁：回收之后还能再建。"""
    monkeypatch.setattr(config, "MAX_SESSIONS", 2)
    for _ in range(2):
        store.create()
    with pytest.raises(ApiError):
        store.create()

    store.sweep(now=clock() + config.TTL_SECONDS + 1)
    assert store.count() == 0
    store.create()
    assert store.count() == 1


def test_session_bytes_held_counts_only_page_bitmaps(
    store: SessionStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`Session.bytes_held` 是**这一个**会话的页位图字节，跨会话不串。"""
    a, b = store.create(), store.create()
    a.artifacts["sha256:1"] = Artifact(
        artifact_id="sha256:1",
        display_name="a.png",
        byte_length=3,
        pages=[Page(index=1, pixel=Size(1, 1), data=b"abc", media_type="image/png")],
    )
    assert a.bytes_held() == 3
    assert b.bytes_held() == 0
    assert store.bytes_held() == 3
