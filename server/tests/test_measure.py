import json

import cv2
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.measure import MeasureError, measure, px_per_cm_from_calibration
from tests.synth import GROUND_TRUTH, render

CORE = ["chest_width", "hem_width", "body_length"]
TOL_CM = 1.0  # acceptance for core measurements in good conditions


def errors(res):
    m = res.to_dict()["measurements_cm"]
    return {k: abs(m[k] - GROUND_TRUTH[k]) for k in CORE}


@pytest.mark.parametrize("rotate", [-3, 0, 3])
@pytest.mark.parametrize("tilt", [0, 3])
@pytest.mark.parametrize("seed", [0, 1])
def test_core_measurements_good_conditions(rotate, tilt, seed):
    img, s = render(rotate_deg=rotate, tilt_deg=tilt, seed=seed)
    errs = errors(measure(img, s))
    assert max(errs.values()) <= TOL_CM, errs


@pytest.mark.parametrize("fg,bg", [((40, 60, 150), (205, 208, 206)),     # navy on light grey
                                   ((235, 235, 235), (60, 70, 80)),      # white on dark floor
                                   ((150, 160, 170), (120, 130, 140))])  # low contrast
def test_colours(fg, bg):
    img, s = render(fg=fg, bg=bg)
    errs = errors(measure(img, s))
    assert max(errs.values()) <= TOL_CM, errs


def test_calibration_scale():
    assert px_per_cm_from_calibration((0, 0), (300, 400), 50) == pytest.approx(10.0)
    with pytest.raises(MeasureError):
        px_per_cm_from_calibration((0, 0), (5, 5), 10)


def test_shirt_out_of_frame_is_rejected():
    img, s = render()
    with pytest.raises(MeasureError):
        measure(img[:, 600:], s)


def test_api_with_calibration():
    img, s = render()
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    calib = {"p1": [0, 0], "p2": [s * 30, 0], "cm": 30}  # a 30 cm reference of known pixel length
    r = TestClient(app).post("/measure", files={"image": ("t.jpg", buf.tobytes(), "image/jpeg")},
                             data={"garment": "tshirt", "calib": json.dumps(calib)})
    assert r.status_code == 200, r.text
    m = r.json()["measurements_cm"]
    assert abs(m["chest_width"] - GROUND_TRUTH["chest_width"]) <= TOL_CM
