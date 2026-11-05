#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr.py —— 批量 OCR（给"文字屏/文档/长图滚动"类视频用）

输入（stdin，JSON）：
  { "frames": [{"path": "...", "t": 12.0}, ...], "minScore": 0.5 }

输出（stdout，JSON）：
  { "frames": [{"t": 12.0, "lines": ["第一行", "第二行"]}, ...], "perFrameMs": 320 }

设计要点：
  · 每帧内部按**纵向坐标**排序，保证读出来的行序和画面一致
  · 低分框丢掉（minScore），减少花屏/水印噪声
  · 只负责"读到什么"，去重和拼接在 Node 那边做
"""
import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    # ⚠️ stdin 也要设！Windows 默认 GBK 解码，含中文的路径会变乱码
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def fail(msg):
    json.dump({"error": str(msg)}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(1)


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        fail("stdin 不是合法 JSON: %s" % e)

    try:
        from PIL import Image
    except Exception:
        fail("缺少 Pillow：pip install pillow")
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception:
        fail("缺少 RapidOCR：pip install rapidocr-onnxruntime")

    frames = req.get("frames") or []
    if not frames:
        fail("没有帧")
    min_score = float(req.get("minScore") or 0.5)

    engine = RapidOCR()
    out = []
    t0 = time.time()

    for fr in frames:
        path = fr.get("path")
        try:
            im = Image.open(path).convert("RGB")
        except Exception as e:
            fail("打不开帧 %r（%s）" % (path, e))

        res, _ = engine(im)
        rows = []
        for item in res or []:
            box, text, score = item[0], item[1], float(item[2])
            if score < min_score:
                continue
            text = str(text).strip()
            if not text:
                continue
            ys = [p[1] for p in box]
            rows.append((min(ys), text))
        rows.sort(key=lambda x: x[0])
        out.append({"t": fr.get("t"), "lines": [r[1] for r in rows]})

    json.dump(
        {
            "frames": out,
            "perFrameMs": int((time.time() - t0) * 1000 / max(1, len(frames))),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
