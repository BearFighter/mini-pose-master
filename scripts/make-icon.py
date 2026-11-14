# SPDX-License-Identifier: GPL-3.0-or-later
"""Draws the app icon (build/icon.png, 1024x1024): an artist's mannequin in a sword pose on a round
miniature base. Original artwork, made from signed-distance shapes; numpy + zlib only.

  python scripts/make-icon.py
"""
import os
import struct
import zlib

import numpy as np

N = 1024
SS = 3  # supersampling per axis for anti-aliasing
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ys, xs = np.mgrid[0:N * SS, 0:N * SS].astype(np.float64)
X, Y = (xs + 0.5) / SS, (ys + 0.5) / SS


def cover(d):
    """Coverage from a signed distance in pixels (inside < 0)."""
    return np.clip(0.5 - d, 0.0, 1.0)


def capsule(a, b, r):
    ax, ay = a
    bx, by = b
    px, py = X - ax, Y - ay
    vx, vy = bx - ax, by - ay
    t = np.clip((px * vx + py * vy) / (vx * vx + vy * vy), 0.0, 1.0)
    return np.hypot(px - t * vx, py - t * vy) - r


def circle(c, r):
    return np.hypot(X - c[0], Y - c[1]) - r


def ellipse(c, rx, ry):
    k = np.hypot((X - c[0]) / rx, (Y - c[1]) / ry)
    return (k - 1.0) * min(rx, ry)


def rbox(c, hw, hh, r):
    qx = np.abs(X - c[0]) - (hw - r)
    qy = np.abs(Y - c[1]) - (hh - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def union(*ds):
    return np.minimum.reduce(ds)


def rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


img = np.zeros((N * SS, N * SS, 4))


CLIP = None  # everything after the background stays inside the rounded square


def paint(d, color, alpha=1.0):
    a = cover(d) * alpha
    if CLIP is not None:
        a = a * CLIP
    a = a[..., None]
    c = color if np.ndim(color) == 3 else np.broadcast_to(color, img[..., :3].shape)
    img[..., :3] = img[..., :3] * (1 - a) + c * a
    img[..., 3:] = img[..., 3:] * (1 - a) + a


# background: rounded square, vertical gradient
t = (Y / N)[..., None]
bg = rgb("#24456b") * (1 - t) + rgb("#0e1a2b") * t
BG = rbox((512, 512), 470, 470, 200)
paint(BG, bg)
CLIP = cover(BG + 6)

# round miniature base: side band, top face, rim highlight
paint(union(ellipse((512, 880), 300, 72), rbox((512, 863), 300, 17, 0.5)), rgb("#6b5537"))
top = (Y / N)[..., None]
paint(ellipse((512, 846), 300, 72), rgb("#c8a46a") * (1.2 - top) + rgb("#9c7c4c") * (top - 0.2))
paint(np.abs(ellipse((512, 846), 296, 69)) - 2.5, rgb("#ecd49e"), alpha=0.8)
# contact shadow under the feet
paint(ellipse((520, 846), 210, 34), rgb("#3a2c1a"), alpha=0.35)

# mannequin (viewer's left = figure's right)
J = {
    "pelvis": (512, 590), "chest": (505, 470), "neck": (498, 398), "head": (490, 330),
    "sh_r": (442, 425), "el_r": (372, 345), "ha_r": (330, 258),
    "sh_l": (568, 425), "el_l": (632, 505), "ha_l": (608, 585),
    "hip_r": (480, 605), "kn_r": (420, 712), "ft_r": (372, 820),
    "hip_l": (548, 605), "kn_l": (648, 700), "ft_l": (700, 818),
}
skin = rgb("#eef2f0")
shade = rgb("#b9c6cc")
body = union(
    capsule(J["pelvis"], J["chest"], 50), capsule(J["chest"], J["neck"], 46), capsule(J["neck"], J["head"], 20),
    circle(J["head"], 50),
    capsule(J["sh_r"], J["el_r"], 23), capsule(J["el_r"], J["ha_r"], 20), circle(J["ha_r"], 24),
    capsule(J["sh_l"], J["el_l"], 23), capsule(J["el_l"], J["ha_l"], 20), circle(J["ha_l"], 24),
    capsule(J["hip_r"], J["kn_r"], 28), capsule(J["kn_r"], J["ft_r"], 23), capsule(J["ft_r"], (342, 828), 18),
    capsule(J["hip_l"], J["kn_l"], 28), capsule(J["kn_l"], J["ft_l"], 23), capsule(J["ft_l"], (735, 826), 18),
    capsule(J["sh_r"], J["sh_l"], 30), capsule(J["hip_r"], J["hip_l"], 34),
)
# sword in the raised hand, behind the fingers
blade = capsule((318, 236), (204, 96), 13)
paint(blade, rgb("#9fd4e0"))
paint(capsule((316, 232), (210, 102), 4), rgb("#e8f8fb"), alpha=0.9)
paint(capsule((282, 286), (378, 214), 12), rgb("#d4a64a"))  # crossguard
paint(capsule((330, 258), (352, 288), 10), rgb("#7a5a2e"))  # grip end

# body with a soft light from the upper left
light = np.clip(((X - 520) * -0.6 + (Y - 450) * -0.8) / 520 + 0.55, 0, 1)[..., None]
paint(body, skin * light + shade * (1 - light))
# joint dots: the mannequin's articulation
for k in ("el_r", "el_l", "kn_r", "kn_l", "sh_r", "sh_l"):
    paint(circle(J[k], 9), rgb("#8fa3ad"), alpha=0.9)
paint(circle(J["ha_r"], 24), skin * 0.95)  # fingers over the grip

# downsample, write PNG
out = img.reshape(N, SS, N, SS, 4).mean(axis=(1, 3))
px = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


def png(path, a):
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
png(os.path.join(ROOT, "build", "icon.png"), px)
print("wrote build/icon.png")
