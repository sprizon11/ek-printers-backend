"""
Remove dark pixels that sit on the boundary of transparency (common after studio-bg
removal). This reduces visible rectangular halos on dark-themed UIs.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


PUBLIC = Path(__file__).resolve().parent.parent / "public"
FILES = sorted([*PUBLIC.glob("bc-*.png"), *PUBLIC.glob("ht-*.png")])


def luma(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)
    return 0.299 * r + 0.587 * g + 0.114 * b


def peel_edges(rgba: np.ndarray, *, luma_thresh: float = 68.0, max_iter: int = 48) -> np.ndarray:
    im = rgba.copy()
    h, w = im.shape[:2]
    for _ in range(max_iter):
        a = im[..., 3].astype(np.uint16)
        if not np.any(a > 0):
            break
        lu = luma(im[..., :3])
        # transparent neighbor (4-connectivity)
        up = np.zeros_like(a)
        down = np.zeros_like(a)
        left = np.zeros_like(a)
        right = np.zeros_like(a)
        if h > 1:
            up[1:, :] = a[:-1, :]
            down[:-1, :] = a[1:, :]
        if w > 1:
            left[:, 1:] = a[:, :-1]
            right[:, :-1] = a[:, 1:]
        neigh_t = (up == 0) | (down == 0) | (left == 0) | (right == 0)
        kill = (a > 0) & neigh_t & (lu < luma_thresh)
        if not np.any(kill):
            break
        im[kill] = 0
    return im


def main() -> None:
    for path in FILES:
        img = Image.open(path).convert("RGBA")
        arr = np.array(img)
        out = peel_edges(arr)
        Image.fromarray(out).save(path, format="PNG", optimize=True)
        print(path.name, "ok")


if __name__ == "__main__":
    main()
