from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import utd_reader  # noqa: E402


class UtdGraphicsForTermsTests(unittest.TestCase):
    def test_graphics_for_terms_exposes_thumbnail_and_source_topic(self) -> None:
        index = (
            {
                "term": "Definitions angina CASS",
                "title": "Coronary artery surgery study definitions of angina",
                "id": 59572,
                "topic_id": 12345,
            },
        )

        with patch.object(utd_reader, "_graphic_index", return_value=index):
            results = utd_reader.graphics_for_terms(["angina"], limit=5)

        self.assertEqual(
            results,
            [
                {
                    "id": 59572,
                    "title": "Coronary artery surgery study definitions of angina",
                    "url": "/utd/graphic/59572",
                    "thumb_url": "/utd/thumb/59572",
                    "source_href": "/uptodate?t=12345&g=59572",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
