/**
 * GameCanvas — full-screen SVG game canvas.
 *
 * Responsibilities:
 *  • Holds all mutable game state in a ref (avoids closure-staleness in the
 *    game loop while keeping renders fast).
 *  • Runs a 60 fps requestAnimationFrame loop via useGameLoop.
 *  • Handles PanResponder for drag-to-connect mechanic (works on both touch
 *    and mouse via react-native-web).
 *  • Spawns pairs of squiggly lines from each dot at random intervals.
 *  • Applies difficulty escalation when pairs aren't connected in time.
 *  • Triggers game-over when any head reaches the screen edge.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type NativeTouchEvent,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  CELL_SIZE,
  CONNECT_PENALTY_WINDOW,
  CONNECT_REWARD_WINDOW,
  COVERAGE_THRESHOLD,
  DIRECTION_WOBBLE,
  DOT_GROW_DURATION,
  DOT_GROWTH_AMOUNT,
  ESCAPE_TIME,
  EXPLORE_RADIUS_MULT,
  HIT_RADIUS_SQ,
  INV_CELL_SIZE,
  LARGER_DOT_SPAWN_BOOST,
  LINE_SPEED,
  MAX_PATH_POINTS,
  MAX_UNCONNECTED_PER_DOT,
  POINT_SAMPLE_DISTANCE_SQ,
  RETURN_FORCE,
  SNAP_RADIUS_SQ,
  SPAWN_INTERVAL_DECREASE,
  SPAWN_INTERVAL_INCREASE,
  SPAWN_INTERVAL_MAX,
  SPAWN_INTERVAL_MIN,
  createInitialState,
  createLine,
  packCell,
  type DotState,
  type GameState,
  type Point,
  type SquigglyLine,
} from '../engine/gameEngine';
import {
  bakeWiggle,
  compressPath,
  distanceSq,
  pointsToSvgPath,
  pointsToWiggledSvgPath,
} from '../engine/squigglyGenerator';
import { useGameLoop } from '../hooks/useGameLoop';
import GameOverScreen from './GameOverScreen';
import HUD from './HUD';

// ─── Line colour ──────────────────────────────────────────────────────────────
const LINE_COLOR = '#111111';
const HEAD_COLOR = '#111111';
const CONNECTED_COLOR = '#444444';

// ─── Edge margin: how close to the border a head must be to trigger loss ─────
const EDGE_MARGIN = 4;

interface Props {
  width: number;
  height: number;
  playerName: string;
  onReturnToMenu: () => void;
}

export default function GameCanvas({ width, height, playerName, onReturnToMenu }: Props) {
  // ── React state: only used to trigger re-renders ──────────────────────────
  const [renderTick, setRenderTick] = useState(0);
  const triggerRender = useCallback(() => setRenderTick((t) => t + 1), []);

  // ── All mutable game data lives here ─────────────────────────────────────
  const stateRef = useRef<GameState>(createInitialState(width, height));

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  const findLine = (id: string): SquigglyLine | undefined => {
    return stateRef.current.lineMap.get(id);
  };

  const headOf = (line: SquigglyLine): Point =>
    line.pathPoints[line.pathPoints.length - 1];

  /** Find the nearest unconnected line head within squared radius. */
  const nearestHead = (
    pt: Point,
    radiusSq: number,
    excludeId?: string,
    sameDotId?: string,
  ): SquigglyLine | undefined => {
    let best: SquigglyLine | undefined;
    let bestDistSq = radiusSq;
    for (const dot of stateRef.current.dots) {
      for (const line of dot.lines) {
        if (line.id === excludeId) continue;
        if (line.connectedToId !== null) continue;
        if (sameDotId !== undefined && line.dotId !== sameDotId) continue;
        const dSq = distanceSq(pt, headOf(line));
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          best = line;
        }
      }
    }
    return best;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Game loop tick
  // ─────────────────────────────────────────────────────────────────────────

  const gameLoop = useCallback(
    (dt: number, timestamp: number) => {
      const gs = stateRef.current;
      if (gs.status !== 'playing') return;

      const now = Date.now();

      // Update survival time
      gs.survivalTime = (now - gs.startTime) / 1000;

      for (const dot of gs.dots) {
        // ── Animate radius toward targetRadius ─────────────────────────────
        if (dot.radius < dot.targetRadius) {
          if (dot.growStartTime === 0) {
            dot.growStartTime = now;
            dot.growStartRadius = dot.radius;
          }
          const elapsed = now - dot.growStartTime;
          const t = Math.min(elapsed / DOT_GROW_DURATION, 1);
          dot.radius = dot.growStartRadius + (dot.targetRadius - dot.growStartRadius) * t;
          if (t >= 1) {
            dot.radius = dot.targetRadius;
            dot.growStartTime = 0;
          }
        }

        // ── Determine spawn interval boost for larger dot ──────────────────
        const otherDot = gs.dots.find((d) => d.id !== dot.id);
        const isLarger = otherDot ? dot.targetRadius > otherDot.targetRadius : false;
        const spawnBoost = isLarger ? LARGER_DOT_SPAWN_BOOST : 0;

        // ── Pending spawn batches (staggered second wave / third wave) ────
        dot.pendingBatches = dot.pendingBatches.filter((batch) => {
          if (now < batch.spawnAt) return true;
          const avail = Math.max(0, MAX_UNCONNECTED_PER_DOT - dot.unconnectedCount);
          const n = Math.min(batch.count, avail);
          for (let si = 0; si < n; si++) {
            const angle = Math.random() * Math.PI * 2;
            const newLine = createLine(dot.id,
              dot.x + Math.cos(angle) * dot.radius,
              dot.y + Math.sin(angle) * dot.radius, now);
            dot.lines.push(newLine);
            gs.lineMap.set(newLine.id, newLine);
            dot.unconnectedCount++;
          }
          return false;
        });

        // ── Spawn ──────────────────────────────────────────────────────────
        const effectiveInterval = Math.max(1000, dot.spawnInterval - spawnBoost);
        if (now - dot.lastSpawnTime >= effectiveInterval) {
          dot.lastSpawnTime = now;
          // Randomise next interval
          dot.spawnInterval =
            SPAWN_INTERVAL_MIN +
            Math.random() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);

          // Spawn count scales with total connections: 2 base, +2 at 75, +4 at 150, +6 at 225
          const spawnCount = gs.totalConnected >= 225 ? 8
            : gs.totalConnected >= 150 ? 6
            : gs.totalConnected >= 75 ? 4
            : 2;
          // Cap unconnected lines per dot
          const allowed = Math.max(0, MAX_UNCONNECTED_PER_DOT - dot.unconnectedCount);

          // Spawn lines staggered by 150ms each
          const toSpawn = Math.min(spawnCount, allowed);
          for (let si = 0; si < toSpawn; si++) {
            if (si === 0) {
              // First line spawns immediately
              const angle = Math.random() * Math.PI * 2;
              const newLine = createLine(dot.id,
                dot.x + Math.cos(angle) * dot.radius,
                dot.y + Math.sin(angle) * dot.radius, now);
              dot.lines.push(newLine);
              gs.lineMap.set(newLine.id, newLine);
              dot.unconnectedCount++;
            } else {
              // Subsequent lines staggered by 150ms
              dot.pendingBatches.push({ count: 1, spawnAt: now + si * 150 });
            }
          }
        }

        for (const line of dot.lines) {
          // ── Penalty check ────────────────────────────────────────────────
          if (!line.connectedToId && !line.penaltyApplied) {
            if (now - line.spawnTime > CONNECT_PENALTY_WINDOW) {
              line.penaltyApplied = true;
              // Find a partner from the same spawn event still unconnected
              const partner = dot.lines.find(
                (l) =>
                  l.id !== line.id &&
                  l.spawnTime === line.spawnTime &&
                  !l.connectedToId &&
                  !l.penaltyApplied,
              );
              if (partner) {
                partner.penaltyApplied = true;
                dot.spawnInterval = Math.max(1000, dot.spawnInterval - SPAWN_INTERVAL_DECREASE);
              }
            }
          }

          // ── Skip lines that are connected or being dragged ───────────────
          if (line.connectedToId !== null) continue;
          let _beingDragged = false;
          for (const lid of gs.draggingMap.values()) {
            if (lid === line.id) { _beingDragged = true; break; }
          }
          if (_beingDragged) continue;

          // ── Move head ────────────────────────────────────────────────────
          const prevHead = headOf(line);

          // Steer toward parent dot to keep exploring nearby
          // After ESCAPE_TIME, the line breaks free and ignores the explore zone
          const escaped = now - line.spawnTime > ESCAPE_TIME;

          if (!escaped) {
            const exploreR = dot.radius * EXPLORE_RADIUS_MULT;
            const exploreInner = exploreR * 0.3;
            const exploreRange = exploreR * 0.7;
            const dotDx = dot.x - prevHead.x;
            const dotDy = dot.y - prevHead.y;
            const distToDotSq = dotDx * dotDx + dotDy * dotDy;
            const dotRadiusSq = dot.radius * dot.radius;

            if (distToDotSq < dotRadiusSq) {
              // Inside the dot — steer sharply away from center
              const distToDot = Math.sqrt(distToDotSq) || 0.1;
              const awayAngle = Math.atan2(-dotDy, -dotDx);
              let angleDiff = awayAngle - line.direction;
              while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
              while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
              const pushStrength = 1 - distToDot / dot.radius;
              line.direction += angleDiff * (RETURN_FORCE * 3) * pushStrength * dt;
            } else {
              const exploreInnerSq = exploreInner * exploreInner;
              if (distToDotSq > exploreInnerSq) {
                const distToDot = Math.sqrt(distToDotSq);
                const angleToCenter = Math.atan2(dotDy, dotDx);
                let angleDiff = angleToCenter - line.direction;
                while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
                const t = Math.min(
                  (distToDot - exploreInner) / exploreRange,
                  1,
                );
                line.direction += angleDiff * RETURN_FORCE * t * dt;
              }
            }
          }

          // Organic direction change: random wobble + sine component
          const sineComponent =
            Math.sin(timestamp * 0.002 + line.numericId) * 0.8;
          line.direction +=
            (Math.random() - 0.5) * DIRECTION_WOBBLE * dt + sineComponent * dt;

          const speed = LINE_SPEED * dt;
          const newX = prevHead.x + Math.cos(line.direction) * speed;
          const newY = prevHead.y + Math.sin(line.direction) * speed;

          // Mutate the live head in place — avoids allocating a new object every frame
          const liveHead = line.pathPoints[line.pathPoints.length - 1];
          liveHead.x = newX;
          liveHead.y = newY;
          const newHead = liveHead;

          // Commit a new sample point when head moves far enough from
          // the second-to-last point (the last "committed" position)
          const lastCommitted = line.pathPoints.length >= 2
            ? line.pathPoints[line.pathPoints.length - 2]
            : line.pathPoints[0];
          if (distanceSq(lastCommitted, newHead) >= POINT_SAMPLE_DISTANCE_SQ) {
            // Push a new live-head slot; the current newHead becomes committed
            line.pathPoints.push({ ...newHead });

            // Invalidate wiggle cache — will be rebuilt at render time
            line.cachedWiggleSvg = null;

            // Mark coverage cell
            dot.coveredCells.add(
              packCell((newHead.x * INV_CELL_SIZE) | 0, (newHead.y * INV_CELL_SIZE) | 0),
            );
            dot.coverageDirty = true;

            // Compress if too long (keeps first anchor + last head)
            if (line.pathPoints.length > MAX_PATH_POINTS) {
              line.pathPoints = compressPath(line.pathPoints);
            }
          }

          // ── Edge-collision → game over ───────────────────────────────────
          if (
            newHead.x <= EDGE_MARGIN ||
            newHead.y <= EDGE_MARGIN ||
            newHead.x >= width - EDGE_MARGIN ||
            newHead.y >= height - EDGE_MARGIN
          ) {
            gs.status = 'gameOver';
            triggerRender();
            return;
          }
        }

        // ── Dot growth (coverage-based: expand when 90% ring covered) ────
        if (dot.coverageDirty) {
          dot.coverageDirty = false;
          const innerR = dot.targetRadius;
          const outerR = dot.targetRadius + DOT_GROWTH_AMOUNT;
          const innerRSq = innerR * innerR;
          const outerRSq = outerR * outerR;
          let totalCells = 0;
          let coveredCount = 0;
          const minCX = Math.floor((dot.x - outerR) / CELL_SIZE);
          const maxCX = Math.floor((dot.x + outerR) / CELL_SIZE);
          const minCY = Math.floor((dot.y - outerR) / CELL_SIZE);
          const maxCY = Math.floor((dot.y + outerR) / CELL_SIZE);
          for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cy = minCY; cy <= maxCY; cy++) {
              const px = (cx + 0.5) * CELL_SIZE;
              const py = (cy + 0.5) * CELL_SIZE;
              const dSq = (px - dot.x) ** 2 + (py - dot.y) ** 2;
              if (dSq >= innerRSq && dSq < outerRSq) {
                totalCells++;
                if (dot.coveredCells.has(packCell(cx, cy))) coveredCount++;
              }
            }
          }
          if (totalCells > 0 && coveredCount / totalCells >= COVERAGE_THRESHOLD) {
            dot.targetRadius = outerR;
          }
        }
      }

      gs.loopTimeSec = timestamp * 0.001;
      gs.frameCount++;
      // Throttle React renders to ~30fps (every other frame) to halve reconciliation cost
      if (gs.frameCount % 2 === 0) {
        triggerRender();
      }
    },
    [width, height, triggerRender],
  );

  useGameLoop(gameLoop, stateRef.current.status === 'playing');

  // ─────────────────────────────────────────────────────────────────────────
  // PanResponder — drag-to-connect mechanic
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Touch handlers — multi-touch drag-to-connect mechanic
  // ─────────────────────────────────────────────────────────────────────────

  const processTouches = useCallback(
    (touches: NativeTouchEvent[], phase: 'start' | 'move' | 'end') => {
      const gs = stateRef.current;
      for (const touch of touches) {
        const id = String(touch.identifier);

        if (phase === 'start') {
          const pt: Point = { x: touch.locationX, y: touch.locationY };
          const target = nearestHead(pt, HIT_RADIUS_SQ);
          if (target && !gs.draggingMap.has(id)) {
            let alreadyGrabbed = false;
            for (const lineId of gs.draggingMap.values()) {
              if (lineId === target.id) { alreadyGrabbed = true; break; }
            }
            if (!alreadyGrabbed) {
              gs.draggingMap.set(id, target.id);
            }
          }
          continue;
        }

        if (phase === 'move') {
          const lineId = gs.draggingMap.get(id);
          if (!lineId) continue;
          const line = findLine(lineId);
          if (!line) continue;

          const newPt: Point = { x: touch.locationX, y: touch.locationY };
          const prev = headOf(line);

          if (distanceSq(prev, newPt) >= POINT_SAMPLE_DISTANCE_SQ) {
            line.pathPoints.push(newPt);
            line.cachedWiggleSvg = null; // invalidate wiggle cache
            if (line.pathPoints.length > MAX_PATH_POINTS) {
              line.pathPoints = compressPath(line.pathPoints);
            }
            const parentDot = gs.dots.find((d) => d.id === line.dotId);
            if (parentDot) {
              parentDot.coveredCells.add(
                packCell((newPt.x * INV_CELL_SIZE) | 0, (newPt.y * INV_CELL_SIZE) | 0),
              );
              parentDot.coverageDirty = true;
            }
          }
          continue;
        }

        // phase === 'end'
        const lineId = gs.draggingMap.get(id);
        if (!lineId) continue;

        const draggedLine = findLine(lineId);
        if (draggedLine) {
          const relPt: Point = {
            x: touch.locationX,
            y: touch.locationY,
          };
          const snapTarget = nearestHead(
            relPt,
            SNAP_RADIUS_SQ,
            draggedLine.id,
            draggedLine.dotId,
          );

          if (snapTarget) {
            draggedLine.connectedToId = snapTarget.id;
            snapTarget.connectedToId = draggedLine.id;
            gs.totalConnected++;
            // Decrement unconnected counter for the parent dot
            const parentDotForCounter = gs.dots.find((d) => d.id === draggedLine.dotId);
            if (parentDotForCounter) {
              parentDotForCounter.unconnectedCount -= 2; // both lines are now connected
            }
            const parentDotForReward = gs.dots.find((d) => d.id === draggedLine.dotId);
            if (parentDotForReward) {
              const age = Date.now() - draggedLine.spawnTime;
              if (age <= CONNECT_REWARD_WINDOW) {
                parentDotForReward.spawnInterval = Math.min(
                  parentDotForReward.spawnInterval + SPAWN_INTERVAL_INCREASE,
                  SPAWN_INTERVAL_MAX,
                );
              }
            }
            const snapHead = headOf(snapTarget);
            draggedLine.pathPoints[draggedLine.pathPoints.length - 1] = {
              ...snapHead,
            };
            const t = gs.loopTimeSec;
            bakeWiggle(draggedLine.pathPoints, t, draggedLine.wiggleVariant);
            bakeWiggle(snapTarget.pathPoints, t, snapTarget.wiggleVariant);
            draggedLine.cachedSvgPath = pointsToSvgPath(draggedLine.pathPoints);
            snapTarget.cachedSvgPath = pointsToSvgPath(snapTarget.pathPoints);
            const parentDot = gs.dots.find((d) => d.id === draggedLine.dotId);
            if (parentDot) {
              parentDot.cachedConnectedSvg +=
                ' ' + draggedLine.cachedSvgPath +
                ' ' + snapTarget.cachedSvgPath;
              for (const pt of draggedLine.pathPoints) {
                parentDot.coveredCells.add(
                  packCell((pt.x * INV_CELL_SIZE) | 0, (pt.y * INV_CELL_SIZE) | 0),
                );
              }
              for (const pt of snapTarget.pathPoints) {
                parentDot.coveredCells.add(
                  packCell((pt.x * INV_CELL_SIZE) | 0, (pt.y * INV_CELL_SIZE) | 0),
                );
              }
              parentDot.coverageDirty = true;
            }
          }
        }

        gs.draggingMap.delete(id);
      }
    },
    [],
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Web mouse support — desktop browsers don't fire touch events for mouse
  // ─────────────────────────────────────────────────────────────────────────

  const touchLayerRef = useRef<View>(null);
  const mouseDownRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = (touchLayerRef.current as any) as HTMLElement | null;
    if (!el) return;

    const toTouch = (e: MouseEvent): NativeTouchEvent[] => {
      const rect = el.getBoundingClientRect();
      return [{ identifier: -1, locationX: e.clientX - rect.left, locationY: e.clientY - rect.top } as any];
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      mouseDownRef.current = true;
      processTouches(toTouch(e), 'start');
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;
      processTouches(toTouch(e), 'move');
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;
      mouseDownRef.current = false;
      processTouches(toTouch(e), 'end');
    };

    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [processTouches]);

  // ─────────────────────────────────────────────────────────────────────────
  // Restart
  // ─────────────────────────────────────────────────────────────────────────

  const handlePlayAgain = useCallback(() => {
    stateRef.current = createInitialState(width, height);
    triggerRender();
  }, [width, height, triggerRender]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const gs = stateRef.current;
  const renderTime = gs.loopTimeSec;

  return (
    <View style={styles.container}>
      {/* Touch / mouse capture layer */}
      <View
        ref={touchLayerRef}
        style={[styles.touchLayer, { width, height }]}
        onTouchStart={(e) => processTouches(Array.from(e.nativeEvent.changedTouches || [e.nativeEvent]), 'start')}
        onTouchMove={(e) => processTouches(Array.from(e.nativeEvent.changedTouches || [e.nativeEvent]), 'move')}
        onTouchEnd={(e) => processTouches(Array.from(e.nativeEvent.changedTouches || [e.nativeEvent]), 'end')}
        onTouchCancel={(e) => processTouches(Array.from(e.nativeEvent.changedTouches || [e.nativeEvent]), 'end')}
      >
        <Svg width={width} height={height} style={styles.svg}>
          {/* Connected lines — one single <Path> per dot for all connected lines */}
          {gs.dots.map((dot: DotState) =>
            dot.cachedConnectedSvg ? (
              <Path
                key={`${dot.id}-connected`}
                d={dot.cachedConnectedSvg}
                stroke={CONNECTED_COLOR}
                strokeWidth={6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null,
          )}
          {/* Active (unconnected) lines — rendered individually */}
          {gs.dots.map((dot: DotState) =>
            dot.lines.map((line: SquigglyLine) => {
              if (line.connectedToId !== null) return null;
              let isDragging = false;
              for (const lid of gs.draggingMap.values()) { if (lid === line.id) { isDragging = true; break; } }
              const svgPath = line.cachedWiggleSvg
                || (line.cachedWiggleSvg = pointsToWiggledSvgPath(line.pathPoints, renderTime, line.wiggleVariant));
              const head = headOf(line);

              return (
                <React.Fragment key={line.id}>
                  <Path
                    d={svgPath}
                    stroke={LINE_COLOR}
                    strokeWidth={6}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <Circle
                    cx={head.x}
                    cy={head.y}
                    r={isDragging ? 9 : 6}
                    fill={HEAD_COLOR}
                  />
                  <Circle
                    cx={head.x}
                    cy={head.y}
                    r={isDragging ? 4 : 2.5}
                    fill={dot.id === 'dot-left' ? '#ffffff' : '#bbbbbb'}
                  />
                </React.Fragment>
              );
            }),
          )}

          {/* Dots — animated with smooth escape bumps */}
          {gs.dots.map((dot: DotState) => {
            const r = dot.radius;
            const BUMPS = 8;
            const BUMP_AMP = r * 0.08;
            const BUMP_SPEED = 3.0;
            const segments = Math.min(36, Math.max(24, Math.round(r * 2)));
            const step = (Math.PI * 2) / segments;

            // Compute bumpy radii into a flat Float64 pair buffer [x,y,...]
            // to avoid allocating an object per segment.
            const needed = segments * 2;
            if (dot._dotBuf.length < needed) dot._dotBuf = new Float64Array(needed);
            const buf = dot._dotBuf;
            for (let i = 0; i < segments; i++) {
              const angle = i * step;
              const bump =
                Math.sin(angle * BUMPS + renderTime * BUMP_SPEED) * BUMP_AMP * 0.6 +
                Math.sin(angle * (BUMPS + 3) - renderTime * BUMP_SPEED * 1.3) * BUMP_AMP * 0.4;
              const br = r + bump;
              buf[i * 2] = dot.x + Math.cos(angle) * br;
              buf[i * 2 + 1] = dot.y + Math.sin(angle) * br;
            }

            // Build smooth closed cubic-bezier path (Catmull-Rom, tension 1/6)
            const n = segments;
            const dotParts = new Array<string>(n + 2);
            dotParts[0] = `M ${Math.round(buf[0])} ${Math.round(buf[1])}`;
            for (let i = 0; i < n; i++) {
              const i0 = ((i - 1 + n) % n) * 2;
              const i1 = i * 2;
              const i2 = ((i + 1) % n) * 2;
              const i3 = ((i + 2) % n) * 2;
              const cp1x = buf[i1] + (buf[i2] - buf[i0]) / 6;
              const cp1y = buf[i1 + 1] + (buf[i2 + 1] - buf[i0 + 1]) / 6;
              const cp2x = buf[i2] - (buf[i3] - buf[i1]) / 6;
              const cp2y = buf[i2 + 1] - (buf[i3 + 1] - buf[i1 + 1]) / 6;
              dotParts[i + 1] = `C ${Math.round(cp1x)} ${Math.round(cp1y)}, ${Math.round(cp2x)} ${Math.round(cp2y)}, ${Math.round(buf[i2])} ${Math.round(buf[i2 + 1])}`;
            }
            dotParts[n + 1] = 'Z';
            const dotPath = dotParts.join(' ');
            return (
              <Path
                key={dot.id}
                d={dotPath}
                fill="#111111"
              />
            );
          })}

          {/* Writhing flecks inside each dot — count scales with radius, per-fleck random blink */}
          {gs.dots.map((dot: DotState, dotIdx: number) => {
            const r = dot.radius;
            if (r < 18) return null;
            // More flecks as the dot grows: 1 at r≈18, up to 15 at r≈50+
            const FLECK_COUNT = Math.min(15, Math.max(1, Math.floor((r - 15) / 2.5)));
            const fleckParts: string[] = [];
            for (let i = 0; i < FLECK_COUNT; i++) {
              const phase = i * 1.618 + dotIdx * 2.4;
              // Per-fleck pseudorandom blink — halved frequencies for slower rhythm
              const blinkCycle = Math.sin(renderTime * (0.18 + i * 0.055) + phase * 2.1)
                               * Math.cos(renderTime * (0.32 + i * 0.085) + phase * 1.3);
              if (blinkCycle < 0) continue;
              // Rotation and shape speeds halved for slower writhing motion
              const rot = renderTime * (0.22 + i * 0.03) + phase;
              const radFrac = 0.15 + 0.55 * ((Math.sin(phase * 1.3) + 1) / 2);
              const ox = dot.x + Math.cos(rot) * r * radFrac;
              const oy = dot.y + Math.sin(rot) * r * radFrac;
              const len = r * (0.12 + 0.14 * Math.abs(Math.sin(renderTime * 0.65 + phase)));
              const sweep = rot + 0.9 + Math.sin(renderTime * 0.8 + phase) * 0.6;
              const ctrl = rot + 0.45 + Math.sin(renderTime * 1.0 + phase) * 0.4;
              const ex = ox + Math.cos(sweep) * len;
              const ey = oy + Math.sin(sweep) * len;
              const qx = ox + Math.cos(ctrl) * len * 0.7;
              const qy = oy + Math.sin(ctrl) * len * 0.7;
              fleckParts.push(`M ${Math.round(ox)} ${Math.round(oy)} Q ${Math.round(qx)} ${Math.round(qy)} ${Math.round(ex)} ${Math.round(ey)}`);
            }
            if (fleckParts.length === 0) return null;
            // Slower overall opacity pulse
            const opacity = 0.15 + 0.35 * ((Math.sin(renderTime * 0.4 + dotIdx * 1.5) + 1) / 2);
            return (
              <Path
                key={`${dot.id}-flecks`}
                d={fleckParts.join(' ')}
                stroke="#777777"
                strokeWidth={1}
                fill="none"
                opacity={opacity}
              />
            );
          })}
        </Svg>
      </View>

      {/* HUD — survival timer */}
      {gs.status === 'playing' && (
        <HUD survivalTime={gs.survivalTime} />
      )}

      {/* Game-over overlay */}
      {gs.status === 'gameOver' && (
        <GameOverScreen
          survivalTime={gs.survivalTime}
          playerName={playerName}
          onPlayAgain={handlePlayAgain}
          onReturnToMenu={onReturnToMenu}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  touchLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  svg: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
});
