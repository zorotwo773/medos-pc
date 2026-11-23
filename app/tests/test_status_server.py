from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import status_server  # noqa: E402


class StatusServerTests(unittest.TestCase):
    def test_frontend_error_log_wins_over_stale_ready_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp)
            (app_dir / "frontend.log").write_text(
                "\n".join(
                    [
                        "> medos@0.1.0 start",
                        "Next.js 16.2.3",
                        "Ready in 518ms",
                    ]
                ),
                encoding="utf-8",
            )
            (app_dir / "frontend.err").write_text(
                "Error: Could not find a production build in the '.next' directory.\n",
                encoding="utf-8",
            )

            with patch.object(status_server, "APP_DIR", app_dir):
                with patch.object(status_server, "is_up", return_value=False):
                    result = status_server.get_status()

        self.assertEqual(result["frontend"]["state"], "error")
        self.assertEqual(result["frontend"]["label"], "error")
        self.assertTrue(
            any("production build" in line for line in result["frontend"]["lines"])
        )

    def test_dead_pid_with_ready_log_is_reported_as_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp)
            (app_dir / "backend.err").write_text(
                "INFO:     Uvicorn running on http://0.0.0.0:8002\n",
                encoding="utf-8",
            )
            (app_dir / "backend.pid").write_text("999999\n", encoding="utf-8")

            with patch.object(status_server, "APP_DIR", app_dir):
                with patch.object(status_server, "is_up", return_value=False):
                    result = status_server.get_status()

        self.assertEqual(result["backend"]["state"], "error")
        self.assertEqual(result["backend"]["label"], "stopped")
        self.assertTrue(any("stopped" in line.lower() for line in result["backend"]["lines"]))

    def test_port_probe_timeout_stays_short_for_responsive_status_polling(self) -> None:
        with patch.object(status_server.socket, "create_connection", side_effect=OSError) as conn:
            self.assertFalse(status_server.is_up(3000))

        self.assertLessEqual(conn.call_args.kwargs["timeout"], 0.25)


if __name__ == "__main__":
    unittest.main()
