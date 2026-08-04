from __future__ import annotations

from importlib import resources


def extension_source() -> str:
    return resources.files(__package__).joinpath("loopx-goal.ts").read_text(encoding="utf-8")
