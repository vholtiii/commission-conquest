import { toast } from "sonner";

/**
 * Toasts that can wait. While a hit reel or its result card holds the screen
 * the week's news is queued here and released once the player moves on.
 */
const queue: Array<() => void> = [];
let held = false;

export function holdAnnouncements(on: boolean): void {
  held = on;
  if (!on) flushAnnouncements();
}

export function flushAnnouncements(): void {
  const batch = queue.splice(0);
  for (const show of batch) show();
}

function later(show: () => void): void {
  if (held) queue.push(show);
  else show();
}

export const announce = {
  message: (...args: Parameters<typeof toast.message>) => later(() => toast.message(...args)),
  success: (...args: Parameters<typeof toast.success>) => later(() => toast.success(...args)),
  warning: (...args: Parameters<typeof toast.warning>) => later(() => toast.warning(...args)),
  error: (...args: Parameters<typeof toast.error>) => later(() => toast.error(...args)),
};
