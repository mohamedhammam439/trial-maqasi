import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.measure import MeasureError, measure
from app.reference import order_corners, px_per_cm_from_rect, resolve
from tests.synth import A4, CARD, GROUND_TRUTH, render_with_ref

CORE = ["chest_width", "hem_width", "body_length"]


def errors(res):
    m = res.to_dict()["measurements_cm"]
    return {k: abs(m[k] - GROUND_TRUTH[k]) for k in CORE}


def post(img, **data):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return TestClient(app).post("/measure", files={"image": ("t.jpg", buf.tobytes(), "image/jpeg")},
                                data={"garment": "tshirt", **data})


# ------------------------------------------------------------ geometry
def test_order_corners_any_order():
    sq = [(10, 10), (110, 10), (110, 60), (10, 60)]
    shuffled = [sq[2], sq[0], sq[3], sq[1]]
    assert order_corners(shuffled).tolist() == [list(map(float, p)) for p in sq]


def test_rect_scale_and_orientation():
    # A4 portrait at 10 px/cm: 210 x 297 px. Long/short side are matched automatically.
    corners = [(0, 0), (210, 0), (210, 297), (0, 297)]
    s, err = px_per_cm_from_rect(corners, *A4)
    assert s == pytest.approx(10.0, rel=1e-3) and err < 0.01


def test_wrong_corners_rejected():
    # a square can't be a card
    with pytest.raises(MeasureError):
        resolve({"type": "card", "corners": [(0, 0), (100, 0), (100, 100), (0, 100)]})


def test_custom_rect_needs_size():
    with pytest.raises(MeasureError):
        resolve({"type": "rect", "corners": [(0, 0), (100, 0), (100, 50), (0, 50)]})
    r = resolve({"type": "rect", "w_cm": 20, "h_cm": 10, "corners": [(0, 0), (200, 0), (200, 100), (0, 100)]})
    assert r.px_per_cm == pytest.approx(10.0)


def test_unknown_type_rejected():
    with pytest.raises(MeasureError):
        resolve({"type": "banana"})


def test_card_warns_about_accuracy():
    r = resolve({"type": "card", "corners": [(0, 0), (171.2, 0), (171.2, 108), (0, 108)]})
    assert r.warnings and "A4" in r.warnings[0]
    r = resolve({"type": "a4", "corners": [(0, 0), (630, 0), (630, 891), (0, 891)]})
    assert not r.warnings


# ------------------------------------------------------------ on synthetic photos
@pytest.mark.parametrize("kind,size,angle", [("a4", A4, 0), ("a4", A4, 7), ("card", CARD, 0), ("card", CARD, -12)])
def test_tapped_corners_measure_shirt(kind, size, angle):
    img, true_s, corners = render_with_ref(ref=size, ref_angle_deg=angle)
    ref = resolve({"type": kind, "corners": corners.tolist()}, img)
    assert ref.px_per_cm == pytest.approx(true_s, rel=0.01)
    assert max(errors(measure(img, ref.px_per_cm)).values()) <= 1.0


def test_tilt_far_reference_error_is_bounded():
    """A 3 deg phone tilt (the app's limit) with the reference ~50 cm from the shirt centre:
    perspective makes the scale there differ by a few %. Same limitation as the tape."""
    img, true_s, corners = render_with_ref(tilt_deg=3, ref=A4)
    ref = resolve({"type": "a4", "corners": corners.tolist()}, img)
    assert ref.px_per_cm == pytest.approx(true_s, rel=0.04)


def test_tapping_error_hurts_card_more_than_a4():
    """Same 2 px tapping error on each corner: card scale error is several times A4's."""
    jitter = np.array([[2, -2], [2, 2], [-2, 2], [-2, -2]])  # every corner pushed outwards
    errs = {}
    for kind, size in (("a4", A4), ("card", CARD)):
        img, true_s, corners = render_with_ref(ref=size)
        q = order_corners(corners)
        ref = resolve({"type": kind, "corners": (q + jitter).tolist(), "snap": False}, img)
        errs[kind] = abs(ref.px_per_cm / true_s - 1)
    assert errs["card"] > 3 * errs["a4"]


@pytest.mark.parametrize("kind,size", [("a4", A4), ("card", CARD)])
def test_rough_taps_snap_to_edges(kind, size):
    """Finger taps ~10 px off (a phone screen shows ~8 image px per point) are snapped back."""
    img, true_s, corners = render_with_ref(ref=size, ref_angle_deg=8)
    q = order_corners(corners)
    rough = q + np.array([[9, -7], [-10, 6], [8, 10], [-7, -9]])
    ref = resolve({"type": kind, "corners": rough.tolist()}, img)
    assert np.abs(np.array(ref.corners) - q).max() < 1.5
    assert ref.px_per_cm == pytest.approx(true_s, rel=0.01)


@pytest.mark.parametrize("kind,size,angle", [("a4", A4, 0), ("a4", A4, 10), ("card", CARD, 0), ("card", CARD, 15),
                                             ("card", (CARD[1], CARD[0]), 40)])
