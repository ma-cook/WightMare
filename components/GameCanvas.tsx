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
  EXPLORE_RADIUS,
  HIT_RADIUS,
  LINE_SPEED,
  MAX_PATH_POINTS,
  POINT_SAMPLE_DISTANCE,
  RETURN_FORCE,
  SNAP_RADIUS,
  SPAWN_INTERVAL_DECREASE,
  SPAWN_INTERVAL_MAX,
  SPAWN_INTERVAL_MIN,
  createInitialState,
  createLine,
  type DotState,
  type GameState,
  type Point,
  type SquigglyLine,
} from '../engine/gameEngine';
import {
  compressPath,
  distance,
  pointsToSvgPath,
  wigglePoints,
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

  const allLines = (): SquigglyLine[] =>
    stateRef.current.dots.flatMap((d) => d.lines);

  const findLine = (id: string): SquigglyLine | undefined =>
    allLines().find((l) => l.id === id);

  const findLinesByDot = (dotId: string): SquigglyLine[] =>
    stateRef.current.dots.find((d) => d.id === dotId)?.lines ?? [];

  const headOf = (line: SquigglyLine): Point =>
    line.pathPoints[line.pathPoints.length - 1];

  /** Find the nearest unconnected line head within radius. */
  const nearestHead = (
    pt: Point,
    radius: number,
    excludeId?: string,
    sameDotId?: string,
  ): SquigglyLine | undefined => {
    let best: SquigglyLine | undefined;
    let bestDist = radius;
    for (const line of allLines()) {
      if (line.id === excludeId) continue;
      if (line.connectedToId !== null) continue;
      if (sameDotId !== undefined && line.dotId !== sameDotId) continue;
      const d = distance(pt, headOf(line));
      if (d < bestDist) {
        bestDist = d;
        best = line;
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

          dot.lines.push(createLine(dot.id, dot.x, dot.y, now));
          dot.lines.push(createLine(dot.id, dot.x, dot.y, now));
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
          const dotDx = dot.x - prevHead.x;
          const dotDy = dot.y - prevHead.y;
          const distToDot = Math.sqrt(dotDx * dotDx + dotDy * dotDy);
          if (distToDot > EXPLORE_RADIUS * 0.3) {
            const angleToCenter = Math.atan2(dotDy, dotDx);
            let angleDiff = angleToCenter - line.direction;
            while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
            while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
            const t = Math.min(
              (distToDot - EXPLORE_RADIUS * 0.3) / (EXPLORE_RADIUS * 0.7),
              1,
            );
            line.direction += angleDiff * RETURN_FORCE * t * dt;
          }

          // Organic direction change: random wobble + sine component
          const sineComponent =
            Math.sin(timestamp * 0.002 + parseInt(line.id.replace(/\D/g, ''), 10)) * 0.8;
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
          if (distance(lastCommitted, newHead) >= POINT_SAMPLE_DISTANCE) {
            // Push a new live-head slot; the current newHead becomes committed
            line.pathPoints.push({ ...newHead });

            // Mark coverage cell
            dot.coveredCells.add(
              `${Math.floor(newHead.x / CELL_SIZE)},${Math.floor(newHead.y / CELL_SIZE)}`,
            );

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
        const innerR = dot.radius;
        const outerR = dot.radius + DOT_GROWTH_AMOUNT;
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
            const d = Math.sqrt((px - dot.x) ** 2 + (py - dot.y) ** 2);
            if (d >= innerR && d < outerR) {
              totalCells++;
              if (dot.coveredCells.has(`${cx},${cy}`)) coveredCount++;
            }
          }
        }
        if (totalCells > 0 && coveredCount / totalCells >= COVERAGE_THRESHOLD) {
          dot.radius = outerR;
        }
      }

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
        const target = nearestHead(pt, HIT_RADIUS);
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
        if (distance(prev, newPt) >= POINT_SAMPLE_DISTANCE) {
          line.pathPoints.push(newPt);
          if (line.pathPoints.length > MAX_PATH_POINTS) {
            line.pathPoints = compressPath(line.pathPoints);
          }
          // Mark coverage cell
          const parentDot = gs.dots.find((d) => d.id === line.dotId);
          if (parentDot) {
            parentDot.coveredCells.add(
              `${Math.floor(newPt.x / CELL_SIZE)},${Math.floor(newPt.y / CELL_SIZE)}`,
            );
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
            SNAP_RADIUS,
            draggedLine.id,
            draggedLine.dotId,
          );

          if (snapTarget) {
            // Connect the two lines
            draggedLine.connectedToId = snapTarget.id;
            snapTarget.connectedToId = draggedLine.id;
            // Merge heads at snap target's current position
            const snapHead = headOf(snapTarget);
            draggedLine.pathPoints[draggedLine.pathPoints.length - 1] = {
              ...snapHead,
            };
            // Mark all path cells for coverage
            const parentDot = gs.dots.find((d) => d.id === draggedLine.dotId);
            if (parentDot) {
              for (const pt of draggedLine.pathPoints) {
                parentDot.coveredCells.add(
                  `${Math.floor(pt.x / CELL_SIZE)},${Math.floor(pt.y / CELL_SIZE)}`,
                );
              }
              for (const pt of snapTarget.pathPoints) {
                parentDot.coveredCells.add(
                  `${Math.floor(pt.x / CELL_SIZE)},${Math.floor(pt.y / CELL_SIZE)}`,
                );
              }
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

  return (
    <View style={styles.container}>
      {/* Touch / mouse capture layer */}
      <View
        style={[styles.touchLayer, { width, height }]}
        {...panResponder.panHandlers}
      >
        <Svg width={width} height={height} style={styles.svg}>
          {/* Squiggly lines */}
          {gs.dots.flatMap((dot: DotState) =>
            dot.lines.map((line: SquigglyLine) => {
              const isConnected = line.connectedToId !== null;
              const isDragging = line.id === gs.draggingLineId;
              const now = Date.now() / 1000;
              const displayPts = wigglePoints(line.pathPoints, now);
              const svgPath = pointsToSvgPath(displayPts);
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

          {/* Dots */}
          {gs.dots.map((dot: DotState) => (
            <Circle
              key={dot.id}
              cx={dot.x}
              cy={dot.y}
              r={dot.radius}
              fill="#111111"
            />
          ))}
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
