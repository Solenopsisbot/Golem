// The state mirror: Golem's continuously-updated picture of the bot, fed by body events (tick,
// health, damage, death, screenOpen, entitySpawn, ...) and a 1 Hz `status` poll for the things
// events don't carry (nav state, open screen, held item). Primitives and reflexes read this instead
// of round-tripping for every check; anything that must be exact (inventory, entity positions)
// still calls the body directly.
import type { BodyClient } from "./client.ts";
import type { StatusResult } from "./results.ts";
import { EYE_HEIGHT, floorPos, type Pos, type Vec } from "../util/geom.ts";
import { makeLog, type Logger } from "../util/log.ts";

export interface EntitySeen { id: number; type: string; x: number; y: number; z: number; seenAt: number }

export class Mirror {
  connected = false;
  inWorld = false;
  dead = false;
  pos: Vec = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  health = 20;
  food = 20;
  dimension = "minecraft:overworld";
  /** Open screen class name, or null when none. */
  screen: string | null = null;
  navActive = false;
  heldItem = "empty";
  selectedSlot = 0;
  readonly players = new Set<string>();
  /** Entities announced by entitySpawn (within 24 blocks); positions are stale, ids are not. */
  readonly entities = new Map<number, EntitySeen>();
  status: StatusResult | undefined;

  lastTickAt = 0;
  lastStatusAt = 0;
  lastRespawnAt = 0;
  lastDamageAt = 0;
  lastMoveAt = Date.now();
  /** Set by nav.done / nav.failed events when the body has them (CLEF-CHANGES #7). */
  navEvent: { kind: "done" | "failed"; at: number; reason?: string } | null = null;
  /** Last mineDone event (protocol 2). */
  mineDone: { x: number; y: number; z: number; broken: boolean; reason?: string; at: number } | null = null;
  /** Who hit us last (entityHurt with self:true). */
  lastAttacker: { id: number; type: string; at: number } | null = null;
  /** What hurt us last, as the vanilla damage type ("hot_floor", "in_fire", "lava", "in_wall", "fall", "mob_attack", ...). */
  lastDamageSource: { source: string; at: number } | null = null;
  /** Where the body last stood out of water and lava: the drowning escape goes back there. */
  lastDryPos: { x: number; y: number; z: number } | null = null;
  lastPickup: { item: string; count: number; at: number } | null = null;
  lastSleep: { ok: boolean; reason?: string; at: number } | null = null;
  phase: "dawn" | "day" | "dusk" | "night" | undefined;
  day: number | undefined;
  weather: "clear" | "rain" | "thunder" | undefined;
  /** Set when the body says inventory slots changed; cleared by whoever refreshes. */
  inventoryDirty = true;
  getMineDone(): Mirror["mineDone"] { return this.mineDone; }

  /** Read through a method so TypeScript doesn't narrow the field to null across awaits. */
  getNavEvent(): { kind: "done" | "failed"; at: number; reason?: string } | null { return this.navEvent; }

  private readonly damage: { t: number; amount: number }[] = [];
  private readonly listeners = new Set<(what: string) => void>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight = false;
  private readonly body: BodyClient;
  private readonly log: Logger;

  constructor(body: BodyClient, log?: Logger) {
    this.body = body;
    this.log = log ?? makeLog("mirror");
  }

  get eye(): Vec { return { x: this.pos.x, y: this.pos.y + EYE_HEIGHT, z: this.pos.z }; }
  get blockPos(): Pos { return floorPos(this.pos); }

  /** Damage taken in the last `ms` milliseconds. */
  /** The damage type seen in the last `ms`, or null: lets reflexes tell a magma block from a skeleton. */
  damageSourceInLast(ms: number): string | null {
    const d = this.lastDamageSource;
    return d && Date.now() - d.at <= ms ? d.source : null;
  }
  damageInLast(ms: number): number {
    const cutoff = Date.now() - ms;
    return this.damage.filter((d) => d.t >= cutoff).reduce((a, d) => a + d.amount, 0);
  }
  movedRecently(ms: number): boolean { return Date.now() - this.lastMoveAt < ms; }

