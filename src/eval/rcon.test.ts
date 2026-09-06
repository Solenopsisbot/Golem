import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Rcon } from "./rcon.ts";

/** A fake RCON server: authenticates "pw", echoes commands back as "ok: <cmd>". */
function fakeServer(): Promise<{ port: number; close: () => void; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readInt32LE(0);
          if (buf.length < 4 + len) return;
          const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
          const body = buf.subarray(12, 4 + len - 2).toString("utf8");
          buf = buf.subarray(4 + len);
          const reply = (rid: number, rtype: number, text: string) => {
            const p = Buffer.from(text, "utf8");
            const pkt = Buffer.alloc(14 + p.length);
            pkt.writeInt32LE(10 + p.length, 0); pkt.writeInt32LE(rid, 4); pkt.writeInt32LE(rtype, 8); p.copy(pkt, 12); pkt.writeInt16LE(0, 12 + p.length);
            sock.write(pkt);
          };
          if (type === 3) reply(body === "pw" ? id : -1, 2, "");
          else { seen.push(body); reply(id, 0, `ok: ${body}`); }
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close(), seen }));
  });
}

test("rcon: auth, command round trip, bad password", async () => {
  const s = await fakeServer();
  try {
    const r = new Rcon("127.0.0.1", s.port, "pw");
    await r.connect();
    assert.equal(await r.command("/time set day"), "ok: time set day");
    assert.equal(await r.command("give Clay minecraft:oak_log 4"), "ok: give Clay minecraft:oak_log 4");
    assert.deepEqual(s.seen, ["time set day", "give Clay minecraft:oak_log 4"]);
    r.close();
    const bad = new Rcon("127.0.0.1", s.port, "nope");
    await assert.rejects(bad.connect(), /auth failed/);
    bad.close();
  } finally { s.close(); }
});
