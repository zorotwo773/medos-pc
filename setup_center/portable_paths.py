"""Portable path validation shared by release manifests and preparation."""

from __future__ import annotations

import unicodedata
from pathlib import PurePosixPath
from types import MappingProxyType
from typing import Mapping


class PortablePathError(ValueError):
    """Raised when a relative release path is not portable across supported filesystems."""


_RESERVED = frozenset({"CON", "PRN", "AUX", "NUL"}) | frozenset(
    f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
)
_FORBIDDEN = frozenset('<>:"\\|?*')

LEGACY_BOOK_RENAMES: Mapping[PurePosixPath, PurePosixPath] = MappingProxyType(
    {
        PurePosixPath("Infectious Disease/Micro HARRISONa\u0302\x80\x99S Infectious Diseases.pdf"):
            PurePosixPath("Infectious Disease/Micro HARRISONS Infectious Diseases.pdf"),
        PurePosixPath("Miscellaneous/embryology Inderbir_Singha\u0302\x80\x99s_Human_Embryology.pdf"):
            PurePosixPath("Miscellaneous/embryology Inderbir Singhs Human Embryology.pdf"),
        PurePosixPath("Neurology/Neuro Adams and Victora\u0302\x80\x99s Principles of Neurology.2019.11th ed.pdf"):
            PurePosixPath("Neurology/Neuro Adams and Victors Principles of Neurology 2019 11th ed.pdf"),
        PurePosixPath("Neurology/Neuro Localization in Clinical Neurology-Paul Brazis, Joseph C. Masdeu, JoseI\u0300\x81 Biller.pdf"):
            PurePosixPath("Neurology/Neuro Localization in Clinical Neurology - Paul Brazis, Joseph C. Masdeu, Jose Biller.pdf"),
        PurePosixPath("Neurology/neuro Vol_7_ the Nervous System Part Ia\u0302\x80\x94Brain.pdf"):
            PurePosixPath("Neurology/neuro Vol 7 - the Nervous System Part I - Brain.pdf"),
        PurePosixPath("Neurology/neuro Vol_7_Nervous System Part IIa\u0302\x80\x94Spinal Cord and Peripheral Motor and Sensory Systems.pdf"):
            PurePosixPath("Neurology/neuro Vol 7 - Nervous System Part II - Spinal Cord and Peripheral Motor and Sensory Systems.pdf"),
        PurePosixPath("Obstetrics & Gynecology/OBSTETRICS DC Duttaa\u0302\x80\x99s__OBSTETRICS.pdf"):
            PurePosixPath("Obstetrics & Gynecology/OBSTETRICS DC Duttas OBSTETRICS.pdf"),
    }
)


def portable_relative_path(value: str | PurePosixPath, field: str) -> PurePosixPath:
    """Return a portable relative POSIX path or raise ``PortablePathError``."""

    text = value.as_posix() if isinstance(value, PurePosixPath) else value
    if not isinstance(text, str) or not text or unicodedata.normalize("NFC", text) != text:
        raise PortablePathError(f"{field} must be a non-empty NFC path")
    path = PurePosixPath(text)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise PortablePathError(f"unsafe {field}: {text!r}")
    for part in path.parts:
        if part[-1:] in {" ", "."} or any(character in _FORBIDDEN for character in part):
            raise PortablePathError(f"nonportable {field}: {text!r}")
        if part.split(".", 1)[0].upper() in _RESERVED:
            raise PortablePathError(f"reserved {field}: {text!r}")
        for character in part:
            if unicodedata.category(character) in {"Cc", "Cs", "Co"}:
                raise PortablePathError(f"nonportable {field}: {text!r}")
    return path


def portable_path_key(value: PurePosixPath) -> str:
    """Return the collision key for case-insensitive Unicode-normalizing filesystems."""

    return unicodedata.normalize("NFC", value.as_posix()).casefold()


__all__ = [
    "LEGACY_BOOK_RENAMES",
    "PortablePathError",
    "portable_path_key",
    "portable_relative_path",
]
