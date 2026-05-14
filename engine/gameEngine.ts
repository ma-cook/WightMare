// ─── Shared types ───────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface SquigglyLine {
  id: string;
  numericId: number;
  dotId: string;
  /** Id of this line's spawn partner, if any. */
  partnerId: string | null;
  /** Full path history, index 0 is anchored at the parent dot. */
  pathPoints: Point[];
  /** Current movement direction in radians. */
  direction: number;
  /** Phase for gentle wander steering. */
  wanderPhase: number;
  /** Angular frequency for wander phase. */
  wanderOmega: number;
  /** Phase for escaped turning behaviour. */
  escapeTurnPhase: number;
  /** Primary angular frequency for escaped turning behaviour. */
  escapeTurnOmegaA: number;
  /** Secondary angular frequency for escaped turning behaviour. */
  escapeTurnOmegaB: number;
  /** Connected to another line's id, or null. */
  connectedToId: string | null;
  /** Timestamp when this line was spawned (ms). */
  spawnTime: number;
  /** Set to true once the 2-second penalty window has passed. */
  penaltyApplied: boolean;
  /** Cached SVG path string — set once on connection, avoids re-generating every frame. */
  cachedSvgPath: string | null;
  /** Cached wiggled SVG path string — rebuilt only when points change. */
  cachedWiggleSvg: string | null;
  /** Frame count when the wiggle cache was last rebuilt. */
  cachedWiggleFrame: number;
  /** Number of path points when the wiggle cache was last built. */
  cachedWiggleLen: number;
  /** LOD stride used for the wiggle cache (1 = full detail). */
  cachedWiggleStride: number;
  /** Wiggle animation variant (0, 1, or 2) — assigned randomly at spawn. */
  wiggleVariant: number;
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
  /** Grid cells (packed numeric keys) covered by squiggly lines around this dot. */
  coveredCells: Set<number>;
  /** True when new cells have been added since last coverage check. */
  coverageDirty: boolean;
  /** Individual SVG path strings for connected lines — joined on demand. */
  connectedPaths: string[];
  /** Combined SVG path string for ALL connected lines — one <Path> instead of N. */
  cachedConnectedSvg: string;
  /** True when connectedPaths changed and cachedConnectedSvg needs rebuild. */
  connectedSvgDirty: boolean;
  /** Cached fleck SVG path string. */
  cachedFleckSvg: string;
  /** Cached fleck opacity. */
  cachedFleckOpacity: number;
  /** Frame count when fleck cache was last computed. */
  cachedFleckFrame: number;
  /** The radius the dot is growing toward (may differ from radius during animation). */
  targetRadius: number;
  /** Timestamp (ms) when the current growth animation started, or 0 if idle. */
  growStartTime: number;
  /** Radius at the moment growth was triggered (for lerp). */
  growStartRadius: number;
  /** Deferred spawn batches: lines to create at a future timestamp. */
  pendingBatches: Array<{ count: number; spawnAt: number }>;
  /** Count of unconnected lines — maintained incrementally to avoid filter() each frame. */
  unconnectedCount: number;
  /** Active unconnected line ids for this dot (hot-path iteration). */
  activeLineIds: string[];
  /** Cells belonging to the next growth ring around this dot. */
  growthRingCells: Set<number>;
  /** Number of growth-ring cells currently covered. */
  growthRingCovered: number;
  /** Pre-allocated buffer for dot circle rendering (avoids per-frame allocation). */
  _dotBuf: Float64Array;
  /** Temporary flash indicator: 'reward' (connected in time) or 'penalty' (missed). */
  flash: { type: 'reward' | 'penalty'; startTime: number } | null;
  /** Connection pulse flashes — bright flash along connected paths. */
  connectionFlashes: Array<{ svgPath: string; startTime: number }>;
  /** Timestamp of last spawn pulse (for dot scale bump animation). */
  lastSpawnPulseTime: number;
  /** Current combo streak on this dot (reset on penalty). */
  combo: number;
  /** Best combo achieved on this dot during this game. */
  bestCombo: number;
}

