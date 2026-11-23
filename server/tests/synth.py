"""Synthetic flat-lay t-shirt photos with known ground truth (cm).

The shirt is defined in cm (origin = top-centre, y down), drawn on a floor plane,
then photographed by a pinhole camera at height H, optionally tilted.
"""
import math

import cv2
import numpy as np

# Right half of the shirt outline in cm; mirrored for the left half.
RIGHT = [(9, 0), (23, 4), (38, 18), (33, 30), (26, 22), (25, 72)]
NECK_DIP = (0, 3)

GROUND_TRUTH = {
    # chest = 2.5 cm under armpit (26,22) on side seam (26,22)->(25,72)
    "chest_width": 2 * (26 - (2.5 / 50.0)),
    # hem = 2 cm above bottom (y=70)
    "hem_width": 2 * (26 - (48 / 50.0)),
    "body_length": 72.0,
    "sleeve_length": math.hypot(38 - 23, 18 - 4),
}


def outline_cm(scale=1.0):
    right = [(x * scale, y * scale) for x, y in RIGHT]
    left = [(-x, y) for x, y in reversed(right)]
    return np.array([(NECK_DIP[0], NECK_DIP[1] * scale)] + right + left, dtype=np.float64)


def render(px_per_cm=30.0, tilt_deg=0.0, rotate_deg=0.0, noise=6.0, light_grad=0.25,
           bg=(205, 208, 206), fg=(40, 60, 150), size=(3000, 4000), cam_height_cm=110.0, seed=0):
    """Return (bgr_image, true px_per_cm at the shirt centre)."""
    rng = np.random.default_rng(seed)
    w, h = size
    pts = outline_cm()
    pts[:, 1] -= 36  # centre the shirt vertically around its middle
    th = math.radians(rotate_deg)
    rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    pts = pts @ rot.T

    # Pinhole camera above the floor; focal length chosen so the centre scale == px_per_cm.
    f = px_per_cm * cam_height_cm
    t = math.radians(tilt_deg)
    out = []
    for X, Y in pts:
        # camera at height H over the floor, tilted by t toward +Y
        xc = X
        yc = Y * math.cos(t) - cam_height_cm * math.sin(t)
        zc = Y * math.sin(t) + cam_height_cm * math.cos(t)
        out.append((w / 2 + f * xc / zc, h / 2 + f * yc / zc))
    poly = np.array(out, dtype=np.int32)

    img = np.zeros((h, w, 3), np.float32)
    img[:] = bg
    shirt = np.zeros((h, w), np.uint8)
    cv2.fillPoly(shirt, [poly], 255)
    img[shirt > 0] = fg
    # soft fabric texture + lighting gradient + sensor noise + slight blur
    gy = np.linspace(1 - light_grad / 2, 1 + light_grad / 2, h)[:, None, None]
    img *= gy
    img += rng.normal(0, noise, img.shape)
    img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (5, 5), 0)
    return img, px_per_cm
