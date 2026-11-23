from __future__ import annotations

import sys
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import qbank_reader  # noqa: E402


class _FakeConn:
    def __init__(self, row: dict) -> None:
        self._row = row

    def execute(self, _sql: str, _params: tuple[int]) -> "_FakeConn":
        return self

    def fetchone(self) -> dict:
        return self._row

    def close(self) -> None:
        return None


class QBankAmbossMediaTests(unittest.TestCase):
    def _progress_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE qbank_progress (
                user_email TEXT NOT NULL,
                db TEXT NOT NULL,
                used_ids TEXT NOT NULL DEFAULT '[]',
                marked_ids TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_email, db)
            )
            """
        )
        return conn

    def test_amboss_qbank_media_falls_back_to_shared_amboss_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            qbank_dir = root / "Amboss - USMLE Step 12025"
            (qbank_dir / "media-E").mkdir(parents=True)
            shared_images = root / "amboss" / "Images"
            shared_images.mkdir(parents=True)

            name = "big_5beb846679d0f.jpg"
            payload = b"\xff\xd8\xffshared amboss image"
            (shared_images / name).write_bytes(payload)

            bank = qbank_reader.BankInfo(
                "amboss1",
                qbank_dir / "ambossqb-USMLE Step 12025.db",
                "amboss",
                1,
                None,
                "1",
                "AMBOSS Step 1",
            )
            row = {"mediaName": "", "otherMedias": name, "question": "", "explanation": ""}

            with patch.object(qbank_reader, "_resolve_bank", return_value=bank):
                with patch.object(qbank_reader, "_bank_dir", return_value=qbank_dir):
                    with patch.object(qbank_reader, "_shared_amboss_images_dir", return_value=shared_images, create=True):
                        with patch.object(qbank_reader, "_conn", return_value=_FakeConn(row)):
                            response = qbank_reader.media(1451, name, db="amboss1")

        self.assertEqual(response.body, payload)
        self.assertEqual(response.media_type, "image/jpeg")

    def test_show_hint_block_becomes_native_disclosure(self) -> None:
        raw = """
        <p>Question stem.</p>
        <button style="margin-bottom: 20px" onclick="var x = document.getElementById('hintdiv');">Show Hint</button>
        <div id="hintdiv" style="display:none;"><p>Use the rash clue.</p></div>
        """

        cleaned = qbank_reader._clean_html(raw)

        self.assertIn('<details class="qbank-hint">', cleaned)
        self.assertIn("<summary>Show Hint</summary>", cleaned)
        self.assertIn('<div class="qbank-hint-body"><p>Use the rash clue.</p></div>', cleaned)
        self.assertNotIn("onclick", cleaned)
        self.assertNotIn("display:none", cleaned)

    def test_save_progress_allows_dynamic_bank_missing_from_other_map(self) -> None:
        conn = self._progress_conn()
        try:
            qbank_reader._save_progress(
                conn,
                "user@example.test",
                used_by_db={"amboss1": [1451]},
                marked_by_db={"step1": []},
            )
            row = conn.execute(
                "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
                ("user@example.test", "amboss1"),
            ).fetchone()
        finally:
            conn.close()

        self.assertIsNotNone(row)
        self.assertEqual(json.loads(row["used_ids"]), [1451])
        self.assertEqual(json.loads(row["marked_ids"]), [])


if __name__ == "__main__":
    unittest.main()
