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
import Svg, { Path } from 'react-native-svg';

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
  HEAD_GRID_CELL_SIZE,
  HIT_RADIUS_SQ,
  INV_HEAD_GRID_CELL_SIZE,
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
  recycleLine,
  type DotState,
  type GameState,
  type Point,
  type SquigglyLine,
} from '../engine/gameEngine';
import {
  advancePhase,
  bakeWiggle,
  compressPath,
  distanceSq,
  pointsToSvgPath,
  pointsToWiggledSvgPathLod,
} from '../engine/squigglyGenerator';
import { useGameLoop } from '../hooks/useGameLoop';
import GameOverScreen from './GameOverScreen';
import HUD from './HUD';

// ─── Line colour ──────────────────────────────────────────────────────────────
const LINE_COLOR = '#111111';
const HEAD_COLOR = '#111111';

// ─── Edge margin: how close to the border a head must be to trigger loss ─────
const EDGE_MARGIN = 4;

// Per-dot SVG path cache — dot shape is rebuilt every 2 frames only (30fps is
// enough for a background blob; halves path-build work and lets the GPU reuse
// the rasterised fill more often, which is the main cost at large radii).
const _dotSvgCache = new Map<string, string>();
const _ringOffsetsCache = new Map<number, Array<[number, number]>>();

interface Props {
  width: number;
  height: number;
  playerName: string;
  personalBest: number | null;
  onReturnToMenu: (survivalTime?: number) => void;
}

// True when running in a desktop web browser (not a touch/mobile device)
const isDesktopWeb =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: fine)').matches === true;

