// ─── Shared types ───────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface SquigglyLine {
  id: string;
  dotId: string;
  /** Full path history, index 0 is anchored at the parent dot. */
  pathPoints: Point[];
  /** Current movement direction in radians. */
  direction: number;
  /** Connected to another line's id, or null. */
  connectedToId: string | null;
  /** Timestamp when this line was spawned (ms). */
  spawnTime: number;
  /** Set to true once the 2-second penalty window has passed. */
  penaltyApplied: boolean;
}

export interface DotState {
  id: string;
  x: number;
  y: number;
  /** Visual radius in px — grows as connected coverage increases. */
  radius: number;
  /** Current interval between spawns in ms. */
  spawnInterval: number;
  /** Timestamp of the last spawn event. */
  lastSpawnTime: number;
  lines: SquigglyLine[];
  /** Total length (px) of all connected paths — drives dot growth. */
  connectedPathLength: number;
  /** Grid cells (keyed "cx,cy") covered by squiggly lines around this dot. */
  coveredCells: Set<string>;
}

export interface GameState {
  status: 'playing' | 'gameOver';
  startTime: number;
  /** Survival time in seconds (updated every frame). */
  survivalTime: number;
  dots: DotState[];
  /** Id of the line currently being dragged, or null. */
  draggingLineId: string | null;
}

// ─── Tunable constants ───────────────────────────────────────────────────────

/** Initial spawn interval minimum (ms). */
export const SPAWN_INTERVAL_MIN = 5000;
/** Initial spawn interval maximum (ms). */
export const SPAWN_INTERVAL_MAX = 10000;
/** Hard floor for spawn interval (ms). */
export const MIN_SPAWN_INTERVAL = 1000;
/** How much the spawn interval shrinks after a missed connection (ms). */
export const SPAWN_INTERVAL_DECREASE = 200;
/** How long the player has to connect a spawned pair before a penalty (ms). */
export const CONNECT_PENALTY_WINDOW = 2000;

/** Head movement speed in px/s. */
export const LINE_SPEED = 40;
/** Max angular change per second (radians). Higher = wigglier. */
export const DIRECTION_WOBBLE = 2.5;
/** Touch / click hit radius for grabbing a head (px). */
export const HIT_RADIUS = 36;
/** Snap-to-connect radius when releasing a drag (px). */
export const SNAP_RADIUS = 50;
/** Maximum number of points stored per line (older ones are compressed). */
export const MAX_PATH_POINTS = 400;
/** Sample a new path point every N pixels of head movement. */
export const POINT_SAMPLE_DISTANCE = 5;

/** Initial dot visual radius (px). */
export const INITIAL_DOT_RADIUS = 12;
/** How much the dot radius grows each time growth triggers. */
export const DOT_GROWTH_AMOUNT = 8;
/** Connected-path length needed (px) before dot grows. */
export const GROWTH_THRESHOLD = 2500;

/** How far (px) lines explore from their parent dot before steering back. */
export const EXPLORE_RADIUS = 150;
/** Strength of the return-to-dot steering force. */
export const RETURN_FORCE = 3.0;
/** Grid cell size (px) for tracking area coverage around each dot. */
export const CELL_SIZE = 6;
/** Fraction of ring cells that must be covered for the dot to grow. */
export const COVERAGE_THRESHOLD = 0.9;

// ─── Factory helpers ─────────────────────────────────────────────────────────

let _lineCounter = 0;

export function createLine(
  dotId: string,
  dotX: number,
  dotY: number,
  now: number,
): SquigglyLine {
  _lineCounter += 1;
  return {
    id: `line-${_lineCounter}`,
    dotId,
    // Two points: fixed anchor at dot + live head (same position initially)
    pathPoints: [{ x: dotX, y: dotY }, { x: dotX, y: dotY }],
    direction: Math.random() * Math.PI * 2,
    connectedToId: null,
    spawnTime: now,
    penaltyApplied: false,
  };
}

export function createInitialState(width: number, height: number): GameState {
  const centerY = height / 2;
  const leftX = width * 0.25;
  const rightX = width * 0.75;
  const now = Date.now();

  const makeInterval = () =>
    SPAWN_INTERVAL_MIN + Math.random() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);

  return {
    status: 'playing',
    startTime: now,
    survivalTime: 0,
    draggingLineId: null,
    dots: [
      {
        id: 'dot-left',
        x: leftX,
        y: centerY,
        radius: INITIAL_DOT_RADIUS,
        spawnInterval: makeInterval(),
        lastSpawnTime: now,
        lines: [],
        connectedPathLength: 0,
        coveredCells: new Set<string>(),
      },
      {
        id: 'dot-right',
        x: rightX,
        y: centerY,
        radius: INITIAL_DOT_RADIUS,
        spawnInterval: makeInterval(),
        lastSpawnTime: now,
        lines: [],
        connectedPathLength: 0,
        coveredCells: new Set<string>(),
      },
    ],
  };
}
