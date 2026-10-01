import { useEffect, useRef, useState } from "react";

export type StatFlash = "up" | "down" | null;

/**
 * Ease a displayed number toward `value`. The first value does not flash.
 * `delta` is the difference that started the current tween.
 */
export function useAnimatedNumber(value: number, duration = 700) {
  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<StatFlash>(null);
  const [delta, setDelta] = useState(0);
  const fromRef = useRef(value);
  const displayRef = useRef(value);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      fromRef.current = value;
      displayRef.current = value;
      setDisplay(value);
      return;
    }

    const from = fromRef.current;
    const diff = value - from;
    if (Math.abs(diff) < 0.01) {
      fromRef.current = value;
      displayRef.current = value;
      setDisplay(value);
      return;
    }

    setDelta(diff);
    setFlash(diff > 0 ? "up" : "down");
    const flashTimer = window.setTimeout(() => setFlash(null), 900);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + diff * eased;
      displayRef.current = current;
      setDisplay(current);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(flashTimer);
      fromRef.current = displayRef.current;
    };
  }, [value, duration]);

  return { display, flash, delta };
}