def test_auto_detect(kind, size, angle):
    img, true_s, corners = render_with_ref(ref=size, ref_angle_deg=angle)
    ref = resolve({"type": kind}, img)
    assert ref.detected
    assert ref.px_per_cm == pytest.approx(true_s, rel=0.02)
    found = np.array(ref.corners)
    assert np.abs(found - order_corners(corners)).max() < 1.5  # px (sub-pixel refinement)


def test_auto_detect_card_on_dark_floor():
    img, true_s, _ = render_with_ref(ref=CARD, ref_color=(40, 90, 170), bg=(60, 60, 60), fg=(200, 200, 200))
    assert resolve({"type": "card"}, img).px_per_cm == pytest.approx(true_s, rel=0.02)


def test_auto_detect_missing_reference_fails_cleanly():
    img, _, _ = render_with_ref(ref=None)
    with pytest.raises(MeasureError):
        resolve({"type": "a4"}, img)


# ------------------------------------------------------------ API
def test_api_a4_auto():
    img, _, _ = render_with_ref(ref=A4)
    r = post(img, reference=json.dumps({"type": "a4"}))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reference"]["type"] == "a4" and body["reference"]["detected"]
    assert abs(body["measurements_cm"]["chest_width"] - GROUND_TRUTH["chest_width"]) <= 1.0


def test_api_card_corners_has_warning():
    img, _, corners = render_with_ref(ref=CARD)
    r = post(img, reference=json.dumps({"type": "card", "corners": corners.tolist()}))
    assert r.status_code == 200, r.text
    assert any("A4" in w for w in r.json()["warnings"])


def test_api_tape_reference():
    img, s, _ = render_with_ref()
    r = post(img, reference=json.dumps({"type": "tape", "p1": [0, 0], "p2": [s * 50, 0], "cm": 50}))
    assert r.status_code == 200, r.text
    assert r.json()["reference"]["type"] == "tape"


def test_api_bad_reference_is_422():
    img, _, _ = render_with_ref()
    assert post(img, reference="not json").status_code == 422
    assert post(img, reference=json.dumps({"type": "a4"})).status_code == 422


# ------------------------------------------------------------ reference next to the garment
def _sheet_touching_shirt():
    # sheet the same colour as the shirt, 0.5 cm from its side: without exclusion the outlines merge
    return render_with_ref(px_per_cm=25, ref=A4, ref_at=(36.5, 10.0), ref_angle_deg=90, ref_color=(60, 80, 140))


def test_exclude_keeps_touching_sheet_out_of_garment():
    img, s, corners = _sheet_touching_shirt()
    merged = errors(measure(img, s))
    assert max(merged.values()) > 5  # the scene really does break measurement without exclusion
    assert max(errors(measure(img, s, exclude=[corners.tolist()])).values()) <= 0.5


def test_api_rect_reference_is_excluded_automatically():
    img, _, corners = _sheet_touching_shirt()
    r = post(img, reference=json.dumps({"type": "a4", "corners": corners.tolist()}))
    assert r.status_code == 200, r.text
    m = r.json()["measurements_cm"]
    assert all(abs(m[k] - GROUND_TRUTH[k]) <= 0.6 for k in CORE)


def test_api_exclude_with_px_per_cm():
    img, s, corners = _sheet_touching_shirt()
    r = post(img, px_per_cm=str(s), exclude=json.dumps([corners.tolist()]))
    assert r.status_code == 200, r.text
    m = r.json()["measurements_cm"]
    assert all(abs(m[k] - GROUND_TRUTH[k]) <= 0.5 for k in CORE)


def test_captures_saved(tmp_path, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "SAVE_CAPTURES", True)
    monkeypatch.setattr(main, "CAPTURES", tmp_path)
    img, s, _ = render_with_ref()
    post(img, px_per_cm=str(s))
    post(img, px_per_cm=str(s * 1.01))
    assert len(list(tmp_path.glob("*.jpg"))) == 1 and len(list(tmp_path.glob("*.json"))) == 2


# ------------------------------------------------------------ live A4 check
def _check(img):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return TestClient(app).post("/check_a4", files={"image": ("t.jpg", buf.tobytes(), "image/jpeg")})


def test_check_a4_ok_on_shirt():
    img, s, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    body = _check(img).json()
    assert body["ok"] and body["found"], body
    assert abs(body["px_per_cm"] / s - 1) < 0.02


def test_check_a4_missing():
    img, _, _ = render_with_ref(px_per_cm=12, size=(1080, 1440))
    body = _check(img).json()
    assert not body["ok"] and not body["found"]


def test_check_a4_wrong_aspect():
    # a 21 x 27 cm sheet (folded / partly hidden): found within the 8% detection tolerance, but fails the live 3% check
    img, _, _ = render_with_ref(px_per_cm=12, ref=(27.5, 21.0), ref_at=(0.0, 0.0), size=(1080, 1440))
    body = _check(img).json()
    assert body["found"] and not body["ok"], body


