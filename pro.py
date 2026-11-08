#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proj.py — 目录 <-> JSON 互转工具

导出(-e): 读取目录下所有文件(含子目录)，打包成一个 JSON:
          键 = 相对路径(以导出目录名为根，如 "dir/filea.js"、"dir/subdir/fileb.sh")
          值 = 文件内容(文本原样保留换行；二进制文件自动转 base64 存放)
          注: 空目录、软链接无法用 JSON 表达，会被跳过

导入(-i): 读取导出的 JSON，在【脚本所在目录】按原目录结构还原所有文件

用法:
  导出   python3 proj.py -e /path/to/dir               # JSON(单行)打印到终端
         python3 proj.py -e /path/to/dir -o out.json   # 写入指定文件
  导入   python3 proj.py -i out.json                   # 还原到脚本所在目录

示例:
  python3 proj.py -e /data -o data.json
  python3 proj.py -i data.json
"""

import argparse
import base64
import json
import os
import re
import sys

B64_KEY = "__b64__"                 # 二进制文件的包装格式: {B64_KEY: "base64字符串"}
DRIVE_RE = re.compile(r"^[A-Za-z]:")  # 拒绝 Windows 盘符式路径成分


def die(msg, code=1):
    sys.stderr.write("proj.py: 错误: %s\n" % msg)
    sys.exit(code)


def iter_files(src):
    """确定性地遍历 src 下所有普通文件(跳过软链接/fifo 等特殊文件)。"""
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(root, d)))
        for name in sorted(files):
            full = os.path.join(root, name)
            if os.path.islink(full) or not os.path.isfile(full):
                sys.stderr.write("proj.py: 跳过特殊文件: %s\n" % full)
                continue
            yield full


def read_entry(path):
    """读取一个文件: 优先按 UTF-8 文本(保留原始换行符)，失败则按 base64。"""
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(path, "rb") as f:
            return {B64_KEY: base64.b64encode(f.read()).decode("ascii")}


def cmd_export(src, out_path):
    src = os.path.abspath(src)
    if not os.path.isdir(src):
        die("目录不存在: %s" % src)

    parent = os.path.dirname(src)  # 键相对父目录 => 自带目录名作根(与示例 "dir/filea.js" 一致)
    data = {}
    total = 0
    for full in iter_files(src):
        rel = os.path.relpath(full, parent).replace(os.sep, "/")
        try:
            data[rel] = read_entry(full)
        except OSError as e:
            sys.stderr.write("proj.py: 跳过无法读取的文件 %s (%s)\n" % (rel, e))
            continue
        total += os.path.getsize(full)

    payload = json.dumps(data, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), indent=2)
    if out_path:
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(payload + "\n")
        sys.stderr.write("proj.py: 已导出 %d 个文件(共 %d 字节) -> %s\n"
                         % (len(data), total, out_path))
    else:
        sys.stdout.write(payload + "\n")
        sys.stderr.write("proj.py: 已导出 %d 个文件(共 %d 字节) 到标准输出\n"
                         % (len(data), total))


def safe_parts(key):
    """把键拆成安全路径成分(防绝对路径/目录穿越/盘符)，非法返回 None。"""
    parts = [p for p in key.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    if any(DRIVE_RE.match(p) for p in parts):
        return None
    return parts


def cmd_import(json_path):
    base = os.path.dirname(os.path.abspath(__file__))  # 还原到脚本所在目录
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        die("无法读取 JSON: %s (%s)" % (json_path, e))
    if not isinstance(data, dict):
        die("JSON 顶层必须是对象({\"路径\": 内容})")

    ok = skipped = 0
    for key in sorted(data):
        parts = safe_parts(key)
        if parts is None:
            sys.stderr.write("proj.py: 跳过非法路径键: %r\n" % key)
            skipped += 1
            continue
        target = os.path.join(base, *parts)
        val = data[key]
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if isinstance(val, dict) and B64_KEY in val:
                with open(target, "wb") as f:
                    f.write(base64.b64decode(val[B64_KEY]))
            else:
                text = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
                with open(target, "w", encoding="utf-8", newline="") as f:
                    f.write(text)
            sys.stderr.write("proj.py:   + %s\n" % key)
            ok += 1
        except (OSError, ValueError) as e:
            sys.stderr.write("proj.py: 写入失败 %s (%s)\n" % (key, e))
            skipped += 1

    sys.stderr.write("proj.py: 完成: 在 %s 下还原 %d 个文件%s\n"
                     % (base, ok, ("，跳过 %d 项" % skipped) if skipped else ""))


def main():
    ap = argparse.ArgumentParser(
        prog="proj.py",
        description="目录 <-> JSON 互转: 导出目录所有文件为 JSON；从 JSON 还原到脚本所在目录",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python3 proj.py -e /data -o data.json\n"
               "  python3 proj.py -i data.json\n")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("-e", "--export", metavar="DIR",
                   help="导出指定目录的全部文件为 JSON")
    g.add_argument("-i", "--import", metavar="FILE", dest="import_file",
                   help="读取导出的 JSON，还原到脚本所在目录")
    ap.add_argument("-o", "--output", metavar="JSON",
                    help="(配合 -e)输出 JSON 文件路径，缺省打印到终端")
    args = ap.parse_args()

    if args.export:
        cmd_export(args.export, args.output)
    else:
        cmd_import(args.import_file)


if __name__ == "__main__":
    main()
# eg: python -i test.json 导入json为项目目录
