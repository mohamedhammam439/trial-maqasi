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


# Reference objects (long x short side, cm) for scale tests.
A4 = (29.7, 21.0)
CARD = (8.56, 5.398)


def render(px_per_cm=30.0, tilt_deg=0.0, rotate_deg=0.0, noise=6.0, light_grad=0.25,
           bg=(205, 208, 206), fg=(40, 60, 150), size=(3000, 4000), cam_height_cm=110.0, seed=0):
    """Return (bgr_image, true px_per_cm at the shirt centre)."""
    img, s, _ = render_with_ref(px_per_cm, tilt_deg, rotate_deg, noise, light_grad, bg, fg, size, cam_height_cm, seed)
    return img, s


def render_with_ref(px_per_cm=30.0, tilt_deg=0.0, rotate_deg=0.0, noise=6.0, light_grad=0.25,
                    bg=(205, 208, 206), fg=(40, 60, 150), size=(3000, 4000), cam_height_cm=110.0, seed=0,
                    ref=None, ref_at=(0.0, 50.0), ref_angle_deg=0.0, ref_color=(250, 250, 250)):
    """Like render(), plus an optional flat rectangle `ref` = (w_cm, h_cm) lying on the floor,
    centred at `ref_at` (cm, shirt centre = origin, y down), rotated by ref_angle_deg.
    Returns (bgr_image, true px_per_cm at the shirt centre, ref corners in image px or None)."""
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

    def project(points):
        out = []
        for X, Y in points:
            # camera at height H over the floor, tilted by t toward +Y
            xc = X
            yc = Y * math.cos(t) - cam_height_cm * math.sin(t)
            zc = Y * math.sin(t) + cam_height_cm * math.cos(t)
            out.append((w / 2 + f * xc / zc, h / 2 + f * yc / zc))
        return np.array(out, dtype=np.float64)

    poly = project(pts).astype(np.int32)
    ref_px = None
    if ref is not None:
        rw, rh = ref
        a = math.radians(ref_angle_deg)
        R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        box = np.array([(-rw / 2, -rh / 2), (rw / 2, -rh / 2), (rw / 2, rh / 2), (-rw / 2, rh / 2)]) @ R.T
        ref_px = project(box + np.array(ref_at))

    img = np.zeros((h, w, 3), np.float32)
    img[:] = bg
    shirt = np.zeros((h, w), np.uint8)
    cv2.fillPoly(shirt, [poly], 255)
    img[shirt > 0] = fg
    if ref_px is not None:
        paper = np.zeros((h, w), np.uint8)
        cv2.fillPoly(paper, [np.round(ref_px * 16).astype(np.int32)], 255, shift=4)
        alpha = (paper.astype(np.float32) / 255)[:, :, None]
        img = img * (1 - alpha) + np.array(ref_color, np.float32) * alpha
    # soft fabric texture + lighting gradient + sensor noise + slight blur
    gy = np.linspace(1 - light_grad / 2, 1 + light_grad / 2, h)[:, None, None]
    img *= gy
    img += rng.normal(0, noise, img.shape)
    img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (5, 5), 0)
    return img, px_per_cm, ref_px


def render_with_aruco(px_per_cm=12.0, ref_at=(0.0, 0.0), ref_angle_deg=0.0, tilt_deg=0.0, size=(1080, 1440), seed=0):
    """Shirt photo with the printed ArUco sheet (app/aruco_sheet.py) lying flat at ref_at.
    Returns (bgr_image, true px_per_cm at the shirt centre, paper corners in image px)."""
    from app import aruco_sheet

    w_cm, h_cm = (v / 10 for v in aruco_sheet.SHEET_MM)
    img, s, paper = render_with_ref(px_per_cm=px_per_cm, tilt_deg=tilt_deg, size=size, seed=seed,
                                    ref=(w_cm, h_cm), ref_at=ref_at, ref_angle_deg=ref_angle_deg)
    sheet = cv2.cvtColor(aruco_sheet.render_sheet(dpi=150), cv2.COLOR_BGR2GRAY)
    sh, sw = sheet.shape
    H = cv2.getPerspectiveTransform(np.float32([(0, 0), (sw, 0), (sw, sh), (0, sh)]), paper.astype(np.float32))
    warped = cv2.warpPerspective(sheet, H, (size[0], size[1]), flags=cv2.INTER_AREA, borderValue=255)
    warped = cv2.GaussianBlur(warped, (3, 3), 0).astype(np.float32) / 255
    out = (img.astype(np.float32) * warped[:, :, None]).clip(0, 255).astype(np.uint8)
    return out, s, paper