export interface GameState {
  status: 'playing' | 'gameOver';
  startTime: number;
  /** Survival time in seconds (updated every frame). */
  survivalTime: number;
  dots: DotState[];
  /** Map of touch identifier → line id for simultaneous drags. */
  draggingMap: Map<string, string>;
  /** rAF timestamp from the last game-loop tick (seconds). Used by renderer. */
  loopTimeSec: number;
  /** Total number of line-pairs successfully connected so far. */
  totalConnected: number;
  /** Fast O(1) lookup from line id → SquigglyLine. */
  lineMap: Map<string, SquigglyLine>;
  /** Frame counter — used for render throttling. */
  frameCount: number;
  /** Longest combo streak across all dots this game. */
  longestCombo: number;
  /** Closest a line head has been to an edge (px) this game. */
  closestEdgeCall: number;
  /** Sum of connection times (ms) for averaging. */
  totalConnectionTime: number;
  /** Number of successful connections. */
  connectionCount: number;
  /** Map of lineId → timestamp when drag started (for expanding head). */
  dragStartTime: Map<string, number>;
}

// ─── Tunable constants ───────────────────────────────────────────────────────

/** Initial spawn interval minimum (ms). */
export const SPAWN_INTERVAL_MIN = 3000;
/** Initial spawn interval maximum (ms). */
export const SPAWN_INTERVAL_MAX = 8000;
/** Hard floor for spawn interval (ms). */
export const MIN_SPAWN_INTERVAL = 1500;
/** How much the spawn interval shrinks after a missed connection (ms). */
export const SPAWN_INTERVAL_DECREASE = 500;
/** How long the player has to connect before a speed penalty applies (ms). */
export const CONNECT_PENALTY_WINDOW = 800;
/** If connected within this window, spawn interval is slowed down (ms). */
export const CONNECT_REWARD_WINDOW = 800;
/** How much the spawn interval grows after a quick connection (ms). */
export const SPAWN_INTERVAL_INCREASE = 500;
/** After this many ms, an unconnected line escapes its explore zone (ms). */
export const ESCAPE_TIME = 5000;
/** Max unconnected lines per dot. */
export const MAX_UNCONNECTED_PER_DOT = 12;
/** Duration of dot growth animation (ms). */
export const DOT_GROW_DURATION = 3000;
/** Spawn interval speedup (ms) when this dot is larger than the other. */
export const LARGER_DOT_SPAWN_BOOST = 500;

/** Head movement speed in px/s. */
export const LINE_SPEED = 35;
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

/** Explore radius = this multiplier × dot.radius. */
export const EXPLORE_RADIUS_MULT = 12;
/** Strength of the return-to-dot steering force. */
export const RETURN_FORCE = 3.0;
/** Grid cell size (px) for tracking area coverage around each dot. */
export const CELL_SIZE = 6;
/** Spatial-hash cell size (px) for active line-head lookups. */
export const HEAD_GRID_CELL_SIZE = 48;
/** Fraction of ring cells that must be covered for the dot to grow. */
export const COVERAGE_THRESHOLD = 0.8;

// ─── Derived constants (avoid repeated work in hot paths) ────────────────────

export const POINT_SAMPLE_DISTANCE_SQ = POINT_SAMPLE_DISTANCE * POINT_SAMPLE_DISTANCE;
export const HIT_RADIUS_SQ = HIT_RADIUS * HIT_RADIUS;
export const SNAP_RADIUS_SQ = SNAP_RADIUS * SNAP_RADIUS;
export const INV_CELL_SIZE = 1 / CELL_SIZE;
export const INV_HEAD_GRID_CELL_SIZE = 1 / HEAD_GRID_CELL_SIZE;

/** Pack cell indices into a single number for Set<number> lookups. */
export function packCell(cx: number, cy: number): number {
  return cx * 100000 + cy;
}

// ─── Factory helpers ─────────────────────────────────────────────────────────

