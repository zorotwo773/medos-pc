from __future__ import annotations

import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


class WindowsLauncherScriptTests(unittest.TestCase):
    def test_root_launcher_does_not_hide_frontend_build_before_status_page(self) -> None:
        root_start = (ROOT_DIR / "START.ps1").read_text(encoding="utf-8")

        self.assertNotIn("npm run build", root_start)

    def test_desktop_vbs_launches_powershell_without_profile(self) -> None:
        launch_vbs = (ROOT_DIR / "launch.vbs").read_text(encoding="utf-8")

        self.assertIn("-NoProfile", launch_vbs)

    def test_app_launcher_builds_after_status_page_is_started(self) -> None:
        app_start = (ROOT_DIR / "app" / "START.ps1").read_text(encoding="utf-8")

        status_index = app_start.index("Start status server")
        build_index = app_start.index("Invoke-FrontendBuildIfNeeded", status_index)
        frontend_index = app_start.index("Start frontend hidden")

        self.assertLess(status_index, build_index)
        self.assertLess(build_index, frontend_index)


if __name__ == "__main__":
    unittest.main()
