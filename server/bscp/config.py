"""环境变量与常量。

刻意不装 pydantic-settings：这三个开关用 `os.environ` 读就够，
少一个依赖就少一处「配置从哪来」的答案。
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- 环境开关

ENV_VAR_STATIC_DIR = "BSCP_STATIC_DIR"
ENV_VAR_TEST_HOOKS = "BSCP_TEST_HOOKS"
ENV_VAR_ENV = "BSCP_ENV"
#: 显式声明 worker 数。留空时 `api.detect_workers` 自己去父进程 argv 里找。
ENV_VAR_WORKERS = "BSCP_WORKERS"

#: `BSCP_STATIC_DIR` 不设时的兜底：`server/` 的同级目录 `prototype/dist`。
DEFAULT_STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "prototype" / "dist"

#: `production` 时会断言启动形态（见 `api.check_runtime`）。
ENV_PRODUCTION = "production"


def static_dir() -> Path:
    """构建产物目录。`dist` 是 gitignore 的，所以它常常不存在——见 `errors` 的 503。"""
    raw = os.environ.get(ENV_VAR_STATIC_DIR)
    return Path(raw) if raw else DEFAULT_STATIC_DIR


def test_hooks_enabled() -> bool:
    """`BSCP_TEST_HOOKS=1` 时才注册 `/api/_test/*`。

    读的是当前环境而不是导入时的快照：测试要在同一个进程里反复开关它。
    """
    return os.environ.get(ENV_VAR_TEST_HOOKS, "") == "1"


def env_name() -> str:
    return os.environ.get(ENV_VAR_ENV, "development")


# ---------------------------------------------------------------- 常量

#: 会话 TTL：30 分钟无活动（ADR-0014）。从最后一次用到会话的请求起算。
TTL_SECONDS = 1800

#: 解析豁免的**绝对上限**（从解析开始算），不是 TTL 的补充。
#:
#: 它必须 **大于 `TTL_SECONDS`**，否则豁免是死代码：请求进来时 `last_seen` 被刷新，
#: 解析期间没人再碰它，于是 `last_seen + TTL` 一到就被扫走——
#: 而 `now - parse_started_at` 那时必然已经超过任何小于 TTL 的上限。
#: 换句话说，一份 10 页的资料解析了 25 分钟，扫掠器会在第 30 分钟把它回收，
#: 而解析还在跑，下一个请求就撞上 410。ADR-0014 说的「解析中不回收」就是为了这个。
#: 给它一整个 TTL 的余量之后，卡死的解析最多占一小时，然后被回收。
PARSE_PIN_MAX = 2 * TTL_SECONDS

#: 后台扫掠的间隔。TTL 的粒度由这个值决定，1800s 的 TTL 上 60s 的误差无所谓。
SWEEP_INTERVAL_SECONDS = 60

#: **单份文件**的上限，超了给一条逐项 verdict（`file_too_large`），**不是** 413。
#:
#: 为什么要两条闸门：投放端点恒 200，混着收与拒靠逐项 verdict 表达。一批投三份、
#: 其中一份 40MB，整批给 4xx 会把另外两份的回执一起吞掉——那正是
#: 「一次回执逐个点名」这条 AC 要避免的事。
#:
#: 32MB 不是产品闸门，是「再大就不像一份要投的资料」的经验值。ADR-0019 那条
#: 真正的 30MB 闸门属于 #5。
MAX_FILE_BYTES = 32 * 1024 * 1024

#: 整次请求的**防崩**硬闸门，超了给 413。与 ADR-0019 的 30MB 闸门是两回事：
#: ADR-0019 那条属于 #5（连页数一起做），混进 #4 会让 #5 的 AC 变成空过。
#: 这里只保证「一个请求不会把进程撑爆」，没有任何产品含义。
#:
#: **必须明显大于 `MAX_FILE_BYTES`**（见下面的 `_check_invariants`）：它要比逐项
#: 闸门宽，单份超限永远由逐项 verdict 接住，413 只兜「一份份都合法、加起来太离谱」
#: 的极端情况。两者相等时单份 40MB 会先撞上 413，而那条批次级 4xx 恰好把上面
#: 这条常量存在的理由毁掉。
MAX_BYTES_HARD = 4 * MAX_FILE_BYTES

#: multipart 解析器的落盘阈值。提到 32MB 是因为 Starlette 默认 1MB 就开始滚到
#: 磁盘临时文件（`starlette/formparsers.py` 的 `spool_max_size`），那与 ADR-0014
#: 「页位图不落盘」正面冲突，而且**隐形**：功能全对，只是有文件经过了磁盘。
#: `spool.py` 导入即生效。
#:
#: 必须 `>= MAX_BYTES_HARD`，否则超限的请求会先滚到磁盘、再被我们拒掉——
#: 「不落盘」这条不变量最容易被这样悄悄破掉。
SPOOL_MAX_BYTES = MAX_BYTES_HARD

#: 防崩闸门：像素数。
#:
#: Pillow 自己的 decompression-bomb 保护**在 `Image.open` 读尺寸时就会跑**
#: （`PIL/Image.py` 的 `_decompression_bomb_check`，在任何解码之前），阈值是
#: `2 * MAX_IMAGE_PIXELS` ≈ 179M px。那道保护抛的是**异常**而不是逐项 verdict，
#: 落到 `ingest_batch` 的列表推导里会掀掉整批——而投放端点恒 200（见
#: `ingest.py`）。所以 `ingest._probe_image` 读头部时把它关掉，判定统一交给这里。
#:
#: 本闸门比 Pillow 那道严格得多（40M vs 179M），而且给出带宽高、可操作的
#: 逐项话术——这才是它存在的理由，不是「Pillow 那个不生效」。
#: 40M ≈ 一张 6300×6300；A4@300dpi 是 8.7M，留了四倍余量。
MAX_PIXELS = 40_000_000

#: 进程内**同时活着**的会话数上限。`POST /api/sessions` 无鉴权（ADR-0014 的
#: 会话模型没有账号），校园网上任何能连到端口的人都能空转建会话，而空会话
#: 一样占满 30 分钟 TTL。超了直接拒绝创建，不静默挤掉别人的。
MAX_SESSIONS = 64

#: 单个会话持有的**页位图总字节**上限。一轮「课前准备」投十几份扫描件就到
#: 了；而每次投放都 `touch()` 续期，于是「一直投」等于「一直涨且永不过期」。
#: 一体机通常只有 8GB。
#:
#: 超了走一条**逐项**拒收码而不是抛异常，这样「端点恒 200」仍然成立，
#: 同一批里其它文件照拿回执（见 `ingest.ingest_one`）。
SESSION_BYTES_BUDGET = 128 * 1024 * 1024

#: 一张图片就是一个资源，一个资源只有一页（#4 只收图片，PDF 在 #5）。
#: 写成常量是为了让 #5 换掉它时只有一个地方要改。
PAGES_PER_ARTIFACT = 1


def _check_invariants() -> None:
    if SPOOL_MAX_BYTES < MAX_BYTES_HARD:  # pragma: no cover - 导入期即失败
        raise RuntimeError(
            f"SPOOL_MAX_BYTES({SPOOL_MAX_BYTES}) 必须 >= MAX_BYTES_HARD({MAX_BYTES_HARD})，"
            "否则超限请求会先落盘再被拒，ADR-0014 的「不落盘」就破了"
        )
    if MAX_BYTES_HARD <= MAX_FILE_BYTES:  # pragma: no cover - 导入期即失败
        raise RuntimeError(
            f"MAX_BYTES_HARD({MAX_BYTES_HARD}) 必须 > MAX_FILE_BYTES({MAX_FILE_BYTES})，"
            "否则单份超限的文件会先撞上整批 413，同批其它文件的逐项回执被一起吞掉"
        )
    if SWEEP_INTERVAL_SECONDS <= 0 or SWEEP_INTERVAL_SECONDS >= TTL_SECONDS:  # pragma: no cover
        raise RuntimeError("SWEEP_INTERVAL_SECONDS 必须为正且小于 TTL_SECONDS")
    if PARSE_PIN_MAX <= TTL_SECONDS:  # pragma: no cover - 导入期即失败
        raise RuntimeError(
            f"PARSE_PIN_MAX({PARSE_PIN_MAX}) 必须 > TTL_SECONDS({TTL_SECONDS})，"
            "否则解析豁免是一段永远不生效的死代码"
        )


_check_invariants()
