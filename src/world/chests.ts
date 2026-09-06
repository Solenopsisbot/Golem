// The chest index: every container a bot opens, with its contents, so "where did I put the iron"
// is a file read instead of a search. Each agent keeps its own copy (workspace/world/chests.json);
// when the fleet shares world knowledge there is also one index for everyone
// (data/shared/world/chests.json plus a readable chests.md), stamped with who last looked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ContainerSlot } from "../body/results.ts";
import type { Pos } from "../util/geom.ts";

export interface ChestRecord {
  x: number; y: number; z: number; dimension: string; handler: string;
  /** Block id without the namespace (chest, barrel, furnace...), when the opener knew it. */
  kind?: string;
  items: Record<string, number>;   // item id -> total count
  seenAt: number;
  /** Which agent last opened it (shared index only). */
  seenBy?: string;
}

/** What recordChest needs to know about the agent: its private world dir and, optionally, the fleet's. */
export interface ChestIndexOwner { name: string; workspaceDir: string; sharedWorldDir?: string | undefined }

export function chestIndexPath(workspaceDir: string): string { return resolve(workspaceDir, "world", "chests.json"); }

function loadIndex(p: string): Record<string, ChestRecord> {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function loadChests(workspaceDir: string): Record<string, ChestRecord> { return loadIndex(chestIndexPath(workspaceDir)); }

/** Private and shared records merged; the more recently seen copy of a container wins. */
export function loadAllChests(owner: ChestIndexOwner): Record<string, ChestRecord> {
  const all = loadChests(owner.workspaceDir);
  if (owner.sharedWorldDir) {
    for (const [k, v] of Object.entries(loadIndex(resolve(owner.sharedWorldDir, "chests.json")))) {
      if (!all[k] || all[k]!.seenAt < v.seenAt) all[k] = v;
    }
  }
  return all;
}

function itemsOf(slots: ContainerSlot[], containerSize?: number): Record<string, number> {
  const items: Record<string, number> = {};
  // Only the container's own slots (the trailing 36 are the player's inventory).
  const own = containerSize !== undefined ? slots.filter((s) => s.slot < containerSize) : slots.slice(0, Math.max(0, slots.length - 36));
  for (const s of own) {
    const id = s.item.replace(/\s+x\d+$/, "");   // Clef renders "minecraft:coal x7"
    if (!id || id === "empty" || id === "minecraft:air") continue;
    items[id] = (items[id] ?? 0) + s.count;
  }
  return items;
}

function save(p: string, all: Record<string, ChestRecord>): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(all, null, 1));
}

export function recordChest(owner: ChestIndexOwner, pos: Pos, dimension: string, handler: string, slots: ContainerSlot[], opts: { kind?: string; containerSize?: number } = {}): ChestRecord {
  const key = `${pos.x},${pos.y},${pos.z},${dimension}`;
  const rec: ChestRecord = { x: pos.x, y: pos.y, z: pos.z, dimension, handler, kind: opts.kind, items: itemsOf(slots, opts.containerSize), seenAt: Date.now() };
  const mine = loadChests(owner.workspaceDir);
  mine[key] = rec;
  save(chestIndexPath(owner.workspaceDir), mine);
  if (owner.sharedWorldDir) {
    const p = resolve(owner.sharedWorldDir, "chests.json");
    const shared = loadIndex(p);
    shared[key] = { ...rec, seenBy: owner.name };
    save(p, shared);
    writeFileSync(resolve(owner.sharedWorldDir, "chests.md"), renderChests(shared));
  }
  return rec;
}

export function chestsWith(owner: ChestIndexOwner, item: string): ChestRecord[] {
  const id = item.includes(":") ? item : `minecraft:${item}`;
  return Object.values(loadAllChests(owner)).filter((c) => (c.items[id] ?? 0) > 0);
}

/** The shared index as the minds read it: one line per container, grouped by dimension, fullest first. */
export function renderChests(all: Record<string, ChestRecord>): string {
  const byDim = new Map<string, ChestRecord[]>();
  for (const c of Object.values(all)) { const d = c.dimension.replace("minecraft:", ""); if (!byDim.has(d)) byDim.set(d, []); byDim.get(d)!.push(c); }
  const out = ["# Containers this fleet has opened", "", "Written by Golem whenever any golem opens a container. Position, kind, contents, who last looked and when. Not editable: open the container to refresh its line.", ""];
  for (const [dim, list] of [...byDim.entries()].sort()) {
    out.push(`## ${dim}`, "");
    list.sort((a, b) => Object.keys(b.items).length - Object.keys(a.items).length || a.seenAt - b.seenAt);
    for (const c of list) {
      const items = Object.entries(c.items).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id.replace("minecraft:", "")} ${n}`).join(", ") || "empty";
      const when = new Date(c.seenAt).toISOString().slice(0, 16).replace("T", " ");
      out.push(`- (${c.x}, ${c.y}, ${c.z}) ${c.kind ?? "container"}: ${items}  (${c.seenBy ?? "?"}, ${when} UTC)`);
    }
    out.push("");
  }
  if (byDim.size === 0) out.push("Nothing opened yet.", "");
  return out.join("\n");
}
