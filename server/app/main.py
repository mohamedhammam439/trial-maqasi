"""Maqasi PoC measurement API.

POST /measure  (multipart)
  image        : the photo (JPEG/PNG), full resolution
  garment      : "tshirt" (only option in the PoC)
  px_per_cm    : optional float, if the scale is already known (e.g. from AR)
  reference    : optional JSON describing the scale reference in the photo (see app/reference.py):
                 {"type":"tape","p1":[x,y],"p2":[x,y],"cm":50}
                 {"type":"a4"|"card","corners":[[x,y]*4]}        corners optional -> auto-detect
                 {"type":"rect","w_cm":..,"h_cm":..,"corners":[...]}
  calib        : legacy, same as reference type "tape": {"p1":[x,y],"p2":[x,y],"cm":number}
  exclude      : optional JSON list of polygons ([[x,y],...]) to leave out of the garment, e.g. the A4 sheet's
                 corners from an earlier call. A rectangle reference's own corners are always left out.
One of px_per_cm / reference / calib is required.

Every request is saved to captures/ (image + request + response) for offline analysis;
set MAQASI_SAVE_CAPTURES=0 to turn that off.
"""
import hashlib
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .measure import MeasureError, measure
from . import aruco_sheet, precheck
from .reference import KNOWN_RECTS, detect_rect, px_per_cm_from_rect, resolve as resolve_reference

LIVE_ASPECT_TOL = 0.03
ARUCO_MAX_REPROJ_PX = 2.0  # marker corners off a single plane by more than this -> sheet not flat  # live A4 check: the sheet's long/short side ratio must be within 3% of 29.7/21

CAPTURES = Path(__file__).resolve().parent.parent / "captures"
SAVE_CAPTURES = os.environ.get("MAQASI_SAVE_CAPTURES", "1") != "0"


def _save_capture(raw: bytes, request: dict, response: dict) -> None:
    if not SAVE_CAPTURES:
        return
    try:
        CAPTURES.mkdir(exist_ok=True)
        stem = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
        # the app sends the same photo several times (AR, A4, fused): keep one copy per photo
        img_name = hashlib.sha1(raw).hexdigest()[:12] + ".jpg"
        if not (CAPTURES / img_name).exists():
            (CAPTURES / img_name).write_bytes(raw)
        (CAPTURES / f"{stem}.json").write_text(
            json.dumps({"image": img_name, "request": request, "response": response}, ensure_ascii=False, indent=1),
            encoding="utf-8")
    except OSError:
        pass


app = FastAPI(title="Maqasi PoC")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/aruco-sheet.png")
def aruco_sheet_png():
    """The printable ArUco sheet (300 dpi PNG; print at 100%)."""
    from fastapi.responses import Response
    ok, buf = cv2.imencode(".png", aruco_sheet.render_sheet())
    return Response(buf.tobytes(), media_type="image/png")


@app.get("/health")
def health():
    return {"ok": True}


def _sheet_check(img: np.ndarray, kind: str) -> dict:
    """Is the scale sheet in view, flat, with the right proportions?"""
    flat = True
    try:
        if kind == "aruco":
            outer, corners, reproj = aruco_sheet.locate(img)
            px_per_cm, aspect_err = px_per_cm_from_rect(outer, *aruco_sheet.OUTER_CM)
            flat = reproj <= ARUCO_MAX_REPROJ_PX
        else:
            long_cm, short_cm = KNOWN_RECTS["a4"]
            corners = detect_rect(img, long_cm, short_cm)
            px_per_cm, aspect_err = px_per_cm_from_rect(corners, long_cm, short_cm)
    except MeasureError as e:
        return {"ok": False, "found": False, "aspect_err": None, "px_per_cm": None, "corners": None,
                "message": str(e) if kind == "aruco" else "مش لاقيين ورقة الـ A4. حطها مفرودة في نص التيشرت."}
    ok = aspect_err <= LIVE_ASPECT_TOL and flat
    label = "ورقة الـ ArUco" if kind == "aruco" else "ورقة الـ A4"
    return {
        "ok": ok, "found": True, "aspect_err": round(aspect_err, 4), "px_per_cm": round(px_per_cm, 3),
        "corners": np.asarray(corners).round(1).tolist(),
        "message": f"{label} مظبوطة." if ok else
        f"{label} مش مفرودة كويس." if not flat else
        f"نسبة أبعاد {label} مش مظبوطة ({aspect_err * 100:.1f}%). افردها كويس واتأكد إنها كلها باينة.",
    }


@app.post("/check_a4")
async def check_a4(image: UploadFile = File(...), kind: str = Form("a4")):
    """Live check of a preview frame before the shot; the app only lets the user shoot when `ok`.
    kind: "a4" (plain white sheet) or "aruco" (the printed marker sheet).
    Returns the sheet check at the top level ({found, aspect_err, px_per_cm, corners}) plus
    sheet/light/garment: {ok, message, ...}; ok = all three; message = the first thing to fix.
    Never saves the image."""
    img = cv2.imdecode(np.frombuffer(await image.read(), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "الصورة مش مقروءة.")
    sheet = _sheet_check(img, kind)
    light, garment = precheck.run(img, sheet["corners"])
    failing = [c for c in (light, sheet, garment) if not c["ok"]]
    return {
        **sheet,
        "ok": not failing,
        "message": failing[0]["message"] if failing else "كله مظبوط.",
        "sheet": {"ok": sheet["ok"], "message": sheet["message"]},
        "light": light,
        "garment": garment,
    }


@app.post("/measure")
async def measure_endpoint(
    image: UploadFile = File(...),
    garment: str = Form("tshirt"),
    px_per_cm: float | None = Form(None),
    calib: str | None = Form(None),
    reference: str | None = Form(None),
    exclude: str | None = Form(None),
):
    raw_bytes = await image.read()
    request = {"garment": garment, "px_per_cm": px_per_cm, "calib": calib, "reference": reference, "exclude": exclude}
    data = np.frombuffer(raw_bytes, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "الصورة مش مقروءة.")
    try:
        ref = None
        if px_per_cm is None:
            raw = reference or calib
            if not raw:
                raise MeasureError("محتاجين مقياس: px_per_cm أو مرجع معروف مقاسه (متر، A4، كارت).")
            try:
                spec = json.loads(raw)
            except json.JSONDecodeError:
                raise MeasureError("بيانات المرجع مش JSON سليم.")
            if not reference and isinstance(spec, dict):
                spec.setdefault("type", "tape")
            ref = resolve_reference(spec, img)
            px_per_cm = ref.px_per_cm
        polys = []
        if exclude:
            try:
                polys = [p for p in json.loads(exclude) if len(p) >= 3]
            except (json.JSONDecodeError, TypeError):
                raise MeasureError("بيانات exclude مش JSON سليم.")
        if ref is not None and ref.corners is not None:
            polys.append(ref.corners)
        out = measure(img, px_per_cm, garment, polys).to_dict()
        if ref is not None:
            out["reference"] = ref.to_dict()
            out["warnings"] = ref.warnings + out["warnings"]
        _save_capture(raw_bytes, request, out)
        return out
    except MeasureError as e:
        _save_capture(raw_bytes, request, {"error": str(e)})
        raise HTTPException(422, str(e))
