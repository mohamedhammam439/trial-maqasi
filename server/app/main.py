"""Maqasi PoC measurement API.

POST /measure  (multipart)
  image        : the photo (JPEG/PNG), full resolution
  garment      : "tshirt" (only option in the PoC)
  px_per_cm    : optional float, if the scale is already known (e.g. from AR)
  calib        : optional JSON {"p1":[x,y],"p2":[x,y],"cm":number} in image pixels
One of px_per_cm / calib is required.
"""
import json

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .measure import MeasureError, measure, px_per_cm_from_calibration

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
):
    data = np.frombuffer(await image.read(), np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "الصورة مش مقروءة.")
    try:
        if px_per_cm is None:
            if not calib:
                raise MeasureError("محتاجين مقياس: px_per_cm أو نقطتين معروف طولهم.")
            c = json.loads(calib)
            px_per_cm = px_per_cm_from_calibration(tuple(c["p1"]), tuple(c["p2"]), float(c["cm"]))
        return measure(img, px_per_cm, garment).to_dict()
    except MeasureError as e:
        raise HTTPException(422, str(e))
