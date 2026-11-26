"""Scale references: turn a known-size object in the photo into px per cm.

Supported references (the `type` field of the `reference` JSON sent to /measure):

  tape    two points a known distance apart, e.g. 0 and 50 on a tape measure
          {"type": "tape", "p1": [x, y], "p2": [x, y], "cm": 50}
  a4      an A4 sheet (21.0 x 29.7 cm) lying flat next to the garment
  card    a bank / ID card, ISO/IEC 7810 ID-1 (8.56 x 5.398 cm)
  rect    any other flat rectangle of known size: add "w_cm" and "h_cm"
  aruco   the printable A4 sheet with four ArUco markers (app/aruco_sheet.py); always found by the server

For a4 / card / rect, send the 4 corners in image pixels (any order):
          {"type": "card", "corners": [[x, y], [x, y], [x, y], [x, y]]}
Tapped corners are snapped to the object's real edges ("snap": false turns that off),
or leave "corners" out and the server looks for the rectangle itself.

All coordinates are in the ORIGINAL image's pixels.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math

import cv2
import numpy as np

from .measure import MeasureError, px_per_cm_from_calibration

# Known rectangles: (long side, short side) in cm.
KNOWN_RECTS: dict[str, tuple[float, float]] = {
    "a4": (29.7, 21.0),
    "card": (8.56, 5.398),
}
LABELS = {"tape": "المتر", "a4": "ورقة A4", "card": "الكارت", "rect": "المرجع", "aruco": "ورقة الـ ArUco"}

ASPECT_TOL = 0.08           # corners whose aspect is off by more than this are rejected
SMALL_REF_PX = 250          # long side under this many px -> accuracy warning
DETECT_WORK_SIDE = 1600     # resolution used for automatic rectangle detection


@dataclass
class Reference:
    type: str
    px_per_cm: float
    corners: list[list[float]] | None = None    # rectangles: ordered corners (image px)
    points: list[list[float]] | None = None     # tape: the two points (image px)
    size_cm: tuple[float, float] | None = None  # rectangles: (long, short)
    detected: bool = False                      # True when the server found the corners itself
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {"type": self.type, "px_per_cm": self.px_per_cm, "detected": self.detected}
        if self.corners is not None:
            d["corners"] = self.corners
            d["size_cm"] = list(self.size_cm)
        if self.points is not None:
            d["points"] = self.points
        return d


# ---------------------------------------------------------------- geometry
def order_corners(pts) -> np.ndarray:
    """Order 4 points around their centroid (clockwise in image coords), starting top-left-ish."""
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if p.shape != (4, 2):
        raise MeasureError("محتاجين 4 أركان بالظبط للمرجع.")
    c = p.mean(axis=0)
    ang = np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0])
    p = p[np.argsort(ang)]
    start = int(np.argmin(p.sum(axis=1)))
    return np.roll(p, -start, axis=0)


def px_per_cm_from_rect(corners, long_cm: float, short_cm: float) -> tuple[float, float]:
    """Return (px_per_cm, aspect error) for a quadrilateral that shows a long_cm x short_cm rectangle.

    Opposite sides are averaged, which cancels most of the foreshortening from a small tilt.
    """
    if long_cm <= 0 or short_cm <= 0:
        raise MeasureError("مقاس المرجع لازم يكون أكبر من صفر.")
    if short_cm > long_cm:
        long_cm, short_cm = short_cm, long_cm
    q = order_corners(corners)
    sides = [float(np.linalg.norm(q[(i + 1) % 4] - q[i])) for i in range(4)]
    pair_a = (sides[0] + sides[2]) / 2
    pair_b = (sides[1] + sides[3]) / 2
    long_px, short_px = max(pair_a, pair_b), min(pair_a, pair_b)
    if short_px < 20:
        raise MeasureError("المرجع صغير أوي في الصورة. قرّب الموبايل أو استخدم مرجع أكبر.")
    aspect_err = abs((long_px / short_px) / (long_cm / short_cm) - 1)
    return (long_px / long_cm + short_px / short_cm) / 2, aspect_err


# ---------------------------------------------------------------- auto-detect
def detect_rect(img_bgr: np.ndarray, long_cm: float, short_cm: float) -> np.ndarray:
    """Find a flat rectangle with the given aspect ratio. Returns 4 corners in image px."""
    h, w = img_bgr.shape[:2]
    s = min(1.0, DETECT_WORK_SIDE / max(h, w))
    small = cv2.resize(img_bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img_bgr
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    edges = cv2.Canny(gray, 30, 90)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    target = long_cm / short_cm
    img_area = small.shape[0] * small.shape[1]
    best, best_score = None, None
    for c in contours:
        area = cv2.contourArea(c)
        if area < img_area * 0.0004 or area > img_area * 0.5:
            continue
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        q = order_corners(approx.reshape(4, 2))
        sides = [np.linalg.norm(q[(i + 1) % 4] - q[i]) for i in range(4)]
        a, b = (sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2
        if min(a, b) < 10:
            continue
        aspect_err = abs((max(a, b) / min(a, b)) / target - 1)
        # how rectangular: filled area vs. the min-area box around it
        (_, (bw, bh), _) = cv2.minAreaRect(approx)
        rectangularity = area / max(bw * bh, 1e-6)
        if aspect_err > ASPECT_TOL or rectangularity < 0.85:
            continue
        # dilated edges give an inner and an outer contour for each object: prefer the larger one
        score = (aspect_err, -area)
        if best_score is None or score < best_score:
            best, best_score = q, score
    if best is None:
        raise MeasureError("مش لاقيين المرجع في الصورة. حطّه مفرود على الأرض جنب القطعة، أو حدّد أركانه الأربعة بإيدك.")
    return refine_corners(img_bgr, best / s)


def _intersect(l1, l2):
    (vx1, vy1, x1, y1), (vx2, vy2, x2, y2) = l1, l2
    A = np.array([[vx1, -vx2], [vy1, -vy2]])
    t = np.linalg.solve(A, np.array([x2 - x1, y2 - y1]))
    return np.array([x1 + t[0] * vx1, y1 + t[0] * vy1])


def refine_corners(img_bgr: np.ndarray, quad: np.ndarray, max_shift: float = 0.05) -> np.ndarray:
    """Sub-pixel corners: threshold a window around the rough quad at full resolution,
    fit a straight line to each side of the object's outline, and intersect the lines.
    The threshold sits half-way between object and floor, i.e. on the true edge.
    max_shift: how far (fraction of the long side) a corner may move; larger for finger taps."""
    q = order_corners(quad)
    side = max(np.linalg.norm(q[(i + 1) % 4] - q[i]) for i in range(4))
    pad = int((0.1 + max_shift) * side) + 4
    h, w = img_bgr.shape[:2]
    x0, y0 = max(0, int(q[:, 0].min()) - pad), max(0, int(q[:, 1].min()) - pad)
    x1, y1 = min(w, int(q[:, 0].max()) + pad), min(h, int(q[:, 1].max()) + pad)
    roi = cv2.cvtColor(img_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    local = q - [x0, y0]
    centre_f = local.mean(axis=0)
    centre = tuple(map(int, centre_f))
    # Threshold half-way between the object (inside the shrunk quad) and the floor right around it,
    # using medians so a garment touching the window doesn't drag the threshold.
    inner = np.zeros(roi.shape, np.uint8)
    cv2.fillPoly(inner, [np.round(centre_f + 0.8 * (local - centre_f)).astype(np.int32)], 255)
    ring_out = np.zeros(roi.shape, np.uint8)
    cv2.fillPoly(ring_out, [np.round(centre_f + 1.12 * (local - centre_f)).astype(np.int32)], 255)
    ring_in = np.zeros(roi.shape, np.uint8)
    cv2.fillPoly(ring_in, [np.round(centre_f + 1.04 * (local - centre_f)).astype(np.int32)], 255)
    ring = (ring_out > 0) & (ring_in == 0)
    if not ring.any() or not (inner > 0).any():
        return q
    v_in, v_out = float(np.median(roi[inner > 0])), float(np.median(roi[ring]))
    if abs(v_in - v_out) < 8:
        return q
    thr = (v_in + v_out) / 2
    bw = ((roi > thr) if v_in > v_out else (roi < thr)).astype(np.uint8) * 255
    # keep only the window around the quad so other objects don't merge into the outline
    bw[ring_out == 0] = 0
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    inside = [c for c in contours if cv2.pointPolygonTest(c, centre, False) >= 0]
    if not inside:
        return q
    pts = max(inside, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    lines = []
    for i in range(4):
        a, b = local[i], local[(i + 1) % 4]
        d = b - a
        L = np.linalg.norm(d)
        n = np.array([-d[1], d[0]]) / L
        t = (pts - a) @ (d / L)
        dist = np.abs((pts - a) @ n)
        # points along the middle 80% of this side, close to it
        sel = pts[(t > 0.15 * L) & (t < 0.85 * L) & (dist < max(3.0, (max_shift + 0.02) * L))]
        if len(sel) < 5:
            return q
        lines.append(cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel())
    try:
        refined = np.array([_intersect(lines[(i - 1) % 4], lines[i]) for i in range(4)])
    except np.linalg.LinAlgError:
        return q
    if np.abs(refined - local).max() > max_shift * side + 4:  # refinement wandered off: keep the rough quad
        return q
    # a pixel-boundary contour sits on pixel centres of the object's outer pixels: shift out by half a pixel
    c = refined.mean(axis=0)
    refined = refined + 0.5 * np.sign(refined - c)
    return refined + [x0, y0]


# ---------------------------------------------------------------- entry point
def resolve(ref: dict, img_bgr: np.ndarray | None = None) -> Reference:
    """Turn the `reference` JSON from the client into a px_per_cm (+ warnings for the user)."""
    if not isinstance(ref, dict):
        raise MeasureError("بيانات المرجع غلط.")
    kind = ref.get("type", "tape")

    if kind == "tape":
        try:
            p1, p2, cm = tuple(ref["p1"]), tuple(ref["p2"]), float(ref["cm"])
        except (KeyError, TypeError, ValueError):
            raise MeasureError("المتر محتاج نقطتين والمسافة بينهم بالسنتيمتر.")
        return Reference("tape", px_per_cm_from_calibration(p1, p2, cm), points=[list(p1), list(p2)])

    if kind == "aruco":
        if img_bgr is None:
            raise MeasureError("ورقة الـ ArUco محتاجة الصورة.")
        return aruco_reference(img_bgr)

    if kind in KNOWN_RECTS:
        long_cm, short_cm = KNOWN_RECTS[kind]
    elif kind == "rect":
        try:
            long_cm, short_cm = sorted((float(ref["w_cm"]), float(ref["h_cm"])), reverse=True)
        except (KeyError, TypeError, ValueError):
            raise MeasureError("المرجع المخصص محتاج الطول والعرض بالسنتيمتر.")
    else:
        raise MeasureError(f"نوع المرجع مش معروف: {kind}")

    corners = ref.get("corners")
    detected = False
    if corners is None:
        if img_bgr is None:
            raise MeasureError("محتاجين أركان المرجع.")
        corners = detect_rect(img_bgr, long_cm, short_cm)
        detected = True
    elif ref.get("snap", True) and img_bgr is not None:
        # A finger tap on a phone screen is several image pixels off; snap to the real edges.
        corners = refine_corners(img_bgr, order_corners(corners), max_shift=0.12)
    q = order_corners(corners)
    px_per_cm, aspect_err = px_per_cm_from_rect(q, long_cm, short_cm)

    label = LABELS[kind]
    if aspect_err > ASPECT_TOL:
        raise MeasureError(
            f"شكل {label} في الصورة مش مطابق لمقاسه. اتأكد إن الأركان الأربعة صح وإنه مفرود ومش متني.")
    warnings = []
    if long_cm * px_per_cm < SMALL_REF_PX or kind == "card":
        err_cm = 55 * 1.0 / (long_cm * px_per_cm) * 2  # ~1 px error at each end, on a 55 cm chest
        warnings.append(
            f"{label} صغير في الصورة، فالقياس ممكن يغلط لحد ±{max(err_cm, 0.3):.1f} سم تقريباً. "
            "للدقة الأعلى استخدم ورقة A4 أو المتر.")
    return Reference(kind, px_per_cm, corners=q.round(1).tolist(), size_cm=(long_cm, short_cm),
                     detected=detected, warnings=warnings)


def aruco_reference(img_bgr: np.ndarray) -> Reference:
    """Scale from the four ArUco markers' outer corners (sub-pixel); `corners` is the whole paper outline,
    so the sheet is left out of the garment outline like a plain A4."""
    from . import aruco_sheet

    outer, paper, _ = aruco_sheet.locate(img_bgr)
    long_cm, short_cm = aruco_sheet.OUTER_CM
    px_per_cm, aspect_err = px_per_cm_from_rect(outer, long_cm, short_cm)
    if aspect_err > ASPECT_TOL:
        raise MeasureError("ورقة الـ ArUco مش مفرودة كويس. افردها وصوّر تاني.")
    w, h = aruco_sheet.SHEET_MM
    return Reference("aruco", px_per_cm, corners=order_corners(paper).round(1).tolist(), size_cm=(h / 10, w / 10),
                     detected=True)
