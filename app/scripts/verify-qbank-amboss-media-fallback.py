from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import qbank_reader as qbank  # noqa: E402


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    response = qbank.media(948, "big_5b55d3f2afa1d.jpg", db="amboss1")
    body = getattr(response, "body", b"")
    assert_true(getattr(response, "media_type", "") == "image/jpeg", "QID 948 Amboss stem media should be served as JPEG")
    assert_true(body.startswith(b"\xff\xd8\xff"), "QID 948 Amboss stem media should return real JPEG bytes")
    assert_true(len(body) > 10_000, "QID 948 Amboss stem media response is unexpectedly small")

    response = qbank.media(11179, "big_58458dc407e03.jpg", db="amboss1")
    body = getattr(response, "body", b"")
    assert_true(getattr(response, "media_type", "") == "image/jpeg", "QID 11179 Amboss explanation media should be served as JPEG")
    assert_true(body.startswith(b"\xff\xd8\xff"), "QID 11179 Amboss explanation media should return real JPEG bytes")
    assert_true(len(body) > 10_000, "QID 11179 Amboss explanation media response is unexpectedly small")

    print("QBank Amboss media fallback checks passed")


if __name__ == "__main__":
    main()
