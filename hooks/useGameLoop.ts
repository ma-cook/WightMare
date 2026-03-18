import { useEffect, useRef } from 'react';

type LoopCallback = (dt: number, timestamp: number) => void;

/**
 * Drives a requestAnimationFrame game loop.
 *
 * @param callback - called each frame with `dt` (delta-time in seconds,
 *                   clamped to 50 ms max) and the raw rAF timestamp.
 * @param isRunning - set to false to pause / stop the loop.
 */
export function useGameLoop(callback: LoopCallback, isRunning: boolean): void {
  const callbackRef = useRef<LoopCallback>(callback);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // Keep a stable ref so the loop closure doesn't go stale.
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!isRunning) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    lastTimeRef.current = performance.now();

    const loop = (timestamp: number): void => {
      const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = timestamp;
      callbackRef.current(dt, timestamp);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning]);
}
