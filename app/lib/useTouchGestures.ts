"use client";

import { useEffect, useRef, type RefObject } from "react";

type ElementRef<T extends HTMLElement = HTMLElement> = RefObject<T | null>;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[data-touch-ignore]",
  "[data-no-swipe]",
].join(",");

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number) {
  if (!step) return value;
  return Math.round(value / step) * step;
}

function touchDistance(touches: TouchList) {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return 0;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function touchPoint(touch: Touch) {
  return { x: touch.clientX, y: touch.clientY };
}

function touchCenter(touches: TouchList) {
  let x = 0;
  let y = 0;
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (!touch) continue;
    x += touch.clientX;
    y += touch.clientY;
  }
  const count = Math.max(1, touches.length);
  return { x: x / count, y: y / count };
}

export function isEditableTouchTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const element = target.closest("input, textarea, select, [contenteditable='true']");
  return Boolean(element);
}

export function isInteractiveTouchTarget(target: EventTarget | null, extraSelector?: string) {
  if (!(target instanceof HTMLElement)) return false;
  if (extraSelector && target.closest(extraSelector)) return true;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
}

export function usePinchZoom<T extends HTMLElement>(
  ref: ElementRef<T>,
  options: {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
    disabled?: boolean;
    step?: number;
    ignoreInteractive?: boolean;
    ignoreSelector?: string;
    effectKey?: unknown;
  },
) {
  const valueRef = useRef(options.value);
  const onChangeRef = useRef(options.onChange);
  const optionsRef = useRef(options);

  useEffect(() => {
    valueRef.current = options.value;
    onChangeRef.current = options.onChange;
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const element = ref.current;
    if (!element || options.disabled) return;

    let pinching = false;
    let startDistance = 0;
    let startValue = valueRef.current;

    const handleStart = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (event.touches.length !== 2) return;
      if (current.ignoreInteractive !== false && isInteractiveTouchTarget(event.target, current.ignoreSelector)) return;
      startDistance = touchDistance(event.touches);
      startValue = valueRef.current;
      pinching = startDistance > 0;
    };

    const handleMove = (event: TouchEvent) => {
      if (!pinching || event.touches.length !== 2 || startDistance <= 0) return;
      const currentDistance = touchDistance(event.touches);
      if (currentDistance <= 0) return;

      event.preventDefault();
      const current = optionsRef.current;
      const raw = startValue * (currentDistance / startDistance);
      const next = clamp(roundTo(raw, current.step ?? 0.01), current.min, current.max);
      onChangeRef.current(next);
    };

    const handleEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinching = false;
        startDistance = 0;
      }
    };

    element.addEventListener("touchstart", handleStart, { passive: true });
    element.addEventListener("touchmove", handleMove, { passive: false });
    element.addEventListener("touchend", handleEnd, { passive: true });
    element.addEventListener("touchcancel", handleEnd, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleStart);
      element.removeEventListener("touchmove", handleMove);
      element.removeEventListener("touchend", handleEnd);
      element.removeEventListener("touchcancel", handleEnd);
    };
  }, [ref, options.disabled, options.effectKey]);
}

