#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
禁用 Bridge Desktop 对 DSH Desktop 的自动拉起。

原理：把 app.asar 内 launchDshDesktop() 的函数体用空格覆盖（保持文件长度不变，
避免破坏 asar 头部偏移），使该函数不再执行 open/spawn，从而 DSH Desktop 被手动
关闭后不会被 Bridge 自动重新拉起。
"""

from pathlib import Path

TARGETS = [
    Path("/Applications/Bridge.app/Contents/Resources/app.asar"),
    Path("/Users/martinez/Documents/Claude Bridge/apps/desktop/out/Bridge-darwin-arm64/Bridge.app/Contents/Resources/app.asar"),
]

MARKER = b"async function launchDshDesktop"


def blank_function(data: bytes, marker: bytes) -> tuple[bytes, bool]:
    """将匹配到的函数体替换为空白字符，保持字节长度不变。"""
    raw = bytearray(data)
    idx = raw.find(marker)
    if idx < 0:
        return data, False

    start = raw.find(b"{", idx)
    if start < 0:
        return data, False
    depth = 0
    i = start
    while i < len(raw):
        ch = raw[i]
        if ch == 0x7B:  # {
            depth += 1
        elif ch == 0x7D:  # }
            depth -= 1
            if depth == 0:
                # 把函数体（两个大括号之间）的所有非空白字符改成空格
                for j in range(start + 1, i):
                    if raw[j] not in (0x20, 0x09, 0x0A, 0x0D):
                        raw[j] = 0x20
                return bytes(raw), True
        i += 1
    return data, False


def main() -> int:
    patched_any = False
    for target in TARGETS:
        if not target.exists():
            print(f"SKIP 不存在: {target}")
            continue
        original = target.read_bytes()
        patched, ok = blank_function(original, MARKER)
        if not ok:
            print(f"WARN 未找到自动拉起相关函数: {target}")
            continue
        if patched == original:
            print(f"INFO 已是禁用状态: {target}")
            patched_any = True
            continue
        target.write_bytes(patched)
        print(f"PATCH 已禁用自动拉起: {target}")
        patched_any = True

    if not patched_any:
        print("没有需要修补的文件，或未找到目标函数。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
