"""Error table on synthetic photos: python -m tests.report"""
from app.measure import MeasureError, measure
from tests.synth import GROUND_TRUTH, render

KEYS = ["chest_width", "hem_width", "body_length", "sleeve_length"]

def row(label, **kw):
    try:
        m = measure(*render(**kw)).to_dict()["measurements_cm"]
        cells = [f"{m[k]-GROUND_TRUTH[k]:+.1f}" for k in KEYS]
    except MeasureError as e:
        cells = ["fail"] * len(KEYS)
    print(f"| {label} | " + " | ".join(cells) + " |")

print("| الحالة | الصدر | الحافة | الطول | الكم (تجريبي) |")
print("|---|---|---|---|---|")
row("مثالي")
for t in (3, 5, 8, 12):
    row(f"ميل الموبايل {t}°", tilt_deg=t)
for r in (5, 10):
    row(f"القطعة مايلة {r}°", rotate_deg=r)
row("إضاءة مش متساوية قوية", light_grad=0.6)
row("ضوضاء عالية (إضاءة ضعيفة)", noise=18)
row("تيشرت أبيض على أرضية غامقة", fg=(235,235,235), bg=(60,70,80))
row("تباين ضعيف", fg=(150,160,170), bg=(120,130,140))
row("صورة أقل دقة (15 px/cm)", px_per_cm=15.0, size=(1500, 2000))
