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
import Svg, { Defs, LinearGradient, Stop, Rect, Path } from 'react-native-svg';

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
  personalBest: number | null;
  onReturnToMenu: (survivalTime?: number) => void;
}

export default function GameCanvas({ width, height, playerName, personalBest, onReturnToMenu }: Props) {
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

      // Check if a line is being dragged — O(n) but n is always 0-2
      const isDragged = (lineId: string): boolean => {
        for (const v of gs.draggingMap.values()) {
          if (v === lineId) return true;
        }
        return false;
      };

      for (let dotIndex = 0; dotIndex < gs.dots.length; dotIndex++) {
        const dot = gs.dots[dotIndex];
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
        const otherDot = gs.dots[1 - dotIndex];
        const isLarger = otherDot ? dot.targetRadius > otherDot.targetRadius : false;
        const spawnBoost = isLarger ? LARGER_DOT_SPAWN_BOOST : 0;

        // ── Pending spawn batches (staggered second wave / third wave) ────
        {
          let bw = 0;
          for (let bi = 0; bi < dot.pendingBatches.length; bi++) {
            const batch = dot.pendingBatches[bi];
            if (now < batch.spawnAt) {
              dot.pendingBatches[bw++] = batch;
              continue;
            }
            const avail = Math.max(0, MAX_UNCONNECTED_PER_DOT - dot.unconnectedCount);
            const toCreate = Math.min(batch.count, avail);
            for (let si = 0; si < toCreate; si++) {
              const angle = Math.random() * Math.PI * 2;
              const newLine = createLine(dot.id,
                dot.x + Math.cos(angle) * dot.radius,
                dot.y + Math.sin(angle) * dot.radius, now);
              dot.lines.push(newLine);
              gs.lineMap.set(newLine.id, newLine);
              dot.unconnectedCount++;
            }
          }
          dot.pendingBatches.length = bw;
        }

        // ── Spawn ──────────────────────────────────────────────────────────
        const effectiveInterval = Math.max(1000, dot.spawnInterval - spawnBoost);
        if (now - dot.lastSpawnTime >= effectiveInterval) {
          dot.lastSpawnTime = now;
          dot.lastSpawnPulseTime = now;
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
              // Find a partner from the same spawn batch still unconnected
              const partner = dot.lines.find(
                (l) =>
                  l.id !== line.id &&
                  Math.abs(l.spawnTime - line.spawnTime) < 200 &&
                  !l.connectedToId &&
                  !l.penaltyApplied,
              );
              if (partner) {
                partner.penaltyApplied = true;
                dot.spawnInterval = Math.max(1000, dot.spawnInterval - SPAWN_INTERVAL_DECREASE);
                dot.flash = { type: 'penalty', startTime: now };
                dot.combo = 0;
              }
            }
          }

          // ── Skip lines that are connected or being dragged ───────────────
          if (line.connectedToId !== null) continue;
          if (gs.draggingMap.size > 0 && isDragged(line.id)) continue;

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
              angleDiff = ((angleDiff + Math.PI) % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) - Math.PI;
              const pushStrength = 1 - distToDot / dot.radius;
              line.direction += angleDiff * (RETURN_FORCE * 3) * pushStrength * dt;
            } else {
              const exploreInnerSq = exploreInner * exploreInner;
              if (distToDotSq > exploreInnerSq) {
                const distToDot = Math.sqrt(distToDotSq);
                const angleToCenter = Math.atan2(dotDy, dotDx);
                let angleDiff = angleToCenter - line.direction;
                angleDiff = ((angleDiff + Math.PI) % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) - Math.PI;
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

          // Escaped lines get stronger wandering so they don't beeline to the edge
          if (escaped) {
            // Extra wobble — roughly doubles the random turning
            line.direction += (Math.random() - 0.5) * DIRECTION_WOBBLE * 1.5 * dt;
            // Periodic sharp turns driven by per-line phase
            const turnPhase = timestamp * 0.001 + line.numericId * 2.71;
            line.direction += Math.sin(turnPhase * 1.3) * 2.0 * dt
                            + Math.cos(turnPhase * 0.7) * 1.5 * dt;
          }

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
          // Track closest edge call
          const edgeDist = Math.min(newHead.x, newHead.y, width - newHead.x, height - newHead.y);
          if (edgeDist < gs.closestEdgeCall) gs.closestEdgeCall = edgeDist;
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
      triggerRender();
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
    (touches: ArrayLike<NativeTouchEvent>, phase: 'start' | 'move' | 'end') => {
      const gs = stateRef.current;
      for (let ti = 0; ti < touches.length; ti++) {
        const touch = touches[ti];
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
              gs.dragStartTime.set(target.id, Date.now());
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
            const parentDot = line.dotId === gs.dots[0].id ? gs.dots[0] : gs.dots[1];
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
            const parentDot = draggedLine.dotId === gs.dots[0].id ? gs.dots[0] : gs.dots[1];
            if (parentDot) {
              // Decrement unconnected counter for the parent dot
              parentDot.unconnectedCount -= 2; // both lines are now connected
              const age = Date.now() - draggedLine.spawnTime;
              if (age <= CONNECT_REWARD_WINDOW) {
                parentDot.spawnInterval = Math.min(
                  parentDot.spawnInterval + SPAWN_INTERVAL_INCREASE,
                  SPAWN_INTERVAL_MAX,
                );
                parentDot.flash = { type: 'reward', startTime: Date.now() };
                // Combo tracking
                parentDot.combo++;
                parentDot.bestCombo = Math.max(parentDot.bestCombo, parentDot.combo);
                gs.longestCombo = Math.max(gs.longestCombo, parentDot.combo);
                // Combo bonus at thresholds 3/5/10
                if (parentDot.combo === 3 || parentDot.combo === 5 || parentDot.combo === 10) {
                  parentDot.spawnInterval = Math.min(
                    parentDot.spawnInterval + SPAWN_INTERVAL_INCREASE,
                    SPAWN_INTERVAL_MAX,
                  );
                }
              }
              // Track connection stats
              gs.totalConnectionTime += (Date.now() - draggedLine.spawnTime);
              gs.connectionCount++;
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
            if (parentDot) {
              parentDot.connectedPaths.push(draggedLine.cachedSvgPath, snapTarget.cachedSvgPath);
              parentDot.connectedSvgDirty = true;
              // Push connection pulse flashes for both paths
              const pulseNow = Date.now();
              parentDot.connectionFlashes.push(
                { svgPath: draggedLine.cachedSvgPath, startTime: pulseNow },
                { svgPath: snapTarget.cachedSvgPath, startTime: pulseNow },
              );
              // Remove connected lines from dot.lines to stop iterating them each frame
              parentDot.lines = parentDot.lines.filter(
                (l) => l.id !== draggedLine.id && l.id !== snapTarget.id,
              );
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
        if (lineId) gs.dragStartTime.delete(lineId);
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
  const renderNow = Date.now();

  // Check if a line is being dragged — avoids Set allocation for 0-2 entries
  const isLineDragged = (lineId: string): boolean => {
    for (const v of gs.draggingMap.values()) {
      if (v === lineId) return true;
    }
    return false;
  };

  // Determine which side gets the warm tone based on which dot is larger
  const leftDot = gs.dots[0];
  const rightDot = gs.dots[1];
  const leftLarger = leftDot && rightDot ? leftDot.targetRadius >= rightDot.targetRadius : true;

  return (
    <View style={styles.container}>
      {/* Touch / mouse capture layer */}
      <View
        ref={touchLayerRef}
        style={[styles.touchLayer, { width, height }]}
        onTouchStart={(e) => processTouches(e.nativeEvent.changedTouches || [e.nativeEvent], 'start')}
        onTouchMove={(e) => processTouches(e.nativeEvent.changedTouches || [e.nativeEvent], 'move')}
        onTouchEnd={(e) => processTouches(e.nativeEvent.changedTouches || [e.nativeEvent], 'end')}
        onTouchCancel={(e) => processTouches(e.nativeEvent.changedTouches || [e.nativeEvent], 'end')}
      >
        <Svg width={width} height={height} style={styles.svg}>
          {/* Dynamic gradient — warm side follows the larger dot */}
          <Defs>
            <LinearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={leftLarger ? '#faecdb' : '#FFFFFF'} />
              <Stop offset="1" stopColor={leftLarger ? '#FFFFFF' : '#faecdb'} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={height} fill="url(#bg-grad)" />
          {/* Connected lines — one single <Path> per dot for all connected lines */}
          {gs.dots.map((dot: DotState) => {
            // Lazily rebuild the joined SVG string when new paths were added
            if (dot.connectedSvgDirty) {
              dot.cachedConnectedSvg = dot.connectedPaths.join(' ');
              dot.connectedSvgDirty = false;
            }
            return dot.cachedConnectedSvg ? (
              <Path
                key={`${dot.id}-connected`}
                d={dot.cachedConnectedSvg}
                stroke={CONNECTED_COLOR}
                strokeWidth={6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })}
          {/* Connection pulse flashes — bright flash along connected paths */}
          {gs.dots.map((dot: DotState) => {
            const pulseNow = renderNow;
            // In-place compaction — avoids allocating a new array via .filter()
            let fw = 0;
            for (let fi = 0; fi < dot.connectionFlashes.length; fi++) {
              if (pulseNow - dot.connectionFlashes[fi].startTime < 200) {
                dot.connectionFlashes[fw++] = dot.connectionFlashes[fi];
              }
            }
            dot.connectionFlashes.length = fw;
            return fw > 0 ? (
              <Path
                key={`${dot.id}-pulse`}
                d={dot.connectionFlashes.map(f => f.svgPath).join(' ')}
                stroke="#888888"
                strokeWidth={8}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={Math.max(0, 1 - (pulseNow - dot.connectionFlashes[0].startTime) / 200)}
              />
            ) : null;
          })}
          {/* Active (unconnected) lines — batched into merged <Path> per dot */}
          {gs.dots.map((dot: DotState) => {
            let linePaths = '';
            let closeCallD = '';
            let outerD = '';
            let innerD = '';
            let hasDragging = false;
            let dragOuterD = '';
            let dragInnerD = '';
            let hasLines = false;

            for (const line of dot.lines) {
              if (line.connectedToId !== null) continue;
              hasLines = true;
              const isDragging = isLineDragged(line.id);
              const svgPath = line.cachedWiggleSvg
                || (line.cachedWiggleSvg = pointsToWiggledSvgPath(line.pathPoints, renderTime, line.wiggleVariant));
              // Close-call: head within 20px of any edge → red
              const head = headOf(line);
              const isCloseCall = !isDragging && (head.x < 20 || head.y < 20 || head.x > width - 20 || head.y > height - 20);
              if (isCloseCall) {
                closeCallD += (closeCallD ? ' ' : '') + svgPath;
              } else {
                linePaths += (linePaths ? ' ' : '') + svgPath;
              }
              const hx = Math.round(head.x);
              const hy = Math.round(head.y);
              if (isDragging) {
                hasDragging = true;
                const dragStart = gs.dragStartTime.get(line.id) || renderNow;
                const heldSec = Math.min((renderNow - dragStart) / 1000, 3);
                const sizeMult = Math.pow(2, heldSec);
                const outerR = Math.round(9 * sizeMult * 10) / 10;
                const innerR = Math.round(4 * sizeMult * 10) / 10;
                dragOuterD += `M ${hx - outerR} ${hy} a ${outerR} ${outerR} 0 1 0 ${outerR * 2} 0 a ${outerR} ${outerR} 0 1 0 -${outerR * 2} 0`;
                dragInnerD += `M ${hx - innerR} ${hy} a ${innerR} ${innerR} 0 1 0 ${innerR * 2} 0 a ${innerR} ${innerR} 0 1 0 -${innerR * 2} 0`;
              } else {
                outerD += `M ${hx - 6} ${hy} a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0`;
                innerD += `M ${hx - 2.5} ${hy} a 2.5 2.5 0 1 0 5 0 a 2.5 2.5 0 1 0 -5 0`;
              }
            }

            if (!hasLines) return null;
            const innerColor = dot.id === 'dot-left' ? '#ffffff' : '#bbbbbb';

            return (
              <React.Fragment key={`${dot.id}-active`}>
                {linePaths && <Path d={linePaths} stroke={LINE_COLOR} strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                {closeCallD && <Path d={closeCallD} stroke="#CC0000" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                {outerD && <Path d={outerD} fill={HEAD_COLOR} />}
                {innerD && <Path d={innerD} fill={innerColor} />}
                {hasDragging && dragOuterD && <Path d={dragOuterD} fill={HEAD_COLOR} />}
                {hasDragging && dragInnerD && <Path d={dragInnerD} fill={innerColor} />}
              </React.Fragment>
            );
          })}

          {/* Dots — animated with smooth escape bumps */}
          {gs.dots.map((dot: DotState) => {
            let r = dot.radius;
            // Spawn pulse: 8% scale bump decaying over 300ms
            const pulseElapsed = renderNow - dot.lastSpawnPulseTime;
            if (pulseElapsed < 300 && dot.lastSpawnPulseTime > 0) {
              r *= 1 + 0.08 * (1 - pulseElapsed / 300);
            }
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

          {/* Flash indicator at dot center on reward/penalty (fades out) */}
          {gs.dots.map((dot: DotState) => {
            if (!dot.flash) return null;
            const elapsed = renderNow - dot.flash.startTime;
            const duration = dot.flash.type === 'reward' ? 500 : 250;
            if (elapsed >= duration) {
              dot.flash = null;
              return null;
            }
            const opacity = 1 - elapsed / duration;
            const fr = 5;
            const cx = Math.round(dot.x);
            const cy = Math.round(dot.y);
            const d = `M ${cx - fr} ${cy} a ${fr} ${fr} 0 1 0 ${fr * 2} 0 a ${fr} ${fr} 0 1 0 -${fr * 2} 0`;
            if (dot.flash.type === 'reward') {
              return (
                <React.Fragment key={`${dot.id}-flash`}>
                  <Path d={d} fill="#ffffff" stroke="#555555" strokeWidth={1.5} opacity={opacity} />
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={`${dot.id}-flash`}>
                <Path d={d} fill="#555555" stroke="#ffffff" strokeWidth={1.5} opacity={opacity} />
              </React.Fragment>
            );
          })}

          {/* Combo counter — red circles inside the parent dot */}
          {gs.dots.map((dot: DotState) => {
            if (dot.combo <= 0) return null;
            const count = Math.min(dot.combo, 10); // cap visual dots at 10
            const r = dot.radius;
            const dotR = Math.max(2, Math.min(4, r * 0.12)); // circle radius scales with dot size
            // Arrange in a ring at 55% of the parent dot's radius
            const ringR = r * 0.55;
            let d = '';
            for (let i = 0; i < count; i++) {
              const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
              const cx = Math.round(dot.x + Math.cos(angle) * ringR);
              const cy = Math.round(dot.y + Math.sin(angle) * ringR);
              d += `M ${cx - dotR} ${cy} a ${dotR} ${dotR} 0 1 0 ${dotR * 2} 0 a ${dotR} ${dotR} 0 1 0 -${dotR * 2} 0`;
            }
            return <Path key={`${dot.id}-combo`} d={d} fill="#8B0000" />;
          })}

          {/* Writhing flecks inside each dot — cached, recomputed every 4 render frames */}
          {gs.dots.map((dot: DotState, dotIdx: number) => {
            const r = dot.radius;
            if (r < 18) return null;
            // Recompute fleck path every 4th frame (~8fps visual update, imperceptible)
            if (gs.frameCount - dot.cachedFleckFrame >= 4 || !dot.cachedFleckSvg) {
              dot.cachedFleckFrame = gs.frameCount;
              const FLECK_COUNT = Math.min(15, Math.max(1, Math.floor((r - 15) / 2.5)));
              const fleckParts: string[] = [];
              for (let i = 0; i < FLECK_COUNT; i++) {
                const phase = i * 1.618 + dotIdx * 2.4;
                const blinkCycle = Math.sin(renderTime * (0.18 + i * 0.055) + phase * 2.1)
                                 * Math.cos(renderTime * (0.32 + i * 0.085) + phase * 1.3);
                if (blinkCycle < 0) continue;
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
              dot.cachedFleckSvg = fleckParts.join(' ');
              dot.cachedFleckOpacity = 0.15 + 0.35 * ((Math.sin(renderTime * 0.4 + dotIdx * 1.5) + 1) / 2);
            }
            if (!dot.cachedFleckSvg) return null;
            return (
              <Path
                key={`${dot.id}-flecks`}
                d={dot.cachedFleckSvg}
                stroke="#777777"
                strokeWidth={1}
                fill="none"
                opacity={dot.cachedFleckOpacity}
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
          isNewBest={personalBest === null || gs.survivalTime > personalBest}
          onPlayAgain={handlePlayAgain}
          onReturnToMenu={() => onReturnToMenu(gs.survivalTime)}
          totalConnected={gs.totalConnected}
          longestCombo={gs.longestCombo}
          closestEdgeCall={gs.closestEdgeCall === Infinity ? 0 : Math.round(gs.closestEdgeCall)}
          averageConnectionTime={gs.connectionCount > 0 ? gs.totalConnectionTime / gs.connectionCount / 1000 : 0}
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
