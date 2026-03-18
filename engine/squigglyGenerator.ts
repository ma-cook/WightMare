import { Point } from './gameEngine';

/**
 * Euclidean distance between two points.
 */
export function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Return a copy of the points with gentle perpendicular wiggle applied
 * to interior points (anchors at index 0 and last are left in place).
 */
export function wigglePoints(points: Point[], time: number): Point[] {
  if (points.length <= 2) return points;
  const AMP = 2.5;   // max displacement in px
  const FREQ = 3.0;  // spatial frequency along the line
  const SPEED = 4.0;  // temporal speed
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    // Compute tangent direction from neighbours
    const prev = points[i - 1];
    const next = points[i + 1];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    // Perpendicular (normalised)
    const nx = -ty / len;
    const ny = tx / len;
    const offset = Math.sin(i * FREQ + time * SPEED) * AMP;
    return { x: p.x + nx * offset, y: p.y + ny * offset };
  });
}

/**
 * Convert an array of 2-D points into a smooth SVG path string using
 * quadratic Bézier curves (midpoint-chaining algorithm).
 *
 * The result starts at points[0] and ends at points[last].
 */
export function pointsToSvgPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }

  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;

  return d;
}

/**
 * Calculate the total pixel length of a polyline through an array of points.
 */
export function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance(points[i - 1], points[i]);
  }
  return len;
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
