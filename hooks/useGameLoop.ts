import { useEffect, useRef } from 'react';

type LoopCallback = (dt: number, timestamp: number, shouldRender: boolean) => void;

/**
 * Drives a requestAnimationFrame game loop.
 *
 * @param callback - called on fixed simulation steps and render ticks.
 *                   For simulation steps, `shouldRender=false` and dt is fixed.
 *                   For render ticks, `shouldRender=true` and dt is 0.
 * @param isRunning - set to false to pause / stop the loop.
 */
export function useGameLoop(
  callback: LoopCallback,
  isRunning: boolean,
  simulationFps: number = 60,
  renderFps: number = 30,
): void {
  const callbackRef = useRef<LoopCallback>(callback);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const simAccumulatorRef = useRef<number>(0);
  const renderAccumulatorRef = useRef<number>(0);

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
    simAccumulatorRef.current = 0;
    renderAccumulatorRef.current = 0;

    const simStep = 1 / Math.max(1, simulationFps);
    const renderStep = 1 / Math.max(1, renderFps);

    const loop = (timestamp: number): void => {
      const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = timestamp;

      simAccumulatorRef.current += dt;
      renderAccumulatorRef.current += dt;

      let steps = 0;
      while (simAccumulatorRef.current >= simStep && steps < 5) {
        callbackRef.current(simStep, timestamp, false);
        simAccumulatorRef.current -= simStep;
        steps++;
      }

      if (steps === 5) {
        // Prevent spiral-of-death on very slow frames.
        simAccumulatorRef.current = 0;
      }

      if (renderAccumulatorRef.current >= renderStep) {
        callbackRef.current(0, timestamp, true);
        renderAccumulatorRef.current %= renderStep;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning, simulationFps, renderFps]);
}
