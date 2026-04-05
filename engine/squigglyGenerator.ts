import { Point } from './gameEngine';

/**
 * Squared Euclidean distance — avoids sqrt for magnitude comparisons.
 */
export function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Convert an array of 2-D points into a smooth SVG path string using
 * quadratic Bézier curves (midpoint-chaining algorithm).
 *
 * The result starts at points[0] and ends at points[last].
 */
export function pointsToSvgPath(points: Point[]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`;

  // Pre-sized array to avoid repeated push + final join
  const parts = new Array<string>(n);
  parts[0] = `M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`;

  for (let i = 1; i < n - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    parts[i] = `Q ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round((p.x + q.x) * 0.5)} ${Math.round((p.y + q.y) * 0.5)}`;
  }

  const last = points[n - 1];
  parts[n - 1] = `L ${Math.round(last.x)} ${Math.round(last.y)}`;

  return parts.join(' ');
}

/**
 * Merged wiggle + SVG path generation.
 * Avoids allocating an intermediate wiggled-points array.
 * Uses pre-sized array + direct indexing for minimal allocation.
 */
export function pointsToWiggledSvgPath(points: Point[], time: number): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`;
  if (n === 2) {
    return `M ${Math.round(points[0].x)} ${Math.round(points[0].y)} L ${Math.round(points[1].x)} ${Math.round(points[1].y)}`;
  }

  const AMP = 2.5;
  const FREQ = 3.0;
  const SPEED = 4.0;

  // Pre-sized array: 1 move + (n-2) quad curves + 1 line = n
  const parts = new Array<string>(n);
  parts[0] = `M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`;

  // Pre-compute wiggled position for index 1
  let wcx: number, wcy: number;
  {
    const p = points[1];
    const tx = points[2].x - points[0].x;
    const ty = points[2].y - points[0].y;
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    const off = Math.sin(FREQ + time * SPEED) * AMP;
    wcx = p.x + (-ty / len) * off;
    wcy = p.y + (tx / len) * off;
  }

  for (let i = 1; i < n - 1; i++) {
    const cx = wcx;
    const cy = wcy;

    if (i + 1 < n - 1) {
      const p = points[i + 1];
      const tx = points[i + 2].x - points[i].x;
      const ty = points[i + 2].y - points[i].y;
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      const off = Math.sin((i + 1) * FREQ + time * SPEED) * AMP;
      wcx = p.x + (-ty / len) * off;
      wcy = p.y + (tx / len) * off;
    } else {
      wcx = points[n - 1].x;
      wcy = points[n - 1].y;
    }

    parts[i] = `Q ${Math.round(cx)} ${Math.round(cy)} ${Math.round((cx + wcx) * 0.5)} ${Math.round((cy + wcy) * 0.5)}`;
  }

  parts[n - 1] = `L ${Math.round(points[n - 1].x)} ${Math.round(points[n - 1].y)}`;

  return parts.join(' ');
}

/**
 * Calculate the total pixel length of a polyline through an array of points.
 */
export function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.sqrt(distanceSq(points[i - 1], points[i]));
  }
  return len;
}

/**
 * Bake wiggle offsets into the path points in-place so the bumpy shape
 * is preserved even when rendered with the non-wiggled path builder.
 */
export function bakeWiggle(points: Point[], time: number): void {
  const n = points.length;
  if (n <= 2) return;
  const AMP = 2.5;
  const FREQ = 3.0;
  const SPEED = 4.0;
  for (let i = 1; i < n - 1; i++) {
    const prev = points[i - 1];
    const next = points[i + 1];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    const off = Math.sin(i * FREQ + time * SPEED) * AMP;
    points[i] = {
      x: points[i].x + (-ty / len) * off,
      y: points[i].y + (tx / len) * off,
    };
  }
}

/**
 * Compress a path by keeping only every other interior point while preserving
 * the first (anchor) and last (head) points.  Used to limit memory growth.
 */
export function compressPath(points: Point[]): Point[] {
  if (points.length <= 4) return points;
  const compressed: Point[] = [points[0]];
  for (let i = 2; i < points.length - 1; i += 2) {
    compressed.push(points[i]);
  }
  compressed.push(points[points.length - 1]);
  return compressed;
}
