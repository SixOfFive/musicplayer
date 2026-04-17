import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Remember scroll position per route path so back/forward navigation puts the
 * user back exactly where they were — no more scrolling miles through albums
 * after visiting Liked Songs.
 *
 * Strategy:
 *   1. While a path is active, continuously record its scrollTop on every
 *      scroll event (rAF-throttled so we're not thrashing state).
 *   2. When the location changes, restore the saved scrollTop on the next
 *      paint. Retry a few times with short delays to handle async content
 *      (album/track lists that finish loading after render).
 */

// Module-scoped so state survives StrictMode double-mounts + persists for
// the whole app session.
const scrollMap = new Map<string, number>();

export function useScrollRestoration(containerRef: React.RefObject<HTMLElement | null>) {
  const location = useLocation();
  const currentPath = location.key + '|' + location.pathname + location.search;
  const pathRef = useRef(currentPath);

  // 1) Track scroll on the active path. Re-register whenever the path changes
  //    so the handler closes over the current key.
  useEffect(() => {
    pathRef.current = currentPath;
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrollMap.set(pathRef.current, el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      // Snapshot final scroll position when leaving (scroll event doesn't fire on unmount).
      scrollMap.set(pathRef.current, el.scrollTop);
    };
  }, [currentPath, containerRef]);

  // 2) On path change, restore the remembered scrollTop. Use useLayoutEffect
  //    so the first paint shows the correct position; retry on rAF for content
  //    that mounts after the initial render.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const target = scrollMap.get(currentPath) ?? 0;
    el.scrollTop = target;

    // Content often finishes loading async (IPC → SQLite → render). If the
    // container doesn't yet have enough scrollHeight, scrollTop will clamp
    // below our target. Retry up to ~500ms at 60fps.
    let attempts = 0;
    const retry = () => {
      if (!el || attempts++ > 30) return;
      if (el.scrollTop < target - 1 && el.scrollHeight >= target + el.clientHeight) {
        el.scrollTop = target;
      }
      if (attempts <= 30 && Math.abs(el.scrollTop - target) > 1) {
        requestAnimationFrame(retry);
      }
    };
    requestAnimationFrame(retry);
  }, [currentPath, containerRef]);
}