export function useDoubleTap<T extends HTMLElement>(
  ref: ElementRef<T>,
  onDoubleTap: () => void,
  options: {
    disabled?: boolean;
    maxDelayMs?: number;
    maxDistancePx?: number;
    ignoreInteractive?: boolean;
    ignoreSelector?: string;
    effectKey?: unknown;
  } = {},
) {
  const onDoubleTapRef = useRef(onDoubleTap);
  const optionsRef = useRef(options);

  useEffect(() => {
    onDoubleTapRef.current = onDoubleTap;
    optionsRef.current = options;
  }, [onDoubleTap, options]);

  useEffect(() => {
    const element = ref.current;
    if (!element || options.disabled) return;

    let multiTouch = false;
    let lastTap: { time: number; x: number; y: number } | null = null;

    const handleStart = (event: TouchEvent) => {
      if (event.touches.length > 1) multiTouch = true;
    };

    const handleEnd = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (multiTouch) {
        if (event.touches.length === 0) multiTouch = false;
        return;
      }
      if (event.changedTouches.length !== 1 || event.touches.length > 0) return;
      if (current.ignoreInteractive !== false && isInteractiveTouchTarget(event.target, current.ignoreSelector)) return;

      const now = Date.now();
      const point = touchPoint(event.changedTouches[0]);
      const maxDelay = current.maxDelayMs ?? 280;
      const maxDistance = current.maxDistancePx ?? 28;

      if (
        lastTap &&
        now - lastTap.time <= maxDelay &&
        Math.hypot(point.x - lastTap.x, point.y - lastTap.y) <= maxDistance
      ) {
        event.preventDefault();
        lastTap = null;
        onDoubleTapRef.current();
        return;
      }

      lastTap = { time: now, ...point };
    };

    const cancel = () => {
      lastTap = null;
      multiTouch = false;
    };

    element.addEventListener("touchstart", handleStart, { passive: true });
    element.addEventListener("touchend", handleEnd, { passive: false });
    element.addEventListener("touchcancel", cancel, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleStart);
      element.removeEventListener("touchend", handleEnd);
      element.removeEventListener("touchcancel", cancel);
    };
  }, [ref, options.disabled, options.effectKey]);
}

export function useSwipeGesture<T extends HTMLElement>(
  ref: ElementRef<T>,
  options: {
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    onSwipeUp?: () => void;
    onSwipeDown?: () => void;
    disabled?: boolean;
    minDistancePx?: number;
    maxCrossAxisPx?: number;
    ignoreInteractive?: boolean;
    ignoreSelector?: string;
    effectKey?: unknown;
  },
) {
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const element = ref.current;
    if (!element || options.disabled) return;

    let start: { x: number; y: number } | null = null;
    let tracking = false;

    const handleStart = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (event.touches.length !== 1) {
        tracking = false;
        start = null;
        return;
      }
      if (current.ignoreInteractive !== false && isInteractiveTouchTarget(event.target, current.ignoreSelector)) {
        tracking = false;
        start = null;
        return;
      }
      tracking = true;
      start = touchPoint(event.touches[0]);
    };

    const handleEnd = (event: TouchEvent) => {
      if (!tracking || !start || event.changedTouches.length !== 1) return;

      const current = optionsRef.current;
      const end = touchPoint(event.changedTouches[0]);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const minDistance = current.minDistancePx ?? 64;
      const maxCrossAxis = current.maxCrossAxisPx ?? 72;

      tracking = false;
      start = null;

      if (absX >= minDistance && absY <= maxCrossAxis) {
        if (dx < 0) current.onSwipeLeft?.();
        else current.onSwipeRight?.();
        return;
      }

      if (absY >= minDistance && absX <= maxCrossAxis) {
        if (dy < 0) current.onSwipeUp?.();
        else current.onSwipeDown?.();
      }
    };

    const cancel = () => {
      tracking = false;
      start = null;
    };

    element.addEventListener("touchstart", handleStart, { passive: true });
    element.addEventListener("touchend", handleEnd, { passive: true });
    element.addEventListener("touchcancel", cancel, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleStart);
      element.removeEventListener("touchend", handleEnd);
      element.removeEventListener("touchcancel", cancel);
    };
  }, [ref, options.disabled, options.effectKey]);
}

