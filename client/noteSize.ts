// The note text's size (malachite#52): a step of the usual size, for the editor and the Read view only (the
// interface keeps its size: that is the kit's interface scale). Remembered in this browser.
import { useEffect, useState } from "react";

export const NOTE_SIZES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
const KEY = "malachite.noteSize";

/** The size `by` steps from `size`, held at the smallest and the largest. */
export const stepSize = (size: number, by: number) => {
  const i = NOTE_SIZES.indexOf(size);
  return NOTE_SIZES[Math.max(0, Math.min(NOTE_SIZES.length - 1, (i < 0 ? NOTE_SIZES.indexOf(1) : i) + by))];
};

export function useNoteSize() {
  const [size, setSize] = useState(() => { try { const v = Number(localStorage.getItem(KEY)); return NOTE_SIZES.includes(v) ? v : 1; } catch { return 1; } });
  useEffect(() => { try { localStorage.setItem(KEY, String(size)); } catch { /* not kept: this visit only */ } }, [size]);
  return { size, bigger: () => setSize((s) => stepSize(s, 1)), smaller: () => setSize((s) => stepSize(s, -1)), usual: () => setSize(1) };
}
