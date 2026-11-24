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
One of px_per_cm / reference / calib is required.
"""
import json

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .measure import MeasureError, measure
from .reference import resolve as resolve_reference

app = FastAPI(title="Maqasi PoC")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/measure")
async def measure_endpoint(
    image: UploadFile = File(...),
    garment: str = Form("tshirt"),
    px_per_cm: float | None = Form(None),
    calib: str | None = Form(None),
    reference: str | None = Form(None),
):
    data = np.frombuffer(await image.read(), np.uint8)
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
        out = measure(img, px_per_cm, garment).to_dict()
        if ref is not None:
            out["reference"] = ref.to_dict()
            out["warnings"] = ref.warnings + out["warnings"]
        return out
    except MeasureError as e:
        raise HTTPException(422, str(e))