  onChange(cb: (what: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private changed(what: string): void {
    for (const l of this.listeners) { try { l(what); } catch (e) { this.log.error("listener threw", e); } }
  }

  private setPos(x: number, y: number, z: number): void {
    if (Math.abs(x - this.pos.x) > 0.05 || Math.abs(y - this.pos.y) > 0.05 || Math.abs(z - this.pos.z) > 0.05) {
      this.lastMoveAt = Date.now();
    }
    this.pos = { x, y, z };
  }

  /** Wire up event handlers. Call once. */
  attach(): void {
    const b = this.body;
    b.on("tick", (d) => {
      this.lastTickAt = Date.now();
      this.inWorld = true;
      this.setPos(d.x, d.y, d.z);
      this.yaw = d.yaw; this.pitch = d.pitch;
      this.health = d.health; this.food = d.food;
      if (typeof d.dimension === "string") this.dimension = d.dimension;
      this.changed("tick");
    });
    b.on("health", (d) => { this.health = d.health; this.food = d.food; this.changed("health"); });
    b.on("damage", (d) => {
      const now = Date.now();
      this.lastDamageAt = now;
      this.damage.push({ t: now, amount: d.amount });
      while (this.damage.length > 50) this.damage.shift();
      this.health = d.health;
      this.changed("damage");
    });
    b.on("death", () => { this.dead = true; this.changed("death"); });
    b.on("respawn", () => { this.dead = false; this.lastRespawnAt = Date.now(); this.changed("respawn"); });
    b.on("connected", () => { this.connected = true; this.changed("connected"); });
    b.on("disconnected", () => {
      this.connected = false; this.inWorld = false; this.navActive = false; this.screen = null;
      this.players.clear(); this.entities.clear();
      this.changed("disconnected");
    });
    b.on("join", (d) => { this.players.add(d.name); this.changed("join"); });
    b.on("leave", (d) => { this.players.delete(d.name); this.changed("leave"); });
    b.on("entitySpawn", (d) => { this.entities.set(d.id, { ...d, seenAt: Date.now() }); this.changed("entitySpawn"); });
    b.on("entityRemove", (d) => { this.entities.delete(d.id); this.changed("entityRemove"); });
    b.on("screenOpen", (d) => { this.screen = d.screen; this.changed("screenOpen"); });
    b.on("screenClose", () => { this.screen = null; this.changed("screenClose"); });
    b.on("nav.done", () => { this.navEvent = { kind: "done", at: Date.now() }; this.navActive = false; this.changed("nav"); });
    b.on("nav.failed", (d: { reason?: string }) => { this.navEvent = { kind: "failed", at: Date.now(), reason: d?.reason }; this.navActive = false; this.changed("nav"); });
    // Protocol-2 events (present when the body has them; harmless otherwise).
    b.on("mineDone", (d: { x: number; y: number; z: number; broken: boolean; reason?: string }) => { this.mineDone = { ...d, at: Date.now() }; this.changed("mineDone"); });
    b.on("entityHurt", (d: { id: number; type: string; self: boolean; health: number; source?: string; attacker?: number; attackerType?: string }) => {
      if (d.self && typeof d.attacker === "number" && d.attacker >= 0) this.lastAttacker = { id: d.attacker, type: d.attackerType ?? "unknown", at: Date.now() };
      if (d.self && d.source) this.lastDamageSource = { source: d.source.replace(/^minecraft:/, ""), at: Date.now() };
      this.changed("entityHurt");
    });
    b.on("itemPickup", (d: { item: string; count: number }) => { this.lastPickup = { ...d, at: Date.now() }; this.inventoryDirty = true; this.changed("itemPickup"); });
    b.on("inventory", () => { this.inventoryDirty = true; });
    b.on("sleep", (d: { ok: boolean; reason?: string }) => { this.lastSleep = { ok: d.ok, reason: d.reason, at: Date.now() }; this.changed("sleep"); });
    b.on("time", (d: { phase: Mirror["phase"]; day: number }) => { this.phase = d.phase; this.day = d.day; this.changed("time"); });
    b.on("weather", (d: { kind: Mirror["weather"] }) => { this.weather = d.kind; this.changed("weather"); });
    b.on("_reconnected", () => { void this.refresh().catch(() => {}); });
  }

  /** Pull a full `status` and merge it. Safe to call often; used at 1 Hz by startPolling(). */
  async refresh(): Promise<StatusResult> {
    const s = (await this.body.call("status")) as StatusResult;
    this.status = s;
    this.lastStatusAt = Date.now();
    this.inWorld = s.inWorld;
    this.navActive = s.navActive;
    this.screen = s.screen && s.screen !== "none" ? s.screen : null;
    if (s.player) {
      const p = s.player;
      this.setPos(p.x, p.y, p.z);
      this.yaw = p.yaw; this.pitch = p.pitch;
      this.health = p.health; this.food = p.food;
      if (!p.inWater && !p.inLava && this.inWorld && !this.dead) this.lastDryPos = { x: this.blockPos.x, y: this.blockPos.y, z: this.blockPos.z };
      this.dimension = p.dimension;
      this.heldItem = p.heldItem;
      this.selectedSlot = p.selectedSlot;
      if (p.phase) this.phase = p.phase;
      if (p.weather) this.weather = p.weather;
      if (typeof p.day === "number") this.day = p.day;
      if (p.health <= 0) this.dead = true;
      else if (this.dead && p.health > 0) this.dead = false;
    }
    if (s.world) {
      // Protocol 2 nests the clock as world.time = {timeOfDay, day, phase}; older bodies put day/phase beside it.
      const t = typeof s.world.time === "object" && s.world.time ? s.world.time : undefined;
      const phase = s.world.phase ?? t?.phase;
      if (phase === "dawn" || phase === "day" || phase === "dusk" || phase === "night") this.phase = phase;
      if (s.world.weather) this.weather = s.world.weather;
      const day = s.world.day ?? t?.day;
      if (typeof day === "number") this.day = day;
    }
    this.changed("status");
    return s;
  }

  startPolling(intervalMs = 1000): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      // Never queue polls behind a stuck one: if the body's main thread is wedged, one pending
      // status call is all the evidence we need, and a backlog only delays recovery.
      if (!this.body.open || this.pollInFlight) return;
      this.pollInFlight = true;
      this.refresh()
        .catch((e) => this.log.debug(`status poll failed: ${(e as Error).message}`))
        .finally(() => { this.pollInFlight = false; });
    }, intervalMs);
  }
  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** One-line human summary, used by the shell and the prompt state header. */
  summary(name = "bot"): string {
    const p = this.pos;
    const where = `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) ${this.dimension.replace("minecraft:", "")}`;
    const vitals = `hp ${this.health.toFixed(0)}/20 food ${this.food}`;
    const extras = [
      this.phase ? `${this.phase}${this.weather && this.weather !== "clear" ? "/" + this.weather : ""}` : "",
      this.dead ? "DEAD" : "",
      this.navActive ? "pathing" : "",
      this.screen ? `screen:${this.screen}` : "",
      `held:${this.heldItem.replace("minecraft:", "")}`,
    ].filter(Boolean).join(" ");
    return `${name} | ${this.inWorld ? where : "not in world"} | ${vitals} | ${extras}`;
  }
}
