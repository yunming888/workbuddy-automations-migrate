# -*- coding: utf-8 -*-
"""
视频号口播视频生成器（方案一：素材库 + 脚本流水线）
====================================================
输入：热点评论口播稿 md（_衍生/YYYYMMDD_视频号口播稿.md）
输出：1080x1920 / 30fps / H.264 / 12Mbps 的竖屏口播视频

流程：解析稿 → edge_tts 配音(带词级时间轴) → 挑底片 → 横片转竖屏(模糊背景+居中前景)
      → 按句烧字幕 → 混 BGM → 导出

用法：
  python _channels_factory.py <口播稿.md> [--voice zh-CN-YunyangNeural] [--style cold|warm] [--rate +5%]
Python 用 C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe
"""
import argparse
import asyncio
import datetime
import os
import random
import re
import subprocess
import sys

BASE = r"C:\Users\Administrator\WorkBuddy\2026-07-10-17-25-30"
KS_ASSETS = r"C:\Users\Administrator\.workbuddy\skills\kuaishou-yehua\assets"
OUT_ROOT = os.path.join(BASE, "output", "channels")
FFMPEG = r"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
FFPROBE = r"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

W, H = 1080, 1920          # 视频号 9:16 竖屏
FPS = 30
BITRATE = "12M"            # 官方建议 10Mbps 及以上
FONT_SIZE = 46             # 1080x1920 下 36 号偏小
SUB_Y_RATIO = 0.72         # 字幕纵向位置，避开底部 UI
TAIL = 1.6                 # 结尾留白秒数


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="ignore", **kw)
    if r.returncode != 0:
        print("[ffmpeg ERROR]", r.stderr[-1200:])
        raise SystemExit(1)
    return r


def parse_script(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    title = ""
    m = re.search(r"^#\s*(.+)$", raw, re.M)
    if m:
        title = m.group(1).strip()
    parts = raw.split("---")
    body = parts[1] if len(parts) >= 3 else raw
    body = re.sub(r"^\*\*.*?\*\*.*$", "", body, flags=re.M)   # 去掉加粗元信息行
    body = re.sub(r"^#.*$", "", body, flags=re.M)
    paras = [p.strip() for p in body.split("\n") if p.strip()]
    narration = "\n".join(paras)
    return title, narration


async def tts(text, voice, rate, mp3):
    """edge_tts 配音 + 拿句子级时间轴（7.x 返回 SentenceBoundary，不是 WordBoundary）"""
    import edge_tts
    comm = edge_tts.Communicate(text, voice=voice, rate=rate)
    segs = []
    with open(mp3, "wb") as f:
        async for ch in comm.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] in ("SentenceBoundary", "WordBoundary"):
                segs.append((ch["offset"] / 1e7, ch["duration"] / 1e7, ch["text"], ch["type"]))
    return segs


def split_cjk(txt, max_chars):
    """长句再切：优先在标点处断，其次按长度硬切"""
    out, buf = [], ""
    for ch in txt:
        buf += ch
        if (ch in "，。！？；、,.!?;" and len(buf) >= max_chars * 0.6) or len(buf) >= max_chars:
            out.append(buf)
            buf = ""
    if buf:
        if out and len(buf) <= 3:
            out[-1] += buf
        else:
            out.append(buf)
    return out


def build_cues(events, max_chars=16):
    """句子边界优先；超长句按字数比例再切，保证一行不超屏"""
    cues = []
    for s, d, txt, kind in events:
        end = s + d
        if len(txt) <= max_chars:
            cues.append((s, end + 0.12, txt))
            continue
        chunks = split_cjk(txt, max_chars)
        total_len = sum(len(c) for c in chunks) or 1
        acc = s
        for c in chunks:
            seg = d * len(c) / total_len
            cues.append((acc, acc + seg + 0.05, c))
            acc += seg
    return cues


