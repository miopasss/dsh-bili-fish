#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qr.py —— 把一段文本渲染成二维码

输入（stdin，JSON）：{ "text": "https://...", "scale": 6, "border": 2 }
输出（stdout）：SVG 文本（直接塞进网页就能显示，不需要图片接口）

为什么不用 npm 二维码库：这个项目零 npm 依赖。Python 侧已经有依赖了
（OCR/ASR 都要 Python），所以二维码放这边最省事。
"""
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    # 直接从字节读：PowerShell 管道会给 stdin 加 BOM，文本模式会炸
    try:
        raw = sys.stdin.buffer.read().decode("utf-8-sig")
        req = json.loads(raw)
    except Exception as e:
        print("bad json: %s" % e, file=sys.stderr)
        sys.exit(1)

    text = req.get("text") or ""
    if not text:
        print("empty text", file=sys.stderr)
        sys.exit(1)

    try:
        import qrcode
        import qrcode.image.svg
    except Exception:
        print("缺少 qrcode：pip install qrcode", file=sys.stderr)
        sys.exit(1)

    box = int(req.get("scale") or 6)
    border = int(req.get("border") or 2)

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box,
        border=border,
        image_factory=qrcode.image.svg.SvgPathImage,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image()
    sys.stdout.write(img.to_string().decode("utf-8"))


if __name__ == "__main__":
    main()
