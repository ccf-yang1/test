#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reader 的 XXTEA 解密脚本（仅标准库）。

数据格式（从 ARM64 反汇编恢复并实测验证）：
  - 密文长度必须是 4 的倍数，且至少 8 字节；
  - 每 4 字节按小端解释为 uint32；
  - XXTEA: delta = 0x9E3779B9, rounds = 6 + 52 / n；
  - 解密后最后一个 uint32 是原始明文字节长度；
  - 校验：4n-7 <= 明文长度 <= 4n-4（n = 密文 uint32 个数）；
  - 默认 key 为 App 内置字符串，取 UTF-8 前 16 字节（不足补 0）。

用法：
  python3 -I xxtea_decrypt.py book.xbs
  python3 -I xxtea_decrypt.py book.xbs -o book.json
  python3 -I xxtea_decrypt.py book.xbs --json
  python3 -I xxtea_decrypt.py book.xbs --key-hex 00112233445566778899aabbccddeeff

注意：
  - 默认把解密后的原始字节写到 stdout；用 -o 输出到文件，或加 --json 美化 JSON。
  - 进度/错误信息走 stderr，不会污染二进制输出。
  - 建议用 `python3 -I` 运行，避免当前目录里的同名模块被误导入。
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

DELTA = 0x9E3779B9
MASK = 0xFFFFFFFF

# App 默认 key：凼褆滿金溡候孞柦地橷旳
# 直接写入 UTF-8 字符；本文件必须以 UTF-8 保存。
DEFAULT_KEY = (
    "凼褆滿金溡候"
    "孞柦地橷旳"
)

# 自检：实际参与运算的前 16 字节。
_EXPECTED_KEY16 = bytes.fromhex("e587bce8a486e6bbbfe98791e6baa1e5")
assert DEFAULT_KEY.encode("utf-8")[:16] == _EXPECTED_KEY16, "默认 key 自检失败"


def _mx(z: int, y: int, s: int, k: list[int], p: int, e: int) -> int:
    """XXTEA 的 MX 函数，所有运算按 uint32 截断。"""
    return (
        (
            (((z >> 5) ^ ((y << 2) & MASK))
             + ((y >> 3) ^ ((z << 4) & MASK))) & MASK
        )
        ^ (((s ^ y) + (k[(p & 3) ^ e] ^ z)) & MASK)
    ) & MASK


def _key_words(key: bytes) -> list[int]:
    """取 key 的前 16 字节，不足补 0，转成 4 个 uint32（小端）。"""
    key16 = (key + b"\x00" * 16)[:16]
    return list(struct.unpack("<4I", key16))


def xxtea_decrypt(data: bytes, key: bytes) -> bytes:
    """解密 App 格式的 XXTEA 数据，返回原始明文字节。"""
    if len(data) < 8:
        raise ValueError(f"密文太短：{len(data)} 字节（至少 8 字节）")
    if len(data) % 4 != 0:
        raise ValueError(f"密文长度不是 4 的倍数：{len(data)}")

    n = len(data) // 4
    v = list(struct.unpack("<%dI" % n, data))
    k = _key_words(key)

    rounds = 6 + 52 // n
    total = (rounds * DELTA) & MASK
    y = v[0]

    while total:
        e = (total >> 2) & 3
        for p in range(n - 1, 0, -1):
            z = v[p - 1]
            v[p] = (v[p] - _mx(z, y, total, k, p, e)) & MASK
            y = v[p]
        z = v[n - 1]
        v[0] = (v[0] - _mx(z, y, total, k, 0, e)) & MASK
        y = v[0]
        total = (total - DELTA) & MASK

    length = v[-1]
    if not (4 * n - 7 <= length <= 4 * n - 4):
        raise ValueError(
            f"长度校验失败：trailer={length}, 密文={len(data)} 字节, n={n}; "
            "key 可能不对，或文件不是这种 XXTEA 格式"
        )

    return struct.pack("<%dI" % n, *v)[:length]


def _build_key(args: argparse.Namespace) -> bytes:
    if args.key_hex:
        try:
            raw = bytes.fromhex(args.key_hex)
        except ValueError as exc:
            raise ValueError(f"--key-hex 不是合法十六进制：{exc}") from exc
        if not raw:
            raise ValueError("--key-hex 不能为空")
        return raw
    if args.key is not None:
        return args.key.encode("utf-8")
    return DEFAULT_KEY.encode("utf-8")


def _make_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="解密Reader 的 .xbs（XXTEA）文件",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python3 -I xxtea_decrypt.py book.xbs -o book.json\n"
            "  python3 -I xxtea_decrypt.py book.xbs --json\n"
            "  python3 -I xxtea_decrypt.py book.xbs --key-hex 00...ff\n"
        ),
    )
    p.add_argument("input", type=Path, help="待解密的文件（如 .xbs）")
    p.add_argument("-o", "--output", type=Path, help="输出文件；省略则写到 stdout")
    p.add_argument(
        "--key",
        help="自定义 key 字符串（UTF-8，取前 16 字节，不足补 0）；默认使用 App 内置 key",
    )
    p.add_argument(
        "--key-hex",
        help="自定义 key 的十六进制形式（优先级高于 --key）",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="把明文按 UTF-8 解码并解析为 JSON，美化输出",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="不输出成功/统计信息到 stderr",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _make_parser().parse_args(argv)

    try:
        data = args.input.read_bytes()
        key = _build_key(args)
        plain = xxtea_decrypt(data, key)
    except FileNotFoundError:
        print(f"错误：找不到文件 {args.input}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"错误：读取文件失败：{exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    if args.json:
        try:
            text = plain.decode("utf-8")
            obj = json.loads(text)
            plain = (
                json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            print(f"错误：明文不是合法 UTF-8 JSON：{exc}", file=sys.stderr)
            return 1

    if args.output:
        try:
            args.output.write_bytes(plain)
        except OSError as exc:
            print(f"错误：写入文件失败：{exc}", file=sys.stderr)
            return 2
    else:
        try:
            sys.stdout.buffer.write(plain)
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            return 0

    if not args.quiet:
        dest = str(args.output) if args.output else "stdout"
        print(
            f"解密成功：{len(data)} 字节密文 -> {len(plain)} 字节明文，输出到 {dest}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