export default function GameCanvas({ width, height, playerName, personalBest, onReturnToMenu }: Props) {
  // ── React state: only used to trigger re-renders ──────────────────────────
  const [renderTick, setRenderTick] = useState(0);
  const triggerRender = useCallback(() => setRenderTick((t) => t + 1), []);

  // ── All mutable game data lives here ─────────────────────────────────────
  const stateRef = useRef<GameState>(createInitialState(width, height));
  const headGridRef = useRef<Map<number, string[]>>(new Map());
  const pointPoolRef = useRef<Point[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  const findLine = (id: string): SquigglyLine | undefined => {
    return stateRef.current.lineMap.get(id);
  };

  const headOf = (line: SquigglyLine): Point =>
    line.pathPoints[line.pathPoints.length - 1];

  const allocPoint = (x: number, y: number): Point => {
    const pool = pointPoolRef.current;
    const p = pool.pop();
    if (p) {
      p.x = x;
      p.y = y;
      return p;
    }
    return { x, y };
  };

  const recyclePoint = (point: Point): void => {
    pointPoolRef.current.push(point);
  };

  const addLineToDot = (gs: GameState, dot: DotState, line: SquigglyLine): void => {
    dot.lines.push(line);
    dot.activeLineIds.push(line.id);
    gs.lineMap.set(line.id, line);
    dot.unconnectedCount++;
  };

  const removeActiveLines = (dot: DotState, idA: string, idB: string): void => {
    let w = 0;
    for (let i = 0; i < dot.activeLineIds.length; i++) {
      const id = dot.activeLineIds[i];
      if (id !== idA && id !== idB) {
        dot.activeLineIds[w++] = id;
      }
    }
    dot.activeLineIds.length = w;
  };

  const recycleRemovedLine = (gs: GameState, lineId: string): void => {
    const line = gs.lineMap.get(lineId);
    if (!line) return;
    for (let i = 0; i < line.pathPoints.length; i++) {
      recyclePoint(line.pathPoints[i]);
    }
    gs.lineMap.delete(lineId);
    recycleLine(line);
  };

  const markCoveredCell = (dot: DotState, x: number, y: number): void => {
    const key = packCell((x * INV_CELL_SIZE) | 0, (y * INV_CELL_SIZE) | 0);
    const before = dot.coveredCells.size;
    dot.coveredCells.add(key);
    if (dot.coveredCells.size !== before) {
      dot.coverageDirty = true;
      if (dot.growthRingCells.has(key)) {
        dot.growthRingCovered++;
      }
    }
  };

  const getRingOffsets = (outerR: number): Array<[number, number]> => {
    const key = Math.ceil(outerR / CELL_SIZE);
    const cached = _ringOffsetsCache.get(key);
    if (cached) return cached;
    const offsets: Array<[number, number]> = [];
    for (let dx = -key; dx <= key; dx++) {
      for (let dy = -key; dy <= key; dy++) {
        offsets.push([dx, dy]);
      }
    }
    _ringOffsetsCache.set(key, offsets);
    return offsets;
  };

  const rebuildGrowthRing = (dot: DotState): void => {
    dot.growthRingCells.clear();
    dot.growthRingCovered = 0;

    const innerR = dot.targetRadius;
    const outerR = dot.targetRadius + DOT_GROWTH_AMOUNT;
    const innerRSq = innerR * innerR;
    const outerRSq = outerR * outerR;

    const baseCX = Math.floor(dot.x * INV_CELL_SIZE);
    const baseCY = Math.floor(dot.y * INV_CELL_SIZE);
    const offsets = getRingOffsets(outerR);
    for (let i = 0; i < offsets.length; i++) {
      const [dx, dy] = offsets[i];
      const cx = baseCX + dx;
      const cy = baseCY + dy;
      const px = (cx + 0.5) * CELL_SIZE;
      const py = (cy + 0.5) * CELL_SIZE;
      const dSq = (px - dot.x) ** 2 + (py - dot.y) ** 2;
      if (dSq >= innerRSq && dSq < outerRSq) {
        const packed = packCell(cx, cy);
        dot.growthRingCells.add(packed);
        if (dot.coveredCells.has(packed)) dot.growthRingCovered++;
      }
    }
  };

  const rebuildHeadGrid = (gs: GameState): void => {
    const grid = headGridRef.current;
    grid.clear();
    for (let di = 0; di < gs.dots.length; di++) {
      const dot = gs.dots[di];
      for (let li = 0; li < dot.activeLineIds.length; li++) {
        const line = gs.lineMap.get(dot.activeLineIds[li]);
        if (!line) continue;
        const head = headOf(line);
        const cell = packCell(
          (head.x * INV_HEAD_GRID_CELL_SIZE) | 0,
          (head.y * INV_HEAD_GRID_CELL_SIZE) | 0,
        );
        const bucket = grid.get(cell);
        if (bucket) {
          bucket.push(line.id);
        } else {
          grid.set(cell, [line.id]);
        }
      }
    }
  };

  /** Find the nearest unconnected line head within squared radius. */
  const nearestHead = (
    pt: Point,
    radiusSq: number,
    excludeId?: string,
    sameDotId?: string,
  ): SquigglyLine | undefined => {
    let best: SquigglyLine | undefined;
    let bestDistSq = radiusSq;
    const radius = Math.sqrt(radiusSq);
    const cellRadius = Math.max(1, Math.ceil(radius / HEAD_GRID_CELL_SIZE));
    const cx0 = (pt.x * INV_HEAD_GRID_CELL_SIZE) | 0;
    const cy0 = (pt.y * INV_HEAD_GRID_CELL_SIZE) | 0;
    const grid = headGridRef.current;

    for (let cx = cx0 - cellRadius; cx <= cx0 + cellRadius; cx++) {
      for (let cy = cy0 - cellRadius; cy <= cy0 + cellRadius; cy++) {
        const bucket = grid.get(packCell(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const line = findLine(bucket[i]);
          if (!line) continue;
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
    }
    return best;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Game loop tick
  // ─────────────────────────────────────────────────────────────────────────

  const gameLoop = useCallback(
    (dt: number, timestamp: number, shouldRender: boolean) => {
      const gs = stateRef.current;
      if (gs.status !== 'playing') return;

      if (shouldRender) {
        triggerRender();
        return;
      }

      if (dt <= 0) return;

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
        if (dot.growthRingCells.size === 0) {
          rebuildGrowthRing(dot);
        }
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
            let created = 0;
            while (created + 1 < toCreate) {
              const angleA = Math.random() * Math.PI * 2;
              const angleB = Math.random() * Math.PI * 2;
              const a = createLine(dot.id,
                dot.x + Math.cos(angleA) * dot.radius,
                dot.y + Math.sin(angleA) * dot.radius, now);
              const b = createLine(dot.id,
                dot.x + Math.cos(angleB) * dot.radius,
                dot.y + Math.sin(angleB) * dot.radius, now);
              a.partnerId = b.id;
              b.partnerId = a.id;
              addLineToDot(gs, dot, a);
              addLineToDot(gs, dot, b);
              created += 2;
            }
            if (created < toCreate) {
              const angle = Math.random() * Math.PI * 2;
              const single = createLine(dot.id,
                dot.x + Math.cos(angle) * dot.radius,
                dot.y + Math.sin(angle) * dot.radius, now);
              addLineToDot(gs, dot, single);
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

          // Spawn count scales with total connections.
          // Desktop web: 4 → 6 → 8 → 10. Mobile/native: 2 → 4 → 6 → 8.
          const spawnCount = isDesktopWeb
            ? (gs.totalConnected >= 125 ? 10
              : gs.totalConnected >= 75 ? 8
              : gs.totalConnected >= 25 ? 6
              : 4)
            : (gs.totalConnected >= 125 ? 10
              : gs.totalConnected >= 75 ? 8
              : gs.totalConnected >= 25 ? 6
              : 4);
          // Cap unconnected lines per dot
          const allowed = Math.max(0, MAX_UNCONNECTED_PER_DOT - dot.unconnectedCount);

          // Spawn lines staggered in paired waves by 150ms each
          const toSpawn = Math.min(spawnCount, allowed);
          const pairCount = (toSpawn / 2) | 0;
          for (let pi = 0; pi < pairCount; pi++) {
            if (pi === 0) {
              const angleA = Math.random() * Math.PI * 2;
              const angleB = Math.random() * Math.PI * 2;
              const a = createLine(dot.id,
                dot.x + Math.cos(angleA) * dot.radius,
                dot.y + Math.sin(angleA) * dot.radius, now);
              const b = createLine(dot.id,
                dot.x + Math.cos(angleB) * dot.radius,
                dot.y + Math.sin(angleB) * dot.radius, now);
              a.partnerId = b.id;
              b.partnerId = a.id;
              addLineToDot(gs, dot, a);
              addLineToDot(gs, dot, b);
            } else {
              dot.pendingBatches.push({ count: 2, spawnAt: now + pi * 150 });
            }
          }
          if (toSpawn % 2 === 1) {
            const oddDelay = pairCount === 0 ? 0 : pairCount * 150;
            if (oddDelay === 0) {
              const angle = Math.random() * Math.PI * 2;
              const single = createLine(dot.id,
                dot.x + Math.cos(angle) * dot.radius,
                dot.y + Math.sin(angle) * dot.radius, now);
              addLineToDot(gs, dot, single);
            } else {
              dot.pendingBatches.push({ count: 1, spawnAt: now + oddDelay });
            }
          }
        }

        let activeWrite = 0;
        for (let ai = 0; ai < dot.activeLineIds.length; ai++) {
          const lineId = dot.activeLineIds[ai];
          const line = gs.lineMap.get(lineId);
          if (!line) continue;

          // ── Penalty check ────────────────────────────────────────────────
          if (!line.connectedToId && !line.penaltyApplied) {
            if (now - line.spawnTime > CONNECT_PENALTY_WINDOW) {
              line.penaltyApplied = true;
              const partner = line.partnerId ? gs.lineMap.get(line.partnerId) : undefined;
              if (partner && !partner.connectedToId && !partner.penaltyApplied) {
                partner.penaltyApplied = true;
                dot.spawnInterval = Math.max(1000, dot.spawnInterval - SPAWN_INTERVAL_DECREASE);
                dot.flash = { type: 'penalty', startTime: now };
                dot.combo = 0;
              }
            }
          }

          // ── Keep only active unconnected ids hot in this list ────────────
          if (line.connectedToId !== null) continue;
          dot.activeLineIds[activeWrite++] = lineId;

          // ── Skip lines that are being dragged ────────────────────────────
          if (gs.draggingMap.size > 0 && isDragged(line.id)) continue;

          // ── Move head ────────────────────────────────────────────────────
          const prevHead = headOf(line);

          // After ESCAPE_TIME the line breaks free of the explore zone.
          const escaped = now - line.spawnTime > ESCAPE_TIME;

          // Always push the head off the dot surface — escaped or not.
          // This prevents lines from drifting back inside and piling up.
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
          } else if (!escaped) {
            // Explore-zone pull-back (only while not yet escaped)
            const exploreR = dot.radius * EXPLORE_RADIUS_MULT;
            const exploreInner = exploreR * 0.3;
            const exploreRange = exploreR * 0.7;
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

          // Organic direction change via phase accumulators (no per-frame RNG).
          line.wanderPhase = advancePhase(line.wanderPhase, line.wanderOmega, dt);
          line.direction += Math.sin(line.wanderPhase) * DIRECTION_WOBBLE * 0.85 * dt;

          // Escaped lines get stronger wandering so they don't beeline to the edge
          if (escaped) {
            line.escapeTurnPhase = advancePhase(
              line.escapeTurnPhase,
              line.escapeTurnOmegaA,
              dt,
            );
            const ratio = line.escapeTurnOmegaB / Math.max(line.escapeTurnOmegaA, 0.001);
            line.direction += Math.sin(line.escapeTurnPhase) * 2.0 * dt
                            + Math.cos(line.escapeTurnPhase * ratio) * 1.5 * dt;
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
            line.pathPoints.push(allocPoint(newHead.x, newHead.y));

            // Invalidate wiggle cache — will be rebuilt at render time
            line.cachedWiggleSvg = null;
            line.cachedWiggleFrame = -1;

            // Mark coverage cell incrementally (updates growth-ring counter too)
            markCoveredCell(dot, newHead.x, newHead.y);

            // Compress if too long (keeps first anchor + last head)
            if (line.pathPoints.length > MAX_PATH_POINTS) {
              const oldPath = line.pathPoints;
              for (let i = 1; i < oldPath.length - 1; i += 2) {
                recyclePoint(oldPath[i]);
              }
              line.pathPoints = compressPath(oldPath);
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
        dot.activeLineIds.length = activeWrite;

        // ── Dot growth (coverage-based: expand when 90% ring covered) ────
        // Incremental coverage counting keeps each check O(1); only ring rebuilds are O(k).
        if (dot.coverageDirty && gs.frameCount % 6 === dotIndex) {
          dot.coverageDirty = false;
          const totalCells = dot.growthRingCells.size;
          if (
            totalCells > 0 &&
            dot.growthRingCovered / totalCells >= COVERAGE_THRESHOLD
          ) {
            dot.targetRadius += DOT_GROWTH_AMOUNT;
            rebuildGrowthRing(dot);
          }
        }
      }

      gs.loopTimeSec = timestamp * 0.001;
      gs.frameCount++;
      rebuildHeadGrid(gs);
    },
    [width, height, triggerRender],
  );

  useGameLoop(gameLoop, stateRef.current.status === 'playing', 60, 30);

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
          const pt = allocPoint(touch.locationX, touch.locationY);
          const target = nearestHead(pt, HIT_RADIUS_SQ);
          recyclePoint(pt);
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

          const newX = touch.locationX;
          const newY = touch.locationY;
          const prev = headOf(line);
          const dx = prev.x - newX;
          const dy = prev.y - newY;

          if (dx * dx + dy * dy >= POINT_SAMPLE_DISTANCE_SQ) {
            const newPt = allocPoint(newX, newY);
            line.pathPoints.push(newPt);
            line.cachedWiggleSvg = null; // invalidate wiggle cache
            line.cachedWiggleFrame = -1;
            if (line.pathPoints.length > MAX_PATH_POINTS) {
              const oldPath = line.pathPoints;
              for (let i = 1; i < oldPath.length - 1; i += 2) {
                recyclePoint(oldPath[i]);
              }
              line.pathPoints = compressPath(oldPath);
            }
            const parentDot = line.dotId === gs.dots[0].id ? gs.dots[0] : gs.dots[1];
            if (parentDot) {
              markCoveredCell(parentDot, newPt.x, newPt.y);
            }
          }
          continue;
        }

        // phase === 'end'
        const lineId = gs.draggingMap.get(id);
        if (!lineId) continue;

        const draggedLine = findLine(lineId);
        if (draggedLine) {
          const relPt = allocPoint(touch.locationX, touch.locationY);
          const snapTarget = nearestHead(
            relPt,
            SNAP_RADIUS_SQ,
            draggedLine.id,
            draggedLine.dotId,
          );
          recyclePoint(relPt);

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
            const draggedHead = draggedLine.pathPoints[draggedLine.pathPoints.length - 1];
            draggedHead.x = snapHead.x;
            draggedHead.y = snapHead.y;
            const t = gs.loopTimeSec;
            bakeWiggle(draggedLine.pathPoints, t, draggedLine.wiggleVariant);
            bakeWiggle(snapTarget.pathPoints, t, snapTarget.wiggleVariant);
            draggedLine.cachedSvgPath = pointsToSvgPath(draggedLine.pathPoints);
            snapTarget.cachedSvgPath = pointsToSvgPath(snapTarget.pathPoints);
            if (parentDot) {
              removeActiveLines(parentDot, draggedLine.id, snapTarget.id);
              for (const pt of draggedLine.pathPoints) {
                markCoveredCell(parentDot, pt.x, pt.y);
              }
              for (const pt of snapTarget.pathPoints) {
                markCoveredCell(parentDot, pt.x, pt.y);
              }

              // Persist connected lines as a single static gray stroke.
              if (draggedLine.cachedSvgPath) parentDot.connectedPaths.push(draggedLine.cachedSvgPath);
              if (snapTarget.cachedSvgPath) parentDot.connectedPaths.push(snapTarget.cachedSvgPath);
              parentDot.connectedSvgDirty = true;

              // Remove from storage arrays and recycle objects for reuse.
              let w = 0;
              for (let li = 0; li < parentDot.lines.length; li++) {
                const l = parentDot.lines[li];
                if (l.id !== draggedLine.id && l.id !== snapTarget.id) {
                  parentDot.lines[w++] = l;
                }
              }
              parentDot.lines.length = w;
              recycleRemovedLine(gs, draggedLine.id);
              recycleRemovedLine(gs, snapTarget.id);
            }
          }
        }

        gs.draggingMap.delete(id);
        if (lineId) gs.dragStartTime.delete(lineId);
      }
      rebuildHeadGrid(gs);
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
    const gs = stateRef.current;
    for (const lineId of gs.lineMap.keys()) {
      recycleRemovedLine(gs, lineId);
    }
    stateRef.current = createInitialState(width, height);
    _dotSvgCache.clear();
    headGridRef.current.clear();
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
          {/* Connected (static) lines — persistent gray stroke */}
          {gs.dots.map((dot: DotState) => {
            if (dot.connectedSvgDirty) {
              dot.cachedConnectedSvg = dot.connectedPaths.join(' ');
              dot.connectedSvgDirty = false;
            }
            return dot.cachedConnectedSvg ? (
              <Path
                key={`${dot.id}-connected`}
                d={dot.cachedConnectedSvg}
                stroke="#444444"
                strokeWidth={6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
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

            for (let i = 0; i < dot.activeLineIds.length; i++) {
              const line = gs.lineMap.get(dot.activeLineIds[i]);
              if (!line) continue;
              hasLines = true;
              const isDragging = isLineDragged(line.id);
              const pathLen = line.pathPoints.length;
              const lodStride = pathLen > 220 ? 3 : pathLen > 120 ? 2 : 1;
              const cadenceDue = gs.frameCount - line.cachedWiggleFrame >= 4;
              if (
                !line.cachedWiggleSvg ||
                line.cachedWiggleStride !== lodStride ||
                cadenceDue
              ) {
                line.cachedWiggleSvg = pointsToWiggledSvgPathLod(
                  line.pathPoints,
                  renderTime,
                  line.wiggleVariant,
                  lodStride,
                );
                line.cachedWiggleFrame = gs.frameCount;
                line.cachedWiggleStride = lodStride;
              }
              const svgPath = line.cachedWiggleSvg;
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
            // Rebuild dot path every 2 frames — bump animation doesn't need 60fps,
            // and caching lets the GPU reuse the rasterised fill for large dots.
            const cachedDotPath = _dotSvgCache.get(dot.id);
            if (cachedDotPath && gs.frameCount % 2 !== 0) {
              return <Path key={dot.id} d={cachedDotPath} fill="#111111" />;
            }
            let r = dot.radius;
            // Spawn pulse: 8% scale bump decaying over 300ms
            const pulseElapsed = renderNow - dot.lastSpawnPulseTime;
            if (pulseElapsed < 300 && dot.lastSpawnPulseTime > 0) {
              r *= 1 + 0.08 * (1 - pulseElapsed / 300);
            }
            const BUMPS = 5;                          // fewer bumps → rounder, less jittery
            const BUMP_AMP = Math.min(r * 0.04, 3);   // cap at 3 px so large dots stay smooth
            const BUMP_SPEED = 1.2;                    // slower oscillation
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
            _dotSvgCache.set(dot.id, dotPath);
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
    backgroundColor: '#faecdb',
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
