"""Aggregate, filename-free progress for MedOS setup operations."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    phase: str
    message: str
    relative_path: str
    completed_bytes: int
    total_bytes: int
    current_bytes: int
    current_total: int
    completed_items: int
    total_items: int
    bytes_per_second: float
    eta_seconds: float | None


def install_phase_for(role: str) -> str:
    """Return the stable user-facing install phase for a manifest role."""

    return "installing-library" if role in {"data", "model"} else "installing-application"


class MacroProgressEmitter:
    """Rate-limit aggregate progress while forcing lifecycle boundaries."""

    def __init__(
        self,
        sink: Callable[[ProgressEvent], None],
        *,
        clock: Callable[[], float],
        min_interval_seconds: float = 0.25,
    ) -> None:
        if (
            isinstance(min_interval_seconds, bool)
            or not isinstance(min_interval_seconds, (int, float))
            or min_interval_seconds <= 0
        ):
            raise ValueError("min_interval_seconds must be positive")
        self.sink = sink
        self.clock = clock
        self.min_interval_seconds = float(min_interval_seconds)
        self._started_at: float | None = None
        self._starting_completed_bytes = 0
        self._last_emitted_at: float | None = None
        self._last_event: ProgressEvent | None = None
        self._completed_bytes = 0
        self._total_bytes = 0
        self._completed_items = 0
        self._total_items = 0

    def emit(self, event: ProgressEvent, force: bool = False) -> None:
        now = self.clock()
        completed_bytes = max(self._completed_bytes, max(0, event.completed_bytes))
        total_bytes = max(self._total_bytes, max(0, event.total_bytes), completed_bytes)
        completed_items = max(self._completed_items, max(0, event.completed_items))
        total_items = max(self._total_items, max(0, event.total_items), completed_items)
        self._completed_bytes = completed_bytes
        self._total_bytes = total_bytes
        self._completed_items = completed_items
        self._total_items = total_items

        if self._started_at is None:
            self._started_at = now
            self._starting_completed_bytes = completed_bytes
        elapsed = max(0.0, now - self._started_at)
        transferred = max(0, completed_bytes - self._starting_completed_bytes)
        rate = (
            transferred / elapsed
            if elapsed > 0
            else max(0.0, event.bytes_per_second)
        )
        remaining = max(0, total_bytes - completed_bytes)
        eta = remaining / rate if rate > 0 else None
        normalized = replace(
            event,
            relative_path="",
            completed_bytes=completed_bytes,
            total_bytes=total_bytes,
            completed_items=completed_items,
            total_items=total_items,
            bytes_per_second=rate,
            eta_seconds=eta,
        )

        phase_changed = self._last_event is None or normalized.phase != self._last_event.phase
        interval_elapsed = (
            self._last_emitted_at is None
            or now - self._last_emitted_at >= self.min_interval_seconds
        )
        if total_items > 0:
            completed = completed_items >= total_items
        else:
            completed = total_bytes > 0 and completed_bytes >= total_bytes
        completion_changed = completed and normalized != self._last_event
        if not (force or phase_changed or interval_elapsed or completion_changed):
            return
        self.sink(normalized)
        self._last_emitted_at = now
        self._last_event = normalized


__all__ = ["MacroProgressEmitter", "ProgressEvent", "install_phase_for"]
