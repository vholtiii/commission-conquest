import { useEffect, useState, type RefObject } from "react";

/** Height of one 2.35:1 bar for the element the ref points at. Animates open. */
export function useLetterbox(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [bar, setBar] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setBar(0);
      return;
    }
    const goal = () => {
      const content = el.clientWidth / 2.35;
      return Math.max(0, (el.clientHeight - content) / 2);
    };
    const target = goal();
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = k * k * (3 - 2 * k);
      setBar(target * e);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => setBar(goal());
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [active, ref]);

  return bar;
}