let _lineCounter = Date.now();
const _linePool: SquigglyLine[] = [];

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function createLine(
  dotId: string,
  dotX: number,
  dotY: number,
  now: number,
): SquigglyLine {
  _lineCounter += 1;
  const line = _linePool.pop();
  const direction = Math.random() * Math.PI * 2;
  if (line) {
    line.id = `line-${_lineCounter}`;
    line.numericId = _lineCounter;
    line.dotId = dotId;
    line.partnerId = null;
    line.pathPoints.length = 0;
    line.pathPoints.push({ x: dotX, y: dotY }, { x: dotX, y: dotY });
    line.direction = direction;
    line.wanderPhase = Math.random() * Math.PI * 2;
    line.wanderOmega = randomRange(1.2, 2.4);
    line.escapeTurnPhase = Math.random() * Math.PI * 2;
    line.escapeTurnOmegaA = randomRange(0.8, 1.8);
    line.escapeTurnOmegaB = randomRange(0.5, 1.2);
    line.connectedToId = null;
    line.spawnTime = now;
    line.penaltyApplied = false;
    line.cachedSvgPath = null;
    line.cachedWiggleSvg = null;
    line.cachedWiggleFrame = -1;
    line.cachedWiggleLen = 0;
    line.cachedWiggleStride = 1;
    line.wiggleVariant = (Math.random() * 3) | 0;
    return line;
  }

  return {
    id: `line-${_lineCounter}`,
    numericId: _lineCounter,
    dotId,
    partnerId: null,
    // Two points: fixed anchor at dot + live head (same position initially)
    pathPoints: [{ x: dotX, y: dotY }, { x: dotX, y: dotY }],
    direction,
    wanderPhase: Math.random() * Math.PI * 2,
    wanderOmega: randomRange(1.2, 2.4),
    escapeTurnPhase: Math.random() * Math.PI * 2,
    escapeTurnOmegaA: randomRange(0.8, 1.8),
    escapeTurnOmegaB: randomRange(0.5, 1.2),
    connectedToId: null,
    spawnTime: now,
    penaltyApplied: false,
    cachedSvgPath: null,
    cachedWiggleSvg: null,
    cachedWiggleFrame: -1,
    cachedWiggleLen: 0,
    cachedWiggleStride: 1,
    wiggleVariant: (Math.random() * 3) | 0,
  };
}

export function recycleLine(line: SquigglyLine): void {
  line.connectedToId = null;
  line.partnerId = null;
  line.cachedSvgPath = null;
  line.cachedWiggleSvg = null;
  line.cachedWiggleFrame = -1;
  line.cachedWiggleLen = 0;
  line.cachedWiggleStride = 1;
  line.pathPoints.length = 0;
  _linePool.push(line);
}

export function createInitialState(width: number, height: number): GameState {
  const centerY = height / 2;
  const leftX = width * 0.35;
  const rightX = width * 0.65;
  const now = Date.now();

  const makeInterval = () =>
    SPAWN_INTERVAL_MIN + Math.random() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);

  return {
    status: 'playing',
    startTime: now,
    survivalTime: 0,
    draggingMap: new Map(),
    loopTimeSec: 0,
    totalConnected: 0,
    lineMap: new Map(),
    frameCount: 0,
    dots: [
      {
        id: 'dot-left',
        x: leftX,
        y: centerY,
        radius: INITIAL_DOT_RADIUS,
        spawnInterval: makeInterval(),
        lastSpawnTime: 0,
        lines: [],
        connectedPathLength: 0,
        coveredCells: new Set<number>(),
        coverageDirty: false,
        connectedPaths: [],
        cachedConnectedSvg: '',
        connectedSvgDirty: false,
        cachedFleckSvg: '',
        cachedFleckOpacity: 0,
        cachedFleckFrame: -1,
        targetRadius: INITIAL_DOT_RADIUS,
        growStartTime: 0,
        growStartRadius: INITIAL_DOT_RADIUS,
        pendingBatches: [],
        unconnectedCount: 0,
        activeLineIds: [],
        growthRingCells: new Set<number>(),
        growthRingCovered: 0,
        _dotBuf: new Float64Array(72),
        flash: null,
        connectionFlashes: [],
        lastSpawnPulseTime: 0,
        combo: 0,
        bestCombo: 0,
      },
      {
        id: 'dot-right',
        x: rightX,
        y: centerY,
        radius: INITIAL_DOT_RADIUS,
        spawnInterval: makeInterval(),
        lastSpawnTime: 0,
        lines: [],
        connectedPathLength: 0,
        coveredCells: new Set<number>(),
        coverageDirty: false,
        connectedPaths: [],
        cachedConnectedSvg: '',
        connectedSvgDirty: false,
        cachedFleckSvg: '',
        cachedFleckOpacity: 0,
        cachedFleckFrame: -1,
        targetRadius: INITIAL_DOT_RADIUS,
        growStartTime: 0,
        growStartRadius: INITIAL_DOT_RADIUS,
        pendingBatches: [],
        unconnectedCount: 0,
        activeLineIds: [],
        growthRingCells: new Set<number>(),
        growthRingCovered: 0,
        _dotBuf: new Float64Array(72),
        flash: null,
        connectionFlashes: [],
        lastSpawnPulseTime: 0,
        combo: 0,
        bestCombo: 0,
      },
    ],
    longestCombo: 0,
    closestEdgeCall: Infinity,
    totalConnectionTime: 0,
    connectionCount: 0,
    dragStartTime: new Map(),
  };
}
