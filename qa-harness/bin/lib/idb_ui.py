#!/usr/bin/env python3
"""Helpers over `idb ui describe-all` JSON (stdin) for bin/qa's fast iOS path.

  idb_ui.py text                          -> compact rows: id | value | label | [x1,y1][x2,y2] | flags
  idb_ui.py find id|text <value> <exact|contains|regex> <index>
                                          -> "x y" centre of the match (points), exit 1 when not found
"""
import json
import re
import sys


def elements():
    data = json.load(sys.stdin)
    return data if isinstance(data, list) else [data]


def bounds(e):
    f = e.get("frame") or {}
    x, y, w, h = f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)
    return x, y, w, h


def main():
    mode = sys.argv[1]
    els = elements()
    if mode == "text":
        for e in els:
            rid = e.get("AXUniqueId") or ""
            label = e.get("AXLabel") or ""
            value = e.get("AXValue") or ""
            if not (rid or label or value):
                continue
            x, y, w, h = bounds(e)
            flags = []
            if e.get("enabled") is False:
                flags.append("disabled")
            traits = [t for t in (e.get("traits") or []) if t not in ("None",)]
            if "Selected" in traits:
                flags.append("selected")
            role = e.get("role_description") or ""
            print(" | ".join([rid, str(value).replace("\n", "\\n"), label.replace("\n", "\\n"),
                              "[%d,%d][%d,%d]" % (x, y, x + w, y + h), ",".join(flags + ([role] if role else []))]))
        return 0
    if mode == "find":
        kind, value, match, index = sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5] or 0)

        def ok(s):
            s = s or ""
            if match == "exact":
                return s == value
            if match == "contains":
                return value in s
            return re.fullmatch(value, s) is not None

        hits = []
        for e in els:
            if kind == "id":
                if ok(e.get("AXUniqueId")):
                    hits.append(e)
            elif ok(e.get("AXLabel")) or ok(str(e.get("AXValue") or "")):
                hits.append(e)
        if len(hits) <= index:
            return 1
        x, y, w, h = bounds(hits[index])
        print("%d %d" % (round(x + w / 2), round(y + h / 2)))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
