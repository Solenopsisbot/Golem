// Minimal Source RCON client (what Minecraft servers speak) so the eval runner can reset the world
// without giving the bot operator rights. Packet: int32 length, int32 id, int32 type, body, \0\0.
import { connect, type Socket } from "node:net";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_RESPONSE = 0;

export class Rcon {
  private sock: Socket | undefined;
  private id = 0;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; parts: string[]; timer: ReturnType<typeof setTimeout> }>();
  readonly host: string;
  readonly port: number;
  private readonly password: string;

  constructor(host: string, port: number, password: string) { this.host = host; this.port = port; this.password = password; }

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      this.sock = sock;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rcon connect timeout to ${this.host}:${this.port}`)); }, timeoutMs);
      sock.on("data", (d) => this.onData(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
      sock.on("error", (e) => { clearTimeout(timer); reject(e); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
      sock.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("rcon closed")); this.pending.clear(); });
      sock.once("connect", () => {
        clearTimeout(timer);
        this.send(TYPE_AUTH, this.password).then(() => resolve(), reject);
      });
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.subarray(12, 4 + len - 2).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      const p = this.pending.get(id) ?? (id === -1 ? [...this.pending.values()][0] : undefined);
      if (!p) continue;
      if (id === -1) { p.reject(new Error("rcon auth failed (bad password)")); this.pending.clear(); continue; }
      if (type === TYPE_RESPONSE || type === TYPE_EXEC) {
        p.parts.push(body);
        // Minecraft answers in one packet; settle on the next tick so multi-packet replies coalesce.
        clearTimeout(p.timer);
        p.timer = setTimeout(() => { this.pending.delete(id); p.resolve(p.parts.join("")); }, 30);
      }
    }
  }

  private send(type: number, body: string): Promise<string> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error("rcon not connected"));
    const id = ++this.id;
    const payload = Buffer.from(body, "utf8");
    const pkt = Buffer.alloc(14 + payload.length);
    pkt.writeInt32LE(10 + payload.length, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    payload.copy(pkt, 12);
    pkt.writeInt16LE(0, 12 + payload.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rcon timeout: ${body}`)); }, 10_000);
      this.pending.set(id, { resolve, reject, parts: [], timer });
      sock.write(pkt);
    });
  }

  /** Run a server command (no leading slash). Returns the server's reply text. */
  command(cmd: string): Promise<string> { return this.send(TYPE_EXEC, cmd.replace(/^\//, "")); }

  close(): void { this.sock?.destroy(); this.sock = undefined; }
}
