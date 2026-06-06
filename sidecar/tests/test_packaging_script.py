from __future__ import annotations

from pathlib import Path


def test_macos_packaging_collects_trafilatura_settings_data() -> None:
    script = (
        Path(__file__).resolve().parents[1]
        / "packaging"
        / "build_macos_arm64.sh"
    )

    text = script.read_text(encoding="utf-8")

    assert "--collect-data trafilatura" in text


def test_macos_installer_runs_packaged_sidecar_smoke_test() -> None:
    script = (
        Path(__file__).resolve().parents[1]
        / "packaging"
        / "build_macos_installer.sh"
    )

    text = script.read_text(encoding="utf-8")

    assert "smoke_test_macos_sidecar.py" in text
    assert "COGNIOS_SKIP_PACKAGED_SMOKE" in text
