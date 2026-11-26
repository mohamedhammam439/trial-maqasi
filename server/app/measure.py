"""Flat-lay garment measurement (PoC).

Pipeline: segment the garment from a plain background -> find keypoints on the
mask -> convert pixel distances to cm with a known scale (px per cm).

Only t-shirts are supported in this PoC. Every value is in the ORIGINAL image's
pixel coordinates unless the name says _cm.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
import math

import cv2
import numpy as np

CHEST_BELOW_ARMPIT_CM = 2.5   # chest is measured just under the armpit
HEM_ABOVE_BOTTOM_CM = 2.0     # hem width is measured just above the bottom edge
WORK_MAX_SIDE = 1600          # processing resolution (keeps segmentation fast)


class MeasureError(Exception):
    """Raised when the photo can't be measured; message is user-facing."""


@dataclass
class Point:
    x: float
    y: float


@dataclass
class Line:
    name: str
    a: Point
    b: Point
    cm: float
    confidence: str = "high"  # high | low


@dataclass
class Result:
    garment: str
    px_per_cm: float
    image_size: tuple[int, int]
    lines: list[Line] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["measurements_cm"] = {ln.name: round(ln.cm, 1) for ln in self.lines}
        return d


# ---------------------------------------------------------------- segmentation
EXCLUDE_GROW = 1.08          # exclusion polygons are grown by this factor around their centre ...
EXCLUDE_PAD_PX = 6           # ... plus this many work px, so the object's shadow goes too