export function useMultiTouchSwipe<T extends HTMLElement>(
  ref: ElementRef<T>,
  options: {
    fingers: 2 | 3;
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    onSwipeUp?: () => void;
    onSwipeDown?: () => void;
    disabled?: boolean;
    minDistancePx?: number;
    maxCrossAxisPx?: number;
    ignoreInteractive?: boolean;
    ignoreSelector?: string;
    effectKey?: unknown;
  },
) {
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const element = ref.current;
    if (!element || options.disabled) return;

    let start: { x: number; y: number } | null = null;
    let latest: { x: number; y: number } | null = null;
    let tracking = false;

    const reset = () => {
      start = null;
      latest = null;
      tracking = false;
    };

    const handleStart = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (event.touches.length !== current.fingers) {
        reset();
        return;
      }
      if (current.ignoreInteractive !== false && isInteractiveTouchTarget(event.target, current.ignoreSelector)) {
        reset();
        return;
      }
      start = touchCenter(event.touches);
      latest = start;
      tracking = true;
    };

    const handleMove = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (!tracking || event.touches.length !== current.fingers) return;
      latest = touchCenter(event.touches);
      event.preventDefault();
    };

    const handleEnd = (event: TouchEvent) => {
      const current = optionsRef.current;
      if (!tracking || !start || !latest || event.touches.length >= current.fingers) return;

      const dx = latest.x - start.x;
      const dy = latest.y - start.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const minDistance = current.minDistancePx ?? 64;
      const maxCrossAxis = current.maxCrossAxisPx ?? 72;
      reset();

      if (absX >= minDistance && absY <= maxCrossAxis) {
        if (dx < 0) current.onSwipeLeft?.();
        else current.onSwipeRight?.();
        return;
      }

      if (absY >= minDistance && absX <= maxCrossAxis) {
        if (dy < 0) current.onSwipeUp?.();
        else current.onSwipeDown?.();
      }
    };

    element.addEventListener("touchstart", handleStart, { passive: true });
    element.addEventListener("touchmove", handleMove, { passive: false });
    element.addEventListener("touchend", handleEnd, { passive: true });
    element.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleStart);
      element.removeEventListener("touchmove", handleMove);
      element.removeEventListener("touchend", handleEnd);
      element.removeEventListener("touchcancel", reset);
    };
  }, [ref, options.disabled, options.effectKey]);
}

export function useTrackpadPinch<T extends HTMLElement>(
  ref: ElementRef<T>,
  options: {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
    disabled?: boolean;
    step?: number;
    /**
     * When true, treat `step` as a log-space sensitivity and scale the zoom
     * change by the wheel `deltaY`. This makes trackpad pinch-zoom (many small
     * deltas) feel smooth and proportional instead of jumping a fixed amount per
     * event, while mouse-wheel notches stay capped. Defaults to the legacy
     * fixed-step behaviour so existing consumers are unaffected.
     */
    multiplicative?: boolean;
    ignoreInteractive?: boolean;
    ignoreSelector?: string;
    effectKey?: unknown;
  },
) {
  const valueRef = useRef(options.value);
  const onChangeRef = useRef(options.onChange);
  const optionsRef = useRef(options);

  useEffect(() => {
    valueRef.current = options.value;
    onChangeRef.current = options.onChange;
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const element = ref.current;
    if (!element || options.disabled) return;

    const handleWheel = (event: WheelEvent) => {
      const current = optionsRef.current;
      if (!event.ctrlKey && !event.metaKey) return;
      if (current.ignoreInteractive !== false && isInteractiveTouchTarget(event.target, current.ignoreSelector)) return;

      event.preventDefault();

      if (current.multiplicative) {
        // deltaY-proportional zoom: small trackpad-pinch deltas produce smooth
        // fine steps; large mouse-wheel notches are clamped to one capped step.
        const sensitivity = current.step ?? 0.01;
        const factor = clamp(Math.exp(-event.deltaY * sensitivity), 0.8, 1.25);
        const next = clamp(valueRef.current * factor, current.min, current.max);
        onChangeRef.current(next);
        return;
      }

      const step = current.step ?? 0.04;
      const direction = event.deltaY < 0 ? 1 : -1;
      const next = clamp(roundTo(valueRef.current + direction * step, step), current.min, current.max);
      onChangeRef.current(next);
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [ref, options.disabled, options.effectKey]);
}
