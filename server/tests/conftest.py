import pytest

from app import main


@pytest.fixture(autouse=True)
def _no_captures(monkeypatch):
    """Tests must not fill server/captures/ with synthetic photos."""
    monkeypatch.setattr(main, "SAVE_CAPTURES", False)