# ------------------------------------------------------------ ArUco sheet
from tests.synth import render_with_aruco  # noqa: E402


@pytest.mark.parametrize("angle,tilt", [(0, 0), (12, 0), (0, 3)])
def test_aruco_scale(angle, tilt):
    img, s, _ = render_with_aruco(ref_angle_deg=angle, tilt_deg=tilt)
    ref = resolve({"type": "aruco"}, img)
    assert ref.type == "aruco" and ref.detected
    assert abs(ref.px_per_cm / s - 1) < 0.006


def test_aruco_missing_fails_cleanly():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    with pytest.raises(MeasureError):
        resolve({"type": "aruco"}, img)


def test_api_aruco_on_shirt_measures():
    img, s, _ = render_with_aruco(px_per_cm=12)
    r = post(img, reference=json.dumps({"type": "aruco"}))
    assert r.status_code == 200, r.text
    m = r.json()["measurements_cm"]
    assert all(abs(m[k] - GROUND_TRUTH[k]) <= 1.0 for k in CORE), m


def test_check_aruco_live():
    img, s, _ = render_with_aruco()
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    body = TestClient(app).post("/check_a4", files={"image": ("t.jpg", buf.tobytes(), "image/jpeg")},
                                data={"kind": "aruco"}).json()
    assert body["ok"] and body["found"], body
    assert abs(body["px_per_cm"] / s - 1) < 0.01


def test_aruco_sheet_png():
    r = TestClient(app).get("/aruco-sheet.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"


# ------------------------------------------------------------ live light / garment checks
def test_check_reports_light_and_garment_ok():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    body = _check(img).json()
    assert body["ok"] and body["light"]["ok"] and body["garment"]["ok"] and body["sheet"]["ok"], body


def test_check_dark_blocks():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    body = _check((img * 0.25).astype(np.uint8)).json()
    assert not body["ok"] and not body["light"]["ok"]


def test_check_blurry_blocks():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    body = _check(cv2.GaussianBlur(img, (31, 31), 0)).json()
    assert not body["ok"] and not body["light"]["ok"]


def test_check_folded_sleeve_blocks():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    h, w = img.shape[:2]
    img[: int(h * 0.5), int(w * 0.73):] = (205, 208, 206)  # right sleeve gone (folded under)
    body = _check(img).json()
    assert not body["ok"] and not body["garment"]["ok"], body


def test_check_feet_in_frame_still_ok():
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    img[-200:, 300:700] = (30, 30, 30)  # the user's feet at the bottom edge
    body = _check(img).json()
    assert body["light"]["ok"], body


# ------------------------------------------------------------ review fixes
def _measure_a4(img):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return TestClient(app).post("/measure", files={"image": ("t.jpg", buf.tobytes(), "image/jpeg")},
                                data={"reference": json.dumps({"type": "a4"})})


@pytest.mark.parametrize("at", [(10.0, -8.0), (18.0, -8.0)])
def test_sheet_on_garment_edge_is_rejected(at):
    """A sheet that reaches the garment's edge cuts a notch in the outline: refuse instead of a wrong chest."""
    img, _, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=at, size=(1080, 1440))
    r = _measure_a4(img)
    assert r.status_code == 422 and "حرف القطعة" in r.json()["detail"]
    body = _check(img).json()
    assert not body["ok"] and "حرف القطعة" in body["message"]


@pytest.mark.parametrize("fg", [(215, 215, 215), (235, 235, 235)])
def test_white_a4_found_on_light_shirt(fg):
    img, s, _ = render_with_ref(px_per_cm=12, ref=A4, ref_at=(0.0, 0.0), fg=fg, bg=(70, 65, 60), size=(1080, 1440))
    body = _check(img).json()
    assert body["ok"], body
    r = _measure_a4(img)
    assert r.status_code == 200 and abs(r.json()["px_per_cm"] / s - 1) < 0.01


def test_sheet_upright_on_small_shirt_is_rejected(monkeypatch):
    """Kids' size: an upright A4 spans the whole chest and splits the outline in two."""
    import tests.synth as synth
    full = synth.outline_cm
    monkeypatch.setattr(synth, "outline_cm", lambda scale=1.0: full(0.7))
    img, _, _ = synth.render_with_ref(px_per_cm=17, ref=A4, ref_at=(0.0, 0.0), ref_angle_deg=90, size=(1080, 1440))
    r = _measure_a4(img)
    assert r.status_code == 422 and "حرف القطعة" in r.json()["detail"]
    # lying across, the same sheet fits and the shirt measures normally
    img, _, _ = synth.render_with_ref(px_per_cm=17, ref=A4, ref_at=(0.0, 0.0), size=(1080, 1440))
    m = _measure_a4(img).json()["measurements_cm"]
    assert abs(m["chest_width"] - GROUND_TRUTH["chest_width"] * 0.7) <= 0.6
