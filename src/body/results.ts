// Hand-written result shapes for the Clef commands Golem relies on. The generated schema types the
// ARGS of every command (src/body/schema.gen.ts); Clef's schema doesn't type results, so these are
// transcribed from CoreCommands/ActionCommands/UiCommands. Optional fields marked "(#N)" are the
// additions requested in docs/CLEF-CHANGES.md and are absent until the body ships them.

export interface StatusPlayer {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  health: number; food: number;
  xpLevel: number; xpProgress: number;
  onGround: boolean; usingItem: boolean;
  selectedSlot: number;
  heldItem: string;
  dimension: string;
  // (#5) richer status
  gamemode?: string;
  time?: number; day?: number; phase?: "dawn" | "day" | "dusk" | "night";
  weather?: "clear" | "rain" | "thunder";
  biome?: string;
  light?: { block: number; sky: number };
  inWater?: boolean; inLava?: boolean; onFire?: boolean; sleeping?: boolean; sneaking?: boolean; sprinting?: boolean;
  fallDistance?: number; air?: number;
  maxHealth?: number; absorption?: number; saturation?: number; armorPoints?: number;
  effects?: { id: string; amplifier: number; ticks: number }[];
  armor?: string[]; offhand?: string;
}

export interface StatusResult {
  headless: boolean; noGl: boolean; noWindow: boolean;
  skippedFrames: number; controllers: number; singleplayer: boolean;
  screen: string; overlay: string;
  screenClass?: string;                        // (#17) raw class name; `screen` is the readable one
  /** (#5) `time` is a tick count on older bodies and `{timeOfDay, day, phase}` on protocol 2. */
  world?: { time?: number | { timeOfDay: number; day?: number; phase?: string }; day?: number; phase?: "dawn" | "day" | "dusk" | "night"; weather?: "clear" | "rain" | "thunder"; biome?: string; light?: { block: number; sky: number } };
  server?: string;
  inWorld: boolean;
  player?: StatusPlayer;
  navBackend: string; navActive: boolean;
  screenshotBackend: string;
}

export interface InventoryItem { slot: number; item: string; name: string; count: number }
export interface InventoryResult { selectedSlot: number; items: InventoryItem[] }

export interface EntityResult {
  id: number; type: string; name: string;
  x: number; y: number; z: number; distance: number;
  // (#4) richer entities
  health?: number; maxHealth?: number; hostile?: boolean; baby?: boolean;
  held?: string; armor?: string[]; onFire?: boolean;
  villager?: { profession: string; level: number };
  item?: { id: string; count: number };
  owner?: string; lookingAtMe?: boolean;
  velocity?: { x: number; y: number; z: number };
}

export interface BlockAtResult { block: string; air: boolean }
export interface FindBlocksHit { x: number; y: number; z: number; block: string }     // (#1)
export interface PlayerEntry { name: string; id: string; ping: number }
export interface NavStatusResult { available: boolean; backend: string; active: boolean }
export interface GotoResult { pathing: boolean; backend: string }
export interface FindItemResult { total: number; slots: { slot: number; count: number }[] }
export interface ContainerSlot { slot: number; item: string; count: number }
export interface ContainerTrade {
  index: number; buyA: string; buyB: string; sell: string; disabled: boolean; uses: number; maxUses: number;
}
export interface ContainerResult {
  handler: string; syncId: number; screen: string;
  slots: ContainerSlot[]; cursor: string; trades?: ContainerTrade[];
}
export interface ScreenshotResult {
  format: "png"; backend: string; bytes: number; width?: number; height?: number;
  durationMs?: number; base64: string;
}
export interface SchemaCommand { name: string; description?: string; args?: { name: string; type: string; required?: boolean }[] }
export interface SchemaResult { protocol: number; server: string; commands: SchemaCommand[]; events: { name: string }[] }
export interface CraftResult { crafted: number; item: string }          // (#2)
export interface RecipeResult {                                         // (#2)
  result: string; count: number; ingredients: { item?: string; tag?: string; count: number }[]; needsTable: boolean;
}

export interface MineResult { mining?: boolean; broken?: boolean; reason?: string; detail?: string; ticks?: number }   // protocol 2 with wait:true
export interface PlaceResult { placed: boolean; block?: string }                                                  // protocol 2 with confirm:true
export interface LookAtResult { yaw: number; pitch: number }
export interface TargetResult { kind: "block" | "entity" | "none"; x?: number; y?: number; z?: number; block?: string; entityId?: number; face?: string; distance?: number }
export interface NavCheckResult { reachable: boolean; cost?: number; reason?: string }
export interface CraftableEntry { item: string; count: number }
export interface MoveToHotbarResult { slot: number }
export interface ChatHistoryEntry { text: string; sender?: string; kind: string; t?: number }
