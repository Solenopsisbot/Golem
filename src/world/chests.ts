// The chest index: every container the bot opens, with its contents, so "where did I put the iron"
// is a file read (world/chests.json in the workspace) instead of a search.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ContainerSlot } from "../body/results.ts";
import type { Pos } from "../util/geom.ts";

export interface ChestRecord {
  x: number; y: number; z: number; dimension: string; handler: string;
  items: Record<string, number>;   // item id -> total count
  seenAt: number;
}

export function chestIndexPath(workspaceDir: string): string { return resolve(workspaceDir, "world", "chests.json"); }

export function loadChests(workspaceDir: string): Record<string, ChestRecord> {
  const p = chestIndexPath(workspaceDir);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function recordChest(workspaceDir: string, pos: Pos, dimension: string, handler: string, slots: ContainerSlot[], containerSize?: number): ChestRecord {
  const all = loadChests(workspaceDir);
  const key = `${pos.x},${pos.y},${pos.z},${dimension}`;
  const items: Record<string, number> = {};
  // Only the container's own slots (the trailing 36 are the player's inventory).
  const own = containerSize !== undefined ? slots.filter((s) => s.slot < containerSize) : slots.slice(0, Math.max(0, slots.length - 36));
  for (const s of own) {
    const id = s.item.replace(/\s+x\d+$/, "");   // Clef renders "minecraft:coal x7"
    if (!id || id === "empty" || id === "minecraft:air") continue;
    items[id] = (items[id] ?? 0) + s.count;
  }
  const rec: ChestRecord = { ...pos, dimension, handler, items, seenAt: Date.now() };
  all[key] = rec;
  const p = chestIndexPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(all, null, 1));
  return rec;
}

export function chestsWith(workspaceDir: string, item: string): ChestRecord[] {
  const id = item.includes(":") ? item : `minecraft:${item}`;
  return Object.values(loadChests(workspaceDir)).filter((c) => (c.items[id] ?? 0) > 0);
}
