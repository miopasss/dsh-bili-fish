#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr.py —— 语音转写（给"没有字幕、画面也没几个字"的视频用）

输入（stdin，JSON）：
  { "audio": "D:/.../audio.m4a", "model": "small", "device": "cpu",
    "vad": true, "language": null }

输出（stdout，JSON）：
  { "segments": [{"t": 12.3, "c": "这一句转写出来的话"}, ...],
    "language": "zh", "durationSec": 92.0, "model": "small", "elapsedMs": 12345 }

设计要点：
  · 只负责"听到什么"，合并/去噪在 Node 那边做（和 ocr.py 分工一致）
  · 首次使用会自动下载模型（几百 MB），进度打在 stderr，不要污染 stdout 的 JSON
  · 模型/依赖缺失时返回 {"error": ...} 并 exit 1，让 Node 侧给出人能看懂的提示
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
        from faster_whisper import WhisperModel
    except Exception:
        fail("缺少 faster-whisper：pip install faster-whisper")

    audio = req.get("audio")
    if not audio:
        fail("没有 audio 路径")

    model_name = str(req.get("model") or "small")
    device = str(req.get("device") or "cpu")
    vad = bool(req.get("vad", True))
    language = req.get("language") or None
    # CPU 上用 int8 快很多，精度损失可以接受；GPU 上让 ctranslate2 自己挑
    compute_type = "int8" if device == "cpu" else "float16"

    t0 = time.time()
    try:
        # 首次会自动从 HuggingFace 拉模型；进度走 stderr
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:
        fail("加载模型 %s 失败（首次使用需要联网下载）：%s" % (model_name, e))

    try:
        segments, info = model.transcribe(
            audio,
            language=language,
            vad_filter=vad,
            # 中文视频常见中英混说，关掉"翻译成英文"
            task="transcribe",
            beam_size=5,
        )
        out = []
        for s in segments:
            text = (s.text or "").strip()
            if not text:
                continue
            out.append({"t": round(float(s.start), 2), "c": text})
    except Exception as e:
        fail("转写失败：%s" % e)

    if not out:
        fail("转写结果为空（可能是纯音乐/无人声）")

    json.dump(
        {
            "segments": out,
            "language": getattr(info, "language", None),
            "durationSec": round(float(getattr(info, "duration", 0) or 0), 2),
            "model": model_name,
            "elapsedMs": int((time.time() - t0) * 1000),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
