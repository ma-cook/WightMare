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
import React, { useCallback, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  CELL_SIZE,
  CONNECT_PENALTY_WINDOW,
  COVERAGE_THRESHOLD,
  DIRECTION_WOBBLE,
  DOT_GROWTH_AMOUNT,
  EXPLORE_RADIUS_MULT,
  HIT_RADIUS_SQ,
  INV_CELL_SIZE,
  LINE_SPEED,
  MAX_PATH_POINTS,
  POINT_SAMPLE_DISTANCE_SQ,
  RETURN_FORCE,
  SNAP_RADIUS_SQ,
  SPAWN_INTERVAL_DECREASE,
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
}

export default function GameCanvas({ width, height }: Props) {
  // ── React state: only used to trigger re-renders ──────────────────────────
  const [renderTick, setRenderTick] = useState(0);
  const triggerRender = useCallback(() => setRenderTick((t) => t + 1), []);

  // ── All mutable game data lives here ─────────────────────────────────────
  const stateRef = useRef<GameState>(createInitialState(width, height));

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  const findLine = (id: string): SquigglyLine | undefined => {
    for (const dot of stateRef.current.dots) {
      for (const line of dot.lines) {
        if (line.id === id) return line;
      }
    }
    return undefined;
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
        // ── Spawn ──────────────────────────────────────────────────────────
        if (now - dot.lastSpawnTime >= dot.spawnInterval) {
          dot.lastSpawnTime = now;
          // Randomise next interval
          dot.spawnInterval =
            SPAWN_INTERVAL_MIN +
            Math.random() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);

          // Spawn count scales with total connections: 2 base, +2 at 100, +4 at 200
          const spawnCount = gs.totalConnected >= 200 ? 6
            : gs.totalConnected >= 100 ? 4
            : 2;
          for (let si = 0; si < spawnCount; si++) {
            const angle = Math.random() * Math.PI * 2;
            const sx = dot.x + Math.cos(angle) * dot.radius;
            const sy = dot.y + Math.sin(angle) * dot.radius;
            dot.lines.push(createLine(dot.id, sx, sy, now));
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
                dot.spawnInterval += SPAWN_INTERVAL_DECREASE;
              }
            }
          }

          // ── Skip lines that are connected or being dragged ───────────────
          if (line.connectedToId !== null) continue;
          if (line.id === gs.draggingLineId) continue;

          // ── Move head ────────────────────────────────────────────────────
          const prevHead = headOf(line);

          // Steer toward parent dot to keep exploring nearby
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
            // Stronger push the deeper inside
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

          // Organic direction change: random wobble + sine component
          const sineComponent =
            Math.sin(timestamp * 0.002 + line.numericId) * 0.8;
          line.direction +=
            (Math.random() - 0.5) * DIRECTION_WOBBLE * dt + sineComponent * dt;

          const speed = LINE_SPEED * dt;
          const newHead: Point = {
            x: prevHead.x + Math.cos(line.direction) * speed,
            y: prevHead.y + Math.sin(line.direction) * speed,
          };

          // Always update the live head position (last point in array)
          line.pathPoints[line.pathPoints.length - 1] = newHead;

          // Commit a new sample point when head moves far enough from
          // the second-to-last point (the last "committed" position)
          const lastCommitted = line.pathPoints.length >= 2
            ? line.pathPoints[line.pathPoints.length - 2]
            : line.pathPoints[0];
          if (distanceSq(lastCommitted, newHead) >= POINT_SAMPLE_DISTANCE_SQ) {
            // Push a new live-head slot; the current newHead becomes committed
            line.pathPoints.push({ ...newHead });

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
          const innerR = dot.radius;
          const outerR = dot.radius + DOT_GROWTH_AMOUNT;
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
            dot.radius = outerR;
          }
        }
      }

      gs.loopTimeSec = timestamp * 0.001;
      triggerRender();
    },
    [width, height, triggerRender],
  );

  useGameLoop(gameLoop, stateRef.current.status === 'playing');

  // ─────────────────────────────────────────────────────────────────────────
  // PanResponder — drag-to-connect mechanic
  // ─────────────────────────────────────────────────────────────────────────

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (evt: GestureResponderEvent) => {
        const { locationX, locationY } = evt.nativeEvent;
        const pt: Point = { x: locationX, y: locationY };
        const target = nearestHead(pt, HIT_RADIUS_SQ);
        if (target) {
          stateRef.current.draggingLineId = target.id;
        }
      },

      onPanResponderMove: (
        evt: GestureResponderEvent,
        _gestureState: PanResponderGestureState,
      ) => {
        const gs = stateRef.current;
        if (!gs.draggingLineId) return;
        const line = findLine(gs.draggingLineId);
        if (!line) return;

        const { locationX, locationY } = evt.nativeEvent;
        const newPt: Point = { x: locationX, y: locationY };
        const prev = headOf(line);

        // Extend the path organically: add point only when moved enough
        if (distanceSq(prev, newPt) >= POINT_SAMPLE_DISTANCE_SQ) {
          line.pathPoints.push(newPt);
          if (line.pathPoints.length > MAX_PATH_POINTS) {
            line.pathPoints = compressPath(line.pathPoints);
          }
          // Mark coverage cell
          const parentDot = gs.dots.find((d) => d.id === line.dotId);
          if (parentDot) {
            parentDot.coveredCells.add(
              packCell((newPt.x * INV_CELL_SIZE) | 0, (newPt.y * INV_CELL_SIZE) | 0),
            );
            parentDot.coverageDirty = true;
          }
        }
      },

      onPanResponderRelease: (evt: GestureResponderEvent) => {
        const gs = stateRef.current;
        if (!gs.draggingLineId) return;

        const draggedLine = findLine(gs.draggingLineId);
        if (draggedLine) {
          const relPt: Point = {
            x: evt.nativeEvent.locationX,
            y: evt.nativeEvent.locationY,
          };
          const snapTarget = nearestHead(
            relPt,
            SNAP_RADIUS_SQ,
            draggedLine.id,
            draggedLine.dotId,
          );

          if (snapTarget) {
            // Connect the two lines
            draggedLine.connectedToId = snapTarget.id;
            snapTarget.connectedToId = draggedLine.id;
            gs.totalConnected++;
            // Merge heads at snap target's current position
            const snapHead = headOf(snapTarget);
            draggedLine.pathPoints[draggedLine.pathPoints.length - 1] = {
              ...snapHead,
            };
            // Bake wiggle offsets into path points so bumpy shape is preserved
            const t = gs.loopTimeSec;
            bakeWiggle(draggedLine.pathPoints, t);
            bakeWiggle(snapTarget.pathPoints, t);
            // Mark all path cells for coverage
            const parentDot = gs.dots.find((d) => d.id === draggedLine.dotId);
            if (parentDot) {
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

        gs.draggingLineId = null;
      },

      onPanResponderTerminate: () => {
        stateRef.current.draggingLineId = null;
      },
    }),
  ).current;

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
        style={[styles.touchLayer, { width, height }]}
        {...panResponder.panHandlers}
      >
        <Svg width={width} height={height} style={styles.svg}>
          {/* Squiggly lines */}
          {gs.dots.map((dot: DotState) =>
            dot.lines.map((line: SquigglyLine) => {
              const isConnected = line.connectedToId !== null;
              const isDragging = line.id === gs.draggingLineId;
              const svgPath = isConnected
                ? pointsToSvgPath(line.pathPoints)
                : pointsToWiggledSvgPath(line.pathPoints, renderTime);
              const head = headOf(line);

              return (
                <React.Fragment key={line.id}>
                  <Path
                    d={svgPath}
                    stroke={isConnected ? CONNECTED_COLOR : LINE_COLOR}
                    strokeWidth={6}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Head indicator — only shown for unconnected lines */}
                  {!isConnected && (
                    <Circle
                      cx={head.x}
                      cy={head.y}
                      r={isDragging ? 9 : 6}
                      fill={HEAD_COLOR}
                    />
                  )}
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
            const segments = Math.max(24, Math.round(r * 2));
            const step = (Math.PI * 2) / segments;

            // Pre-compute points on the bumpy circle
            const pts: { x: number; y: number }[] = [];
            for (let i = 0; i < segments; i++) {
              const angle = i * step;
              const bump =
                Math.sin(angle * BUMPS + renderTime * BUMP_SPEED) * BUMP_AMP * 0.6 +
                Math.sin(angle * (BUMPS + 3) - renderTime * BUMP_SPEED * 1.3) * BUMP_AMP * 0.4;
              const br = r + bump;
              pts.push({
                x: dot.x + Math.cos(angle) * br,
                y: dot.y + Math.sin(angle) * br,
              });
            }

            // Build smooth closed cubic-bezier path through the points
            const n = pts.length;
            let dotPath = `M ${Math.round(pts[0].x)} ${Math.round(pts[0].y)}`;
            for (let i = 0; i < n; i++) {
              const p0 = pts[(i - 1 + n) % n];
              const p1 = pts[i];
              const p2 = pts[(i + 1) % n];
              const p3 = pts[(i + 2) % n];
              // Catmull-Rom → cubic bezier control points (tension 1/6)
              const cp1x = p1.x + (p2.x - p0.x) / 6;
              const cp1y = p1.y + (p2.y - p0.y) / 6;
              const cp2x = p2.x - (p3.x - p1.x) / 6;
              const cp2y = p2.y - (p3.y - p1.y) / 6;
              dotPath += ` C ${Math.round(cp1x)} ${Math.round(cp1y)}, ${Math.round(cp2x)} ${Math.round(cp2y)}, ${Math.round(p2.x)} ${Math.round(p2.y)}`;
            }
            dotPath += ' Z';
            return (
              <Path
                key={dot.id}
                d={dotPath}
                fill="#111111"
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
          onPlayAgain={handlePlayAgain}
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
