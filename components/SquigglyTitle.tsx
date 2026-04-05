/**
 * SquigglyTitle — animated title where each letter of "WightMare" grows
 * from a dot via squiggly lines into its final letter shape over ~2 seconds.
 * Final letters have jagged, broken squiggly spurs poking out.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

// ─── Letter path data (designed on a 40×50 grid) ────────────────────────────
// Each letter is an array of line segments: [x1,y1, x2,y2]
// The squiggly lines will grow along these segments.

type Segment = [number, number, number, number];

const LETTER_PATHS: Record<string, Segment[]> = {
  W: [
    [4, 5, 10, 45], [10, 45, 18, 22], [18, 22, 26, 45], [26, 45, 36, 5],
  ],
  i: [
    [20, 18, 20, 45],
    [20, 5, 20, 10],
  ],
  g: [
    [34, 12, 14, 12], [14, 12, 8, 18], [8, 18, 8, 32], [8, 32, 14, 38],
    [14, 38, 34, 38], [34, 38, 34, 12], [34, 38, 34, 50], [34, 50, 28, 56],
    [28, 56, 10, 56],
  ],
  h: [
    [8, 5, 8, 45],
    [8, 22, 14, 16], [14, 16, 24, 14], [24, 14, 32, 18], [32, 18, 32, 45],
  ],
  t: [
    [20, 5, 20, 45],
    [6, 14, 34, 14],
  ],
  M: [
    [4, 45, 4, 5], [4, 5, 20, 30], [20, 30, 36, 5], [36, 5, 36, 45],
  ],
  a: [
    [32, 45, 32, 16], [32, 16, 24, 10], [24, 10, 14, 10], [14, 10, 8, 16],
    [8, 16, 8, 28], [8, 28, 14, 34], [14, 34, 32, 34],
  ],
  r: [
    [10, 45, 10, 18],
    [10, 22, 16, 16], [16, 16, 26, 14], [26, 14, 34, 18],
  ],
  e: [
    [34, 28, 8, 28], [8, 28, 8, 16], [8, 16, 14, 10], [14, 10, 28, 10],
    [28, 10, 34, 16], [8, 28, 8, 38], [8, 38, 14, 44], [14, 44, 28, 44],
    [28, 44, 34, 38],
  ],
};

const TITLE = 'WightMare';

// ─── Spur data: decorative broken squiggly lines poking out of each letter ──
// Each spur: [x, y, angle in radians, length]
type Spur = [number, number, number, number];

function generateSpurs(letter: string): Spur[] {
  // Deterministic pseudo-random based on letter
  const seed = letter.charCodeAt(0);
  const rand = (i: number) => {
    const x = Math.sin(seed * 9.3 + i * 7.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const segments = LETTER_PATHS[letter] || [];
  const spurs: Spur[] = [];
  let si = 0;
  for (const seg of segments) {
    // Place 1-2 spurs per segment at random positions
    const count = rand(si) > 0.5 ? 2 : 1;
    for (let j = 0; j < count; j++) {
      const t = 0.2 + rand(si + j + 10) * 0.6;
      const x = seg[0] + (seg[2] - seg[0]) * t;
      const y = seg[1] + (seg[3] - seg[1]) * t;
      const segAngle = Math.atan2(seg[3] - seg[1], seg[2] - seg[0]);
      // Perpendicular + random offset
      const angle = segAngle + Math.PI / 2 + (rand(si + j + 20) - 0.5) * 1.2;
      const len = 4 + rand(si + j + 30) * 8;
      spurs.push([x, y, angle, len]);
    }
    si++;
  }
  return spurs;
}

// ─── Build a squiggly SVG path between two points ───────────────────────────
function squigglySegment(
  x1: number, y1: number, x2: number, y2: number,
  progress: number, seed: number, time: number,
): string {
  if (progress <= 0) return '';
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(3, Math.round(len / 3));
  const actualSteps = Math.ceil(steps * Math.min(progress, 1));
  const perpX = -dy / (len || 1);
  const perpY = dx / (len || 1);

  let d = `M ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  for (let i = 1; i <= actualSteps; i++) {
    const t = i / steps;
    const wobbleAmp = 1.2 + 0.6 * Math.sin(seed + i * 2.3);
    const wobble = Math.sin(seed * 3.7 + i * 4.1 + time * 2) * wobbleAmp;
    const px = x1 + dx * t + perpX * wobble;
    const py = y1 + dy * t + perpY * wobble;
    d += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
}

// ─── Build a squiggly spur path ─────────────────────────────────────────────
function spurPath(
  spur: Spur, progress: number, seed: number, time: number,
): string {
  if (progress <= 0) return '';
  const [x, y, angle, len] = spur;
  const actualLen = len * progress;
  const steps = Math.max(2, Math.round(actualLen / 2));
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const perpX = -dy;
  const perpY = dx;

  let d = `M ${x.toFixed(1)} ${y.toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const wobble = Math.sin(seed + i * 5.3 + time * 3) * 1.5;
    const px = x + dx * actualLen * t + perpX * wobble;
    const py = y + dy * actualLen * t + perpY * wobble;
    d += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
}

// ─── Single letter component ────────────────────────────────────────────────

const ANIM_DURATION = 2000; // ms per letter
const LETTER_STAGGER = 150; // ms delay between letters

interface LetterProps {
  letter: string;
  index: number;
  letterWidth: number;
  letterHeight: number;
}

function AnimatedLetter({ letter, index, letterWidth, letterHeight }: LetterProps) {
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const startRef = useRef(0);
  const rafRef = useRef(0);
  const spursRef = useRef(generateSpurs(letter));

  useEffect(() => {
    const delay = index * LETTER_STAGGER;
    const timeout = setTimeout(() => {
      startRef.current = performance.now();
      const animate = (now: number) => {
        const elapsed = now - startRef.current;
        const p = Math.min(elapsed / ANIM_DURATION, 1);
        // Ease-out cubic for organic feel
        const eased = 1 - Math.pow(1 - p, 3);
        setProgress(eased);
        setTime(now * 0.001);
        if (p < 1) {
          rafRef.current = requestAnimationFrame(animate);
        } else {
          // Keep animating time for post-completion wobble
          const postAnimate = (now2: number) => {
            setTime(now2 * 0.001);
            rafRef.current = requestAnimationFrame(postAnimate);
          };
          rafRef.current = requestAnimationFrame(postAnimate);
        }
      };
      rafRef.current = requestAnimationFrame(animate);
    }, delay);

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(rafRef.current);
    };
  }, [index]);

  const segments = LETTER_PATHS[letter] || [];
  const spurs = spursRef.current;

  // Scale the 40×50-ish design grid to letterWidth × letterHeight
  // Find bounding box of this letter's segments
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    minX = Math.min(minX, seg[0], seg[2]);
    minY = Math.min(minY, seg[1], seg[3]);
    maxX = Math.max(maxX, seg[0], seg[2]);
    maxY = Math.max(maxY, seg[1], seg[3]);
  }
  const origW = (maxX - minX) || 1;
  const origH = (maxY - minY) || 1;
  const scaleX = letterWidth / origW;
  const scaleY = letterHeight / origH;
  const scale = Math.min(scaleX, scaleY) * 0.82;
  const offsetX = (letterWidth - origW * scale) / 2 - minX * scale;
  const offsetY = (letterHeight - origH * scale) / 2 - minY * scale;

  // Center point of the letter (for the initial dot)
  const cx = letterWidth / 2;
  const cy = letterHeight / 2;

  // Dot size shrinks as lines grow
  const dotRadius = Math.max(0, 4 * (1 - progress * 1.5));

  // Build all segment paths
  let allPaths = '';
  segments.forEach((seg, si) => {
    const sx1 = seg[0] * scale + offsetX;
    const sy1 = seg[1] * scale + offsetY;
    const sx2 = seg[2] * scale + offsetX;
    const sy2 = seg[3] * scale + offsetY;

    // During early animation, lines grow from center toward their targets
    const growT = Math.min(progress * 1.4, 1);
    const fromX = cx + (sx1 - cx) * growT;
    const fromY = cy + (sy1 - cy) * growT;
    const toX = cx + (sx2 - cx) * growT;
    const toY = cy + (sy2 - cy) * growT;

    const segProgress = Math.max(0, Math.min((progress - si * 0.05) * 1.3, 1));
    allPaths += squigglySegment(fromX, fromY, toX, toY, segProgress, si * 7.3 + index * 13, time);
    allPaths += ' ';
  });

  // Spurs appear in the last 40% of animation
  const spurProgress = Math.max(0, (progress - 0.6) / 0.4);
  spurs.forEach((spur, si) => {
    const scaledSpur: Spur = [
      spur[0] * scale + offsetX,
      spur[1] * scale + offsetY,
      spur[2],
      spur[3] * scale,
    ];
    allPaths += spurPath(scaledSpur, spurProgress, si * 11.1 + index * 5, time);
    allPaths += ' ';
  });

  const viewBox = `0 0 ${letterWidth} ${letterHeight}`;

  return (
    <Svg width={letterWidth} height={letterHeight} viewBox={viewBox}>
      {dotRadius > 0.5 && (
        <Circle cx={cx} cy={cy} r={dotRadius} fill="#111111" />
      )}
      {allPaths.trim() && (
        <Path
          d={allPaths}
          stroke="#111111"
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </Svg>
  );
}

// ─── Main title component ───────────────────────────────────────────────────

interface TitleProps {
  /** Total width available for the title */
  maxWidth?: number;
}

export default function SquigglyTitle({ maxWidth = 500 }: TitleProps) {
  const letters = TITLE.split('');
  // Uppercase letters are wider
  const widths = letters.map((l) => (l === l.toUpperCase() ? 48 : 34));
  const totalW = widths.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, maxWidth / totalW);
  const letterHeight = 64 * scale;

  return (
    <View style={styles.container}>
      {letters.map((letter, i) => (
        <AnimatedLetter
          key={i}
          letter={letter}
          index={i}
          letterWidth={widths[i] * scale}
          letterHeight={letterHeight}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
});
