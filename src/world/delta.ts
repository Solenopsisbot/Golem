// Inventory deltas for the observation line after a run: what a snippet gained and lost.
export function countItems(items: { item: string; count: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const id = it.item.replace("minecraft:", "").replace(/\s+x\d+$/, "");
    if (!id || id === "empty" || id === "air") continue;
    out[id] = (out[id] ?? 0) + it.count;
  }
  return out;
}

/** "+6 melon_slice, -1 bone_meal", largest changes first, at most eight; empty string when nothing changed. */
export function inventoryDelta(before: Record<string, number>, after: Record<string, number>): string {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: [string, number][] = [];
  for (const id of ids) { const d = (after[id] ?? 0) - (before[id] ?? 0); if (d) changes.push([id, d]); }
  changes.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const shown = changes.slice(0, 8).map(([id, d]) => `${d > 0 ? "+" : ""}${d} ${id}`);
  return shown.join(", ") + (changes.length > 8 ? `, +${changes.length - 8} more` : "");
}
