"""Live checks on a preview frame, before the shot: is the light good enough, and is the garment
laid out flat enough to be measured? Each returns {"ok": bool, "message": str, ...numbers}.
Messages are user-facing (Egyptian Arabic)."""
from __future__ import annotations

import cv2
import numpy as np

from .measure import MeasureError, _center_run, deskew, measure_tshirt, segment

# ---- light
MIN_BRIGHTNESS = 70          # mean grey (0-255) of the frame
MAX_CLIPPED = 0.04           # share of pixels at >= 250 outside the scale sheet
MIN_SHARPNESS = 12.0         # variance of the Laplacian at 800 px wide: below = blurry / out of focus
MAX_SHADOW = 0.45            # (brightest - darkest sector) / mean of the floor in a ring just around the garment

# ---- garment
MAX_ASYMMETRY = 0.06         # |left area - right area| / total, about the body's centre line
MAX_SLEEVE_DIFF = 0.08       # left vs right sleeve reach from the centre line
MAX_SIDE_WOBBLE = 0.04       # std / mean of the body width over the lower body (folded or bunched sides)
# Calibrated 2026-11-26 on real shots (navy tee on a beige rug): asymmetry <= 0.004, sleeve <= 0.009, wobble 0.003, shadow <= 0.13.


def light_check(img_bgr: np.ndarray, sheet: list | None = None, garment_mask: np.ndarray | None = None) -> dict:
    """garment_mask: the garment at any resolution (from garment_check). The evenness check only looks at
    the floor in a ring around it: feet, tiles or furniture elsewhere in the frame are not shadows."""
    h, w = img_bgr.shape[:2]
    s = 800 / w
    gray = cv2.cvtColor(cv2.resize(img_bgr, (800, int(h * s)), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    mean = float(gray.mean())
    keep = np.ones(gray.shape, bool)
    if sheet is not None:  # the white sheet is meant to be bright: leave it out of the clipping count
        poly = np.round(np.asarray(sheet, np.float64) * s).astype(np.int32)
        m = np.zeros(gray.shape, np.uint8)
        cv2.fillPoly(m, [poly], 1)
        keep = m == 0
    clipped = float((gray[keep] >= 250).mean()) if keep.any() else 0.0
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    shadow = 0.0
    if garment_mask is not None and garment_mask.any():
        gm = cv2.resize(garment_mask.astype(np.uint8), (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_NEAREST)
        k = max(3, gray.shape[1] // 40)
        near = cv2.dilate(gm, np.ones((k, k), np.uint8), iterations=1)
        far = cv2.dilate(gm, np.ones((k, k), np.uint8), iterations=3)
        ring = (far > 0) & (near == 0) & keep
        ys, xs = np.nonzero(ring)
        if len(ys) > 200:
            cy, cx = np.nonzero(gm)
            ang = np.arctan2(ys - cy.mean(), xs - cx.mean())
            sector = ((ang + np.pi) / (2 * np.pi) * 8).astype(int) % 8
            vals = gray[ys, xs].astype(np.float64)
            meds = [float(np.median(vals[sector == i])) for i in range(8) if (sector == i).sum() > 20]
            if len(meds) >= 4:
                shadow = (max(meds) - min(meds)) / max(float(np.median(vals)), 1.0)
    else:
        # no garment outline (a strong shadow can break it): fall back to the frame's left/right/top border,
        # leaving out the bottom quarter where the user's feet usually are; looser limit
        hh = int(gray.shape[0] * 0.75)
        bw = max(4, gray.shape[1] // 25)
        parts = [gray[:bw, :], gray[:hh, :bw], gray[:hh, -bw:]]
        cells = [float(np.median(c)) for p in parts for c in np.array_split(p, 3, axis=1 if p.shape[0] == bw else 0)]
        shadow = (max(cells) - min(cells)) / max(float(np.median(cells)), 1.0) * (MAX_SHADOW / 0.6)
    stats = {"brightness": round(mean, 1), "clipped": round(clipped, 4), "sharpness": round(sharp, 1),
             "shadow": round(shadow, 3)}
    if mean < MIN_BRIGHTNESS:
        return {"ok": False, "message": "الإضاءة ضعيفة. نوّر المكان أو صوّر قريب من شباك.", **stats}
    if clipped > MAX_CLIPPED:
        return {"ok": False, "message": "فيه نور جامد أو انعكاس على الصورة. بعّد عن الضوء المباشر.", **stats}
    if shadow > MAX_SHADOW:
        return {"ok": False, "message": "فيه ضل على الأرض أو الإضاءة مش متساوية. اتأكد إن ضلّك مش واقع على القطعة.", **stats}
    if sharp < MIN_SHARPNESS:
        return {"ok": False, "message": "الصورة مش واضحة (مهزوزة أو الفوكس مش مظبوط). ثبّت الموبايل.", **stats}
    return {"ok": True, "message": "الإضاءة كويسة.", **stats}


def garment_check(img_bgr: np.ndarray, exclude: list | None = None) -> tuple[dict, np.ndarray | None]:
    """Returns (result, garment mask before deskew or None)."""
    try:
        raw, _ = segment(img_bgr, exclude)
        mask, _ = deskew(raw)
        mask, _ = deskew(mask)
        # px/cm doesn't matter for the shape checks; measure_tshirt finds the armpits, hem and sleeves
        _, warnings = measure_tshirt(mask, 10.0)
    except MeasureError as e:
        return {"ok": False, "message": str(e)}, None
    return _shape(mask, warnings), raw > 0


def _shape(mask: np.ndarray, warnings: list[str]) -> dict:
    m = mask > 0
    rows = np.flatnonzero(m.any(axis=1))
    top, bottom = int(rows[0]), int(rows[-1])
    height = bottom - top
    cols = np.flatnonzero(m.any(axis=0))
    cx0 = int(round((cols[0] + cols[-1]) / 2))
    # body centre line from the lower body (the sleeves don't reach there)
    mids, widths = [], []
    for y in range(top + int(0.55 * height), top + int(0.9 * height)):
        r = _center_run(m[y], cx0)
        if r:
            mids.append((r[0] + r[1]) / 2)
            widths.append(r[1] - r[0])
    if len(widths) < 10:
        return {"ok": False, "message": "مش قادرين نحدد جسم التيشرت. افرده كويس."}
    cx = float(np.median(mids))
    xs = np.arange(m.shape[1])
    area = m.sum(axis=0).astype(np.float64)
    left, right = float(area[xs < cx].sum()), float(area[xs >= cx].sum())
    asym = abs(left - right) / max(left + right, 1.0)
    reach_l, reach_r = cx - cols[0], cols[-1] - cx
    sleeve_diff = float(abs(reach_l - reach_r) / max(reach_l, reach_r, 1.0))
    wobble = float(np.std(widths) / max(np.mean(widths), 1.0))
    stats = {"asymmetry": round(asym, 3), "sleeve_diff": round(sleeve_diff, 3), "side_wobble": round(wobble, 3)}
    if sleeve_diff > MAX_SLEEVE_DIFF:
        return {"ok": False, "message": "الكمين مش مفرودين زي بعض. افرد الكمين للجنب بنفس الزاوية.", **stats}
    if asym > MAX_ASYMMETRY:
        return {"ok": False, "message": "التيشرت مش مفرود بالتساوي (جنب أكبر من التاني). عدّله.", **stats}
    if wobble > MAX_SIDE_WOBBLE:
        return {"ok": False, "message": "جناب التيشرت فيها تني أو كرمشة. افردها كويس.", **stats}
    if warnings and any("نسبة الصدر" in w for w in warnings):
        return {"ok": False, "message": "نسبة الصدر للحافة غريبة. اتأكد إن التيشرت مفرود كويس.", **stats}
    return {"ok": True, "message": "التيشرت مفرود كويس.", **stats}


def run(img_bgr: np.ndarray, sheet: list | None = None) -> tuple[dict, dict]:
    """(light, garment) checks for one preview frame; sheet = its outline (image px) if found."""
    garment, mask = garment_check(img_bgr, [sheet] if sheet is not None else None)
    return light_check(img_bgr, sheet, mask), garment
