"""把 multipart 的落盘阈值抬到 [`config.SPOOL_MAX_BYTES`]。

**导入即生效。** `api.py` 必须在建 app 之前 `import bscp.spool`——
monkeypatch 打在一个类属性上，晚于第一次解析就没有意义了。

这是「不落盘」唯一能被自动化守住的方式（ADR-0014）：功能不会因为它坏掉，
只有一个临时文件经过了磁盘。见 `tests/test_no_disk.py`。
"""

from __future__ import annotations

from starlette.formparsers import MultiPartParser

from .config import SPOOL_MAX_BYTES

MultiPartParser.spool_max_size = SPOOL_MAX_BYTES

__all__ = ["MultiPartParser", "SPOOL_MAX_BYTES"]