def segment(img_bgr: np.ndarray, exclude: list | None = None) -> tuple[np.ndarray, float]:
    """Return (mask at work resolution, work_scale = work_px / original_px).
    exclude: polygons (original image px) to cut out of the mask, e.g. the A4 sheet next to the garment,
    so a reference lying close to the garment can't merge into its outline."""
    h, w = img_bgr.shape[:2]
    s = min(1.0, WORK_MAX_SIDE / max(h, w))
    small = cv2.resize(img_bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img_bgr.copy()
    small = cv2.GaussianBlur(small, (5, 5), 0)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)

    # Background model: a smooth (planar) colour field fitted to a border frame, so uneven
    # lighting across the floor doesn't eat into the garment edges.
    H, W = lab.shape[:2]
    bw = max(4, int(min(H, W) * 0.02))
    frame = np.zeros((H, W), bool)
    frame[:bw] = frame[-bw:] = True
    frame[:, :bw] = frame[:, -bw:] = True
    yy, xx = np.nonzero(frame)
    A = np.stack([np.ones_like(xx), xx / W, yy / H, (xx / W) * (yy / H)], axis=1).astype(np.float32)
    coef, *_ = np.linalg.lstsq(A, lab[yy, xx], rcond=None)
    gy, gx = np.mgrid[0:H, 0:W]
    basis = np.stack([np.ones((H, W)), gx / W, gy / H, (gx / W) * (gy / H)], axis=2).astype(np.float32)
    bg_field = basis @ coef
    dist = np.linalg.norm(lab - bg_field, axis=2)
    dist8 = cv2.normalize(dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    _, mask = cv2.threshold(dist8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    k = max(3, int(min(small.shape[:2]) * 0.006)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    for poly in exclude or []:
        p = np.asarray(poly, np.float64).reshape(-1, 2) * s
        c = p.mean(axis=0)
        d = p - c
        n = np.linalg.norm(d, axis=1, keepdims=True)
        grown = c + d * EXCLUDE_GROW + d / np.maximum(n, 1e-6) * EXCLUDE_PAD_PX
        cv2.fillPoly(mask, [np.round(grown).astype(np.int32)], 0)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise MeasureError("مش لاقيين القطعة في الصورة. صوّرها على أرضية سادة بلون مختلف عنها.")
    biggest = max(contours, key=cv2.contourArea)
    area_ratio = cv2.contourArea(biggest) / float(mask.shape[0] * mask.shape[1])
    if area_ratio < 0.03:
        raise MeasureError("القطعة صغيرة أوي في الصورة. قرّب الموبايل شوية.")
    x, y, bw_, bh_ = cv2.boundingRect(biggest)
    if x <= 1 or y <= 1 or x + bw_ >= mask.shape[1] - 1 or y + bh_ >= mask.shape[0] - 1:
        raise MeasureError("القطعة خارجة برة الكادر. ابعد الموبايل شوية لحد ما تبان كلها.")
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, [biggest], -1, 255, thickness=cv2.FILLED)
    return filled, s


# ---------------------------------------------------------------- t-shirt
def _center_run(row: np.ndarray, cx: int) -> tuple[int, int] | None:
    """Left/right edge of the filled run that contains column cx (or nearest)."""
    xs = np.flatnonzero(row)
    if xs.size == 0:
        return None
    if not row[cx]:
        cx = int(xs[np.argmin(np.abs(xs - cx))])
    left = cx
    while left > 0 and row[left - 1]:
        left -= 1
    right = cx
    while right < row.size - 1 and row[right + 1]:
        right += 1
    return left, right


def measure_tshirt(mask: np.ndarray, work_px_per_cm: float) -> tuple[list[tuple[str, tuple, tuple, float, str]], list[str]]:
    """Return lines in WORK coordinates: (name, (x,y), (x,y), cm, confidence)."""
    warnings: list[str] = []
    m = mask > 0
    rows = np.flatnonzero(m.any(axis=1))
    top, bottom = int(rows[0]), int(rows[-1])
    height = bottom - top
    cols = np.flatnonzero(m.any(axis=0))
    cx = int(round((cols[0] + cols[-1]) / 2))

    # Body width profile using the run that contains the centre column.
    runs = {y: _center_run(m[y], cx) for y in range(top, bottom + 1)}
    widths = np.array([(r[1] - r[0]) if r else 0 for r in (runs[y] for y in range(top, bottom + 1))], dtype=float)

    lo, hi = int(0.70 * height), int(0.90 * height)
    body_w = float(np.median(widths[lo:hi]))
    if body_w <= 0:
        raise MeasureError("مش قادرين نحدد جسم القطعة. اتأكد إنها مفرودة كويس.")

    # Armpit: scanning up from the lower body, first row where the run gets much wider (sleeve joins).
    armpit_y = None
    start = int(0.75 * height)
    for i in range(start, 0, -1):
        if widths[i] > body_w * 1.12:
            armpit_y = top + i + 1
            break
    if armpit_y is None:
        raise MeasureError("مش لاقيين الإبط. افرد الأكمام للجنب بزاوية واضحة.")

    def width_line(name: str, y: int, conf: str = "high"):
        r = runs.get(y)
        if not r:
            raise MeasureError("القياس فشل عند " + name)
        return (name, (r[0], y), (r[1], y), (r[1] - r[0]) / work_px_per_cm, conf)

    chest_y = min(bottom, armpit_y + int(round(CHEST_BELOW_ARMPIT_CM * work_px_per_cm)))
    hem_y = max(top, bottom - int(round(HEM_ABOVE_BOTTOM_CM * work_px_per_cm)))
    lines = [width_line("chest_width", chest_y), width_line("hem_width", hem_y)]

    # Top edge per column (first filled row) -> HPS and shoulder point on the right side.
    top_edge = np.full(m.shape[1], -1)
    for x in cols:
        ys = np.flatnonzero(m[:, x])
        top_edge[x] = ys[0]
    right_cols = np.arange(cx, cols[-1] + 1)
    right_top = top_edge[right_cols]
    hps_x = int(right_cols[int(np.argmin(right_top))])
    hps = (hps_x, int(top_edge[hps_x]))

    # Length: HPS height to the lowest point of the hem near the centre.
    band = m[:, max(0, cx - int(0.1 * body_w)):cx + int(0.1 * body_w) + 1]
    hem_bottom = int(np.flatnonzero(band.any(axis=1))[-1])
    lines.append(("body_length", (hps[0], hps[1]), (hps[0], hem_bottom), (hem_bottom - hps[1]) / work_px_per_cm, "high"))

    # Sleeve (beta): sleeve top-outer corner = topmost point among the outermost columns;
    # shoulder point = point on the top edge between HPS and that corner farthest from the chord.
    xmax = int(cols[-1])
    outer = [x for x in range(xmax - max(2, int(0.01 * m.shape[1])), xmax + 1) if top_edge[x] >= 0]
    corner_x = min(outer, key=lambda x: top_edge[x])
    corner = (corner_x, int(top_edge[corner_x]))
    seg = [x for x in range(hps[0], corner[0] + 1) if top_edge[x] >= 0]
    if len(seg) > 3:
        (x1, y1), (x2, y2) = hps, corner
        denom = math.hypot(x2 - x1, y2 - y1) or 1.0
        d = [abs((y2 - y1) * x - (x2 - x1) * top_edge[x] + x2 * y1 - y2 * x1) / denom for x in seg]
        sx = seg[int(np.argmax(d))]
        shoulder = (sx, int(top_edge[sx]))
        sleeve_cm = math.hypot(corner[0] - shoulder[0], corner[1] - shoulder[1]) / work_px_per_cm
        lines.append(("sleeve_length", shoulder, corner, sleeve_cm, "low"))
        warnings.append("طول الكم تجريبي ومش دقيق لسه.")

    # Shape sanity checks -> lower confidence instead of failing.
    if not (0.85 < (lines[0][3] / max(lines[1][3], 1e-6)) < 1.35):
        warnings.append("نسبة الصدر للحافة غريبة؛ راجع إن القطعة مفرودة.")
    return lines, warnings


# ---------------------------------------------------------------- deskew
def deskew(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rotate the mask so the shirt's centre line is vertical.
    Returns (rotated mask, 2x3 inverse affine mapping rotated -> original coords)."""
    m = mask > 0
    rows = np.flatnonzero(m.any(axis=1))
    top, bottom = rows[0], rows[-1]
    cols = np.flatnonzero(m.any(axis=0))
    cx = int(round((cols[0] + cols[-1]) / 2))
    ys, xs = [], []
    for y in range(int(top + 0.55 * (bottom - top)), int(top + 0.92 * (bottom - top))):
        r = _center_run(m[y], cx)
        if r:
            ys.append(y)
            xs.append((r[0] + r[1]) / 2)
    if len(ys) < 10:
        return mask, np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    a, _ = np.polyfit(ys, xs, 1)            # x = a*y + b  -> centre line slope
    angle = math.degrees(math.atan(a))       # positive: line leans right going down
    if abs(angle) < 0.2:
        return mask, np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    h, w = mask.shape
    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, -angle, 1.0)
    rotated = cv2.warpAffine(mask, M, (w, h), flags=cv2.INTER_NEAREST)
    return rotated, cv2.invertAffineTransform(M)


# ---------------------------------------------------------------- entry point
def px_per_cm_from_calibration(p1: tuple[float, float], p2: tuple[float, float], cm: float) -> float:
    if cm <= 0:
        raise MeasureError("الطول المرجعي لازم يكون أكبر من صفر.")
    d = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    if d < 20:
        raise MeasureError("النقطتين قريبين من بعض أوي. اختار نقطتين أبعد.")
    return d / cm


def measure(img_bgr: np.ndarray, px_per_cm: float, garment: str = "tshirt", exclude: list | None = None) -> Result:
    if garment != "tshirt":
        raise MeasureError("النسخة التجريبية بتقيس تيشرت بس.")
    if px_per_cm <= 0:
        raise MeasureError("المقياس (px/cm) غلط.")
    mask, s = segment(img_bgr, exclude)
    mask, inv = deskew(mask)
    mask, inv2 = deskew(mask)  # second pass: the first estimate is biased when the shirt is rotated a lot
    inv = (np.vstack([inv, [0, 0, 1]]) @ np.vstack([inv2, [0, 0, 1]]))[:2]
    raw, warnings = measure_tshirt(mask, px_per_cm * s)
    res = Result(garment=garment, px_per_cm=px_per_cm, image_size=(img_bgr.shape[1], img_bgr.shape[0]), warnings=warnings)
    for name, a, b, cm, conf in raw:
        pa = inv @ np.array([a[0], a[1], 1.0])
        pb = inv @ np.array([b[0], b[1], 1.0])
        res.lines.append(Line(name, Point(float(pa[0] / s), float(pa[1] / s)), Point(float(pb[0] / s), float(pb[1] / s)), cm, conf))
    return res
