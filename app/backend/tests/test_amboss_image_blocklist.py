from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import amboss_reader  # noqa: E402


class AmbossImageBlocklistTests(unittest.TestCase):
    def setUp(self) -> None:
        amboss_reader.card_images.cache_clear()
        amboss_reader._is_blocked_image_hash.cache_clear()

    def test_qxmd_promo_image_is_removed_from_article_html(self) -> None:
        html = """
        <p>before</p>
        <img src="../Images/big_5f61d6243023a.jpg" alt="Calculate by QxMD">
        <img data-source="../Images/big_5f61d6243023a.jpg">
        <img src="../Images/big_614c1fcd570b8.jpg" alt="valid">
        """

        rewritten = amboss_reader._rewrite_html(1, html)

        self.assertNotIn("big_5f61d6243023a.jpg", rewritten)
        self.assertIn('/amboss/image/big_614c1fcd570b8.jpg', rewritten)

    def test_qxmd_promo_image_endpoint_is_blocked_even_if_file_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            images = bundle / "Images"
            images.mkdir()
            (images / "big_5f61d6243023a.jpg").write_bytes(b"not really a jpeg")

            with patch.object(amboss_reader, "_bundle_dir", return_value=bundle):
                with self.assertRaises(HTTPException) as ctx:
                    amboss_reader.image("big_5f61d6243023a.jpg")

        self.assertEqual(ctx.exception.status_code, 404)

    def test_qxmd_promo_content_hash_blocks_any_alias(self) -> None:
        payload = b"same promo image bytes under a fresh filename"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            images = bundle / "Images"
            images.mkdir()
            alias = "big_unlisted_alias.jpg"
            (images / alias).write_bytes(payload)

            with patch.object(amboss_reader, "_bundle_dir", return_value=bundle):
                with patch.object(amboss_reader, "_BLOCKED_IMAGE_SIZES", {len(payload)}):
                    with patch.object(amboss_reader, "_BLOCKED_IMAGE_SHA256", {digest}):
                        amboss_reader._is_blocked_image_hash.cache_clear()
                        self.assertTrue(amboss_reader._is_blocked_image_name(alias))
                        rewritten = amboss_reader._rewrite_html(
                            1,
                            f'<img src="../Images/{alias}" alt="Calculate by QxMD">',
                        )

        self.assertNotIn(alias, rewritten)

    def test_static_images_alias_is_blocked_before_static_mount(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            images = bundle / "Images"
            images.mkdir()
            (images / "big_5f61d6243023a.jpg").write_bytes(b"not really a jpeg")

            app = FastAPI()
            app.include_router(amboss_reader.router)
            app.mount("/amboss/Images", StaticFiles(directory=str(images)))

            with patch.object(amboss_reader, "_bundle_dir", return_value=bundle):
                response = TestClient(app).get("/amboss/Images/big_5f61d6243023a.jpg")

        self.assertEqual(response.status_code, 404)

    def test_card_images_omits_blocked_image(self) -> None:
        class FakeConn:
            def execute(self, _sql: str, _params: tuple[int]) -> "FakeConn":
                return self

            def fetchone(self) -> dict:
                return {"id": 7, "title": "Atrial fibrillation", "doc": b"encrypted"}

            def close(self) -> None:
                return None

        html = """
        <img src="../Images/big_5f61d6243023a.jpg">
        <img src="../Images/big_614c1fcd570b8.jpg">
        """

        with patch.object(amboss_reader, "_conn", return_value=FakeConn()):
            with patch.object(amboss_reader, "decrypt_doc", return_value=html):
                images = amboss_reader.card_images(7, limit=10)

        self.assertEqual(
            images,
            [
                {
                    "name": "big_614c1fcd570b8.jpg",
                    "url": "/amboss/image/big_614c1fcd570b8.jpg",
                    "title": "Atrial fibrillation",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
