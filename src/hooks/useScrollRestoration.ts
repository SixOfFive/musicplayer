import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Remember scroll position per route entry so Back/Forward restores the user
 * to exactly where they were. Keyed on `location.key` (stable for each
 * history entry in React Router 6 — POP navigations get the old key back).
 *
 * Two phases:
 *   1. While a route is active, every scroll event synchronously records the
 *      container's scrollTop against the current key.
 *   2. On route change, restore the saved scrollTop in a useLayoutEffect so
 *      the first paint is already at the correct position, then retry a few
 *      frames to catch content that mounts async (SQLite → render).
 *
 * IMPORTANT: effect cleanup does NOT save scroll. By the time React's cleanup
 * phase runs, the browser has already updated scrollTop for the new route
 * (usually to 0 or clamped to new content height), which would overwrite the
 * correct value for the route we just left. We rely on the synchronous scroll
 * listener having already captured the latest value.
 */

const scrollMap = new Map<string, number>();

export function useScrollRestoration(containerRef: React.RefObject<HTMLElement | null>) {
  const location = useLocation();
  const key = location.key;
  const keyRef = useRef(key);

  // Save on every scroll event for the current key. No rAF throttling — a
  // Map.set is cheap, and missing the final scroll before a navigation is
  // worse than a few microseconds of extra work during active scrolling.
  useEffect(() => {
    keyRef.current = key;
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => { scrollMap.set(keyRef.current, el.scrollTop); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      // NB: deliberately NOT saving scrollTop here — by cleanup time the DOM
      // has already updated and el.scrollTop is no longer the value the user
      // was looking at.
    };
  }, [key, containerRef]);

  // Restore saved position on route change. useLayoutEffect runs before paint
  // so users never see the content at the "wrong" scroll briefly.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const target = scrollMap.get(key) ?? 0;
    el.scrollTop = target;

    // Content often loads async (IPC → SQLite → render). If scrollHeight
    // hasn't grown enough yet, scrollTop clamps below target. Retry for
    // ~500ms while the container's measured height catches up.
    let attempts = 0;
    const retry = () => {
      if (!el || attempts++ > 30) return;
      if (Math.abs(el.scrollTop - target) > 1 && el.scrollHeight >= target + el.clientHeight) {
        el.scrollTop = target;
      }
      if (Math.abs(el.scrollTop - target) > 1 && attempts <= 30) {
        requestAnimationFrame(retry);
      }
    };
    requestAnimationFrame(retry);
  }, [key, containerRef]);
}
