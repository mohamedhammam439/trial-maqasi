"""Printable A4 scale sheet with four ArUco markers, and its detection.

Layout (mm, origin = top-left of the paper, y down): four 50 mm markers from DICT_4X4_50,
ids 0..3 at top-left, top-right, bottom-right, bottom-left, 15 mm from the paper edges.
Marker corners are found to sub-pixel accuracy, so the scale doesn't depend on how sharp the
paper's own edge is against the garment or the floor.

The sheet must be printed at 100% ("actual size"). A 100 mm check line is printed in the middle:
measure it with a ruler after printing.
"""
from __future__ import annotations

import cv2
import numpy as np

from .measure import MeasureError

SHEET_MM = (210.0, 297.0)          # w, h
MARKER_MM = 50.0
MARGIN_MM = 15.0
IDS = (0, 1, 2, 3)                 # top-left, top-right, bottom-right, bottom-left
DICT = cv2.aruco.DICT_4X4_50
CHECK_LINE_MM = 100.0

# The rectangle through the markers' outer corners: (long, short) in cm.
OUTER_CM = ((SHEET_MM[1] - 2 * MARGIN_MM) / 10, (SHEET_MM[0] - 2 * MARGIN_MM) / 10)


def _marker_origins() -> dict[int, tuple[float, float]]:
    w, h = SHEET_MM
    far_x, far_y = w - MARGIN_MM - MARKER_MM, h - MARGIN_MM - MARKER_MM
    return {0: (MARGIN_MM, MARGIN_MM), 1: (far_x, MARGIN_MM), 2: (far_x, far_y), 3: (MARGIN_MM, far_y)}


def marker_corners_mm() -> dict[int, np.ndarray]:
    """Each marker's 4 corners in mm, in ArUco's order (TL, TR, BR, BL of the marker)."""
    out = {}
    for i, (x, y) in _marker_origins().items():
        out[i] = np.array([(x, y), (x + MARKER_MM, y), (x + MARKER_MM, y + MARKER_MM), (x, y + MARKER_MM)], np.float64)
    return out


def outer_corners_mm() -> np.ndarray:
    """Outer corner of each marker (the rectangle OUTER_CM): TL of 0, TR of 1, BR of 2, BL of 3."""
    m = marker_corners_mm()
    return np.array([m[0][0], m[1][1], m[2][2], m[3][3]])


def render_sheet(dpi: int = 300) -> np.ndarray:
    """The printable sheet as a grayscale image at `dpi` (exactly A4 at that resolution)."""
    px = dpi / 25.4
    w, h = (int(round(v * px)) for v in SHEET_MM)
    img = np.full((h, w), 255, np.uint8)
    d = cv2.aruco.getPredefinedDictionary(DICT)
    side = int(round(MARKER_MM * px))
    for i, (x, y) in _marker_origins().items():
        m = cv2.aruco.generateImageMarker(d, i, side)
        x0, y0 = int(round(x * px)), int(round(y * px))
        img[y0:y0 + side, x0:x0 + side] = m
    # 100 mm check line with end ticks, centred
    cx, cy = w // 2, h // 2
    half = int(round(CHECK_LINE_MM / 2 * px))
    t = max(2, int(round(0.4 * px)))
    cv2.line(img, (cx - half, cy), (cx + half, cy), 0, t)
    for x in (cx - half, cx + half):
        cv2.line(img, (x, cy - int(4 * px)), (x, cy + int(4 * px)), 0, t)
    font = cv2.FONT_HERSHEY_SIMPLEX
    for text, dy in (("Maqasi scale sheet - print at 100% (actual size)", -int(12 * px)),
                     ("This line must measure exactly 10.0 cm", int(12 * px))):
        size = cv2.getTextSize(text, font, 1.6, 3)[0]
        cv2.putText(img, text, (cx - size[0] // 2, cy + dy), font, 1.6, 0, 3, cv2.LINE_AA)
    return img


_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        params = cv2.aruco.DetectorParameters()
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        params.cornerRefinementWinSize = 5
        _detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(DICT), params)
    return _detector


def detect(img_bgr: np.ndarray) -> dict[int, np.ndarray]:
    """Marker id -> its 4 corners in image px. Raises MeasureError unless all four sheet markers are found."""
    gray = img_bgr if img_bgr.ndim == 2 else cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = _get_detector().detectMarkers(gray)
    found = {}
    if ids is not None:
        for c, i in zip(corners, ids.ravel()):
            if int(i) in IDS:
                found[int(i)] = c.reshape(4, 2).astype(np.float64)
    missing = [i for i in IDS if i not in found]
    if missing:
        raise MeasureError(
            f"مش لاقيين ورقة الـ ArUco كاملة (ناقص {len(missing)} من 4 علامات). اتأكد إن الورقة كلها باينة ومفرودة.")
    return found


def locate(img_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Returns (outer marker rectangle corners, paper outline corners, homography reprojection error px),
    all in image px. The homography is fitted to all 16 marker corners."""
    found = detect(img_bgr)
    mm = marker_corners_mm()
    src = np.vstack([mm[i] for i in IDS])
    dst = np.vstack([found[i] for i in IDS])
    H, _ = cv2.findHomography(src, dst, 0)
    if H is None:
        raise MeasureError("مش قادرين نحدد مكان ورقة الـ ArUco.")
    proj = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    reproj = float(np.sqrt(np.mean(np.sum((proj - dst) ** 2, axis=1))))
    outer = np.array([found[0][0], found[1][1], found[2][2], found[3][3]])
    w, h = SHEET_MM
    paper = cv2.perspectiveTransform(np.array([[(0, 0), (w, 0), (w, h), (0, h)]], np.float64), H).reshape(-1, 2)
    return outer, paper, reproj