def write_ass(cues, path):
    def t(x):
        h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
        return "%d:%02d:%05.2f" % (h, m, s)
    prim = "&H00FFFFFF&"
    out_c = "&H40000000&"
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}",
             "ScaledBorderAndShadow: yes", "WrapStyle: 0", "",
             "[V4+ Styles]",
             "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic,"
             " Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,"
             " Alignment, MarginL, MarginR, MarginV",
             f"Style: Default,Microsoft YaHei,{FONT_SIZE},{prim},{out_c},&H20000000&,1,0,0,0,100,100,1,0,1,3,1,2,60,60,40",
             "", "[Events]",
             "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    y = int(H * SUB_Y_RATIO)
    for s, e, txt in cues:
        esc = txt.replace("{", "(").replace("}", ")")
        lines.append(f"Dialogue: 0,{t(s)},{t(e)},Default,,0,0,0,,{{\\pos({W//2},{y})}}{esc}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def parse_cover_title(script):
    """从口播稿「## 封面文字」块取 主标题/副标题；没有则用文章标题兜底。
    标题随片而异 → 生成的封面随片而异，杜绝封面重复。"""
    import re as _re
    try:
        raw = open(script, encoding="utf-8").read()
    except Exception:
        return "封面", ""
    m = _re.search(r"主标题\*\*[:：]\s*(\S+)", raw)
    t = m.group(1).strip() if m else ""
    m2 = _re.search(r"副标题\*\*[:：]\s*(\S+)", raw)
    s = m2.group(1).strip() if m2 else ""
    if not t:  # 无封面块则取口播稿首行 # 标题
        mh = _re.search(r"^#\s*(.+)$", raw, _re.M)
        t = (mh.group(1).strip() if mh else "封面")
    if len(t) > 12:
        t = t[:12]
    return t, s


def _day_seed(day):
    """按日期确定性种子：同一天重生成画面/纹理完全一致（稳定不跳变），
    不同天种子不同 → 底片组合与每段纹理都不同（每日差异化）。"""
    import hashlib
    return int(hashlib.md5(("kuaishou-channels-" + day).encode()).hexdigest()[:8], 16)


def pick_clips(style, n, day):
    """按日期种子从底片池确定性抽 n 段：同一天稳定、天与天不同。池按 style 选 warm/cold。"""
    d = os.path.join(KS_ASSETS, "vid_warm" if style == "warm" else "vid_cold")
    files = [os.path.join(d, x) for x in os.listdir(d) if x.lower().endswith((".mp4", ".mov"))]
    if not files:
        raise SystemExit("底片目录为空: %s" % d)
    rng = random.Random(_day_seed(day))   # 确定性：同一天结果可复现，天与天不同
    rng.shuffle(files)
    return [files[i % len(files)] for i in range(n)]


def make_seg(src, dur, dst, var=None):
    """横屏底片 -> 1080x1920 竖屏：模糊背景铺满 + 原片居中偏上。
    var（纹理变体）让每个画面段落质感不同：背景虚化/明暗/对比/饱和/前景大小/
    构图位置各不相同，统一用稳定滤镜（gblur+eq+scale+overlay），warm 池整体偏暖。"""
    if not var:
        var = {"bg_blur": 26, "bright": -0.07, "contrast": 1.0, "sat": 1.0,
               "fg_scale": 1.0, "fg_dy": -70}
    bg_blur = int(var.get("bg_blur", 26))
    bright = var.get("bright", -0.07)
    contrast = var.get("contrast", 1.0)
    sat = var.get("sat", 1.0)
    fg_w = int(W * var.get("fg_scale", 1.0))
    fg_dy = int(var.get("fg_dy", -70))
    fc = (
        f"[0:v]split=2[b0][f0];"
        f"[b0]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
        f"gblur=sigma={bg_blur},"
        f"eq=brightness={bright:.3f}:contrast={contrast:.3f}:saturation={sat:.3f}[b];"
        f"[f0]scale={fg_w}:-2:flags=bicubic[f];"
        f"[b][f]overlay=(W-w)/2:(H-h)/2{fg_dy}"
    )
    run([FFMPEG, "-y", "-i", src, "-t", f"{dur:.2f}", "-filter_complex", fc,
         "-r", str(FPS), "-an", "-c:v", "libx264", "-preset", "fast",
         "-b:v", BITRATE, "-pix_fmt", "yuv420p", dst])


def make_seg_variants(day, n, warm=True):
    """为每个画面段落（子页面）生成不同纹理参数，日期种子+段索引确定性生成。
    同一天重生成完全一致（画面稳定不跳变）；天与天种子不同 → 每段纹理都不同。
    段落之间在背景虚化/明暗/对比/饱和/前景大小/构图上做差异，避免同一片素材反复铺满。"""
    out = []
    for i in range(n):
        r = random.Random(_day_seed(day) * 31 + i)   # 段级确定性
        out.append({
            "bg_blur": r.randint(18, 34),
            "bright": round(r.uniform(-0.06, 0.03), 3),
            "contrast": round(r.uniform(1.0, 1.12), 3),
            "sat": round(r.uniform(1.15, 1.32) if warm else r.uniform(0.95, 1.1), 3),
            "fg_scale": round(r.uniform(1.0, 1.14), 3),
            "fg_dy": r.randint(-150, -30),
        })
    return out


def pick_clips_ai(day, n_ai):
    """按日期种子（独立盐）从 vid_ai 独家池确定性抽 n_ai 段；池空返回 []。
    盐用 0x5F3A 与免费池抽卡错开 → 独家镜头的抽选/位置天天不同。"""
    d = os.path.join(KS_ASSETS, "vid_ai")
    if n_ai <= 0 or not os.path.isdir(d):
        return []
    files = [os.path.join(d, x) for x in os.listdir(d)
             if x.lower().endswith((".mp4", ".mov"))]
    if not files:
        return []
    rng = random.Random(_day_seed(day) ^ 0x5F3A)
    rng.shuffle(files)
    return [files[i % len(files)] for i in range(n_ai)]


def interleave(base, ai, day, nseg):
    """把独家镜头按日期种子确定的均匀间隔位置插入免费池序列（增强项）。
    ai 空则原样返回 base（兜底，不阻塞当日发布）；独家镜头分散不扎堆，位置随天变。"""
    if not ai:
        return list(base)
    m = len(ai)
    step = max(1, nseg // m)
    off = _day_seed(day) % nseg
    slots = sorted(set((off + i * step) % nseg for i in range(m)))
    out = list(base)
    for idx, pos in enumerate(slots[:m]):
        out[pos % nseg] = ai[idx]
    return out


def concat(segs, dst):
    lst = dst + ".txt"
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            f.write("file '%s'\n" % s.replace("\\", "/"))
    # 分段编码参数完全一致（同 preset/fast, 同 pix_fmt, 同 WxH, 同 FPS, 无音轨），
    # 可直接 -c copy 拼接，避免全片 H.264 重编一遍（原 ~3-5 分钟可省掉）
    run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst,
         "-c", "copy", "-movflags", "+faststart", dst])
    os.remove(lst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("--voice", default="zh-CN-YunyangNeural")
    ap.add_argument("--style", default="warm", choices=["cold", "warm"])
    ap.add_argument("--rate", default="+5%")
    ap.add_argument("--ai", type=int, default=2,
                    help="增强项：从 vid_ai 独家池按日期种子穿插 N 段独家镜头（默认 2=开）；池空自动退回纯免费池，不阻塞。")
    args = ap.parse_args()

    today = datetime.date.today().strftime("%Y%m%d")
    day = today                                # 种子基准=今天；同日重生成画面稳定，天与天不同
    title, narration = parse_script(args.script)
    print("[1/6] 稿子解析完成，正文 %d 字" % len(narration))

    os.makedirs(OUT_ROOT, exist_ok=True)
    done = [d for d in os.listdir(OUT_ROOT) if re.match(r"^%s_\d+$" % today, d)]
    n = len(done) + 1
    out_dir = os.path.join(OUT_ROOT, "%s_%02d" % (today, n))
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "_tmp")
    os.makedirs(tmp, exist_ok=True)

    mp3 = os.path.join(tmp, "voice.mp3")
    words = asyncio.run(tts(narration, args.voice, args.rate, mp3))
    duration = words[-1][0] + words[-1][1] if words else 0
    total = duration + TAIL
    print("[2/6] 配音完成 %.1fs（%d 词）" % (duration, len(words)))

    cues = build_cues(words)
    ass = os.path.join(tmp, "subs.ass")
    write_ass(cues, ass)
    print("[3/6] 字幕 %d 句" % len(cues))

    seg_dur = 6.0
    nseg = max(3, int(total / seg_dur) + 1)
    clips = pick_clips(args.style, nseg, day)
    if args.ai > 0:
        ai_clips = pick_clips_ai(day, args.ai)
        if ai_clips:
            clips = interleave(clips, ai_clips, day, nseg)
            print("[4/6] 增强项：vid_ai 独家镜头穿插 %d 段（按日期种子定位，天与天不同）" % len(ai_clips))
        else:
            print("[4/6] 增强项：vid_ai 池为空 → 退回纯免费池（不阻塞当日发布）")
    variants = make_seg_variants(day, nseg, warm=(args.style == "warm"))
    segs = []
    for i, c in enumerate(clips):
        dst = os.path.join(tmp, "seg_%03d.mp4" % i)
        make_seg(c, seg_dur, dst, var=variants[i])
        segs.append(dst)
    print("[4/6] 底片 %d 段已转竖屏" % len(segs))

    silent = os.path.join(tmp, "silent.mp4")
    concat(segs, silent)

    bgm = os.path.join(KS_ASSETS, "music", "cold.mp3" if args.style == "cold" else "warm.mp3")
    final = os.path.join(out_dir, "视频号.mp4")
    # Windows 路径里的冒号必须转义，否则 ffmpeg 把 C: 当成 original_size 参数
    ass_f = ass.replace("\\", "/").replace(":", "\\:")
    fc = (f"[0:v]ass='{ass_f}'[v];"
          f"[2:a]volume=0.12[bgm];"
          f"[1:a][bgm]amix=inputs=2:duration=first[a]")
    run([FFMPEG, "-y", "-i", silent, "-i", mp3, "-stream_loop", "-1", "-i", bgm,
         "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
         "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "fast", "-b:v", BITRATE,
         "-r", str(FPS), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", final])
    print("[5/6] 合成完成")

    for s in segs:
        try:
            os.remove(s)
        except OSError:
            pass
    with open(os.path.join(out_dir, "caption.txt"), "w", encoding="utf-8") as f:
        f.write(title + "\n")
    print("[6/6] 输出: %s" % final)

    # [7] 生成本片唯一封面（真实帧 + 本片标题，标题各异 → 封面不重复）
    cover_path = os.path.join(out_dir, "cover.png")
    try:
        ct, cs = parse_cover_title(args.script)
        subprocess.run([sys.executable, os.path.join(BASE, "_channels_cover.py"),
                        final, ct, "--subtitle", cs, "--tag", "民生观察",
                        "--out", cover_path],
                       capture_output=True, text=True, encoding="utf-8", errors="ignore")
        if os.path.exists(cover_path):
            print("[7/7] 封面已生成: %s" % cover_path)
        else:
            print("[7/7] 封面生成未落盘，发表时退回平台自动抽帧")
    except Exception as e:
        print("[7/7] 封面生成失败(不阻塞):", str(e)[:150])

    print("OK", final)


if __name__ == "__main__":
    main()
