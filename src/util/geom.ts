// Block/world geometry helpers shared by primitives, reflexes and Shem.
//
// Minecraft conventions worth remembering (they bite):
//   - yaw 0 faces +Z (south), 90 faces -X (west), 180 faces -Z (north), -90/270 faces +X (east).
//   - pitch is positive looking DOWN, negative looking up.
//   - a player's eye is ~1.62 above their feet position (1.27 when sneaking).
//   - block (x,y,z) occupies [x,x+1) etc.; its centre is (x+0.5, y+0.5, z+0.5).

export interface Pos { x: number; y: number; z: number }   // integer block coordinates
export interface Vec { x: number; y: number; z: number }   // world coordinates (doubles)

export const EYE_HEIGHT = 1.62;

export type Face = "up" | "down" | "north" | "south" | "east" | "west";
export const FACES: readonly Face[] = ["up", "down", "north", "south", "east", "west"];
export const FACE_VEC: Record<Face, Pos> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};
export const OPPOSITE: Record<Face, Face> = {
  up: "down", down: "up", north: "south", south: "north", east: "west", west: "east",
};

export const pos = (x: number, y: number, z: number): Pos => ({ x, y, z });
export const floorPos = (v: Vec): Pos => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
export const center = (p: Pos): Vec => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const length = (a: Vec): number => Math.hypot(a.x, a.y, a.z);
export const norm = (a: Vec): Vec => { const l = length(a) || 1; return scale(a, 1 / l); };
export const offset = (p: Pos, face: Face, n = 1): Pos => {
  const d = FACE_VEC[face];
  return { x: p.x + d.x * n, y: p.y + d.y * n, z: p.z + d.z * n };
};
export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distXZ = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.z - b.z);
export const fmtPos = (p: Vec, digits = 0): string =>
  `(${p.x.toFixed(digits)}, ${p.y.toFixed(digits)}, ${p.z.toFixed(digits)})`;

/** Yaw/pitch (degrees, Minecraft convention) that points an eye at a target point. */
export function yawPitchTo(eye: Vec, target: Vec): { yaw: number; pitch: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  return { yaw, pitch };
}

/** The face of block `p` that most directly faces the viewer at `eye`. Used to pick which face to
 *  hit when mining so the server agrees the block is being looked at. */
export function faceToward(p: Pos, eye: Vec): Face {
  const d = sub(eye, center(p));
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (ay >= ax && ay >= az) return d.y > 0 ? "up" : "down";
  if (ax >= az) return d.x > 0 ? "east" : "west";
  return d.z > 0 ? "south" : "north";
}

/** Point `n` blocks away from `from`, in the direction away from `threat` (XZ only, same y). */
export function awayFrom(from: Vec, threat: Vec, n: number): Vec {
  let dx = from.x - threat.x, dz = from.z - threat.z;
  const l = Math.hypot(dx, dz);
  if (l < 0.01) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
  return { x: from.x + dx * n, y: from.y, z: from.z + dz * n };
}

/** Parses "x y z" / "x,y,z" / "(x, y, z)" into a Pos; returns undefined on garbage. */
export function parsePos(s: string): Pos | undefined {
  const m = s.replace(/[(),]/g, " ").trim().split(/\s+/).map(Number);
  if (m.length !== 3 || m.some((n) => !Number.isFinite(n))) return undefined;
  return { x: Math.floor(m[0]!), y: Math.floor(m[1]!), z: Math.floor(m[2]!) };
}
