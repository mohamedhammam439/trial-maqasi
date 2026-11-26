"""Write the printable ArUco scale sheet as an A4 PDF (and PNG).

    python -m scripts.make_aruco_sheet [out_dir]      (run from server/; needs Pillow: pip install pillow)
"""
import sys
from pathlib import Path

from PIL import Image

from app.aruco_sheet import render_sheet

DPI = 300


def main(out_dir: str = "../docs") -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(render_sheet(DPI)[:, :, ::-1].copy())  # BGR -> RGB
    img.save(out / "maqasi-aruco-a4.pdf", resolution=DPI)
    img.save(out / "maqasi-aruco-a4.png", dpi=(DPI, DPI))
    print("wrote", out / "maqasi-aruco-a4.pdf")


if __name__ == "__main__":
    main(*sys.argv[1:])
