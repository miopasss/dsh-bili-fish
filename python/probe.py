#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe.py —— 雪碧图探针：判断"这个视频的字在不在画面上"

输入（stdin，JSON）：
  { "sprites": [{"path": "...", "cols": 10, "rows": 10}, ...],
    "totalFrames": 899, "samples": 3, "upscale": 2 }

输出（stdout，JSON）：
  { "charsPerFrame": [195, 234, 167], "avg": 198.7, "perFrameMs": 2150, "texts": [...] }

设计要点：
  · 480x270 的低分辨率在这里是**优点**——只有字很大的画面才读得出，而"字大"正是文字屏/PPT/硬字幕的特征
  · 只用来判断"有没有字"，**绝不拿它的结果当正文**（实测字数准、字全错）
"""
import io
import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    # ⚠️ stdin 也要设！Windows 上默认按 GBK 解码标准输入，
    #    路径里的中文（如 C:\Users\<用户名>\...）会被解成乱码 → Image.open 报 FileNotFoundError
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

    sprites = req.get("sprites") or []
    if not sprites:
        fail("没有雪碧图")

    cols = int(sprites[0].get("cols") or 10)
    rows = int(sprites[0].get("rows") or 10)
    per_sheet = cols * rows
    total = int(req.get("totalFrames") or len(sprites) * per_sheet)
    samples = max(1, int(req.get("samples") or 3))
    upscale = max(1, int(req.get("upscale") or 2))

    # 均匀取样（避开第 0 帧，那通常是封面）
    if samples == 1:
        idxs = [max(1, total // 2)]
    else:
        step = (total - 1) / max(1, samples - 1)
        idxs = sorted({min(total - 1, max(1, int(round(1 + k * (total - 2) / max(1, samples - 1))))) for k in range(samples)})

    engine = RapidOCR()
    chars, texts = [], []
    t0 = time.time()
    cache = {}
    for idx in idxs:
        sheet_i, cell = divmod(idx, per_sheet)
        if sheet_i >= len(sprites):
            sheet_i = len(sprites) - 1
            cell = per_sheet - 1
        path = sprites[sheet_i]["path"]
        if path not in cache:
            try:
                cache[path] = Image.open(path).convert("RGB")
            except Exception as e:
                fail("打不开雪碧图 %r（%s）" % (path, e))
        im = cache[path]
        W, H = im.size
        cw, ch = W // cols, H // rows
        r, c = divmod(cell, cols)
        box = (c * cw, r * ch, c * cw + cw, r * ch + ch)
        cellimg = im.crop(box)
        if upscale != 1:
            cellimg = cellimg.resize((cw * upscale, ch * upscale), Image.LANCZOS)
        res, _ = engine(cellimg)
        txt = "".join(line[1] for line in res) if res else ""
        chars.append(len(txt))
        texts.append(txt)

    dt = (time.time() - t0) * 1000
    json.dump(
        {
            "charsPerFrame": chars,
            "avg": round(sum(chars) / len(chars), 1),
            "perFrameMs": int(dt / max(1, len(chars))),
            "sampleIndexes": idxs,
            "texts": texts,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
