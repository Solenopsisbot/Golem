import { test } from "node:test";
import assert from "node:assert/strict";
import { Inbox, renderInbox } from "./inbox.ts";
import { parseFastCommand, routeChat, stripAddress } from "./chat.ts";
import type { AgentConfig } from "../config/schema.ts";

test("inbox folds overflow but keeps important items", () => {
  const box = new Inbox({ max: 5 });
  for (let i = 0; i < 8; i++) box.push({ kind: "chat", priority: 40, text: `line ${i}` });
  box.push({ kind: "death", priority: 95, text: "died" });
  assert.ok(box.size <= 6);
  const items = box.drain();
  assert.ok(items.some((i) => i.kind === "death"));
  assert.ok(items.some((i) => i.text.includes("folded")));
  assert.equal(box.size, 0);
  assert.equal(renderInbox([]), "[inbox] (empty)");
});

test("address stripping", () => {
  const pats = ["{name}", "@{name}", "hey {name}"];
  assert.equal(stripAddress("Clay, get wood", "Clay", pats), "get wood");
  assert.equal(stripAddress("@clay come here", "Clay", pats), "come here");
  assert.equal(stripAddress("hey Clay! status", "Clay", pats), "status");
  assert.equal(stripAddress("clayton is here", "Clay", pats), null);
  assert.equal(stripAddress("the weather is nice", "Clay", pats), null);
});

test("fast commands", () => {
  assert.deepEqual(parseFastCommand("met"), { name: "met" });
  assert.deepEqual(parseFastCommand("mode cowardice off"), { name: "reflex", reflex: "cowardice", on: false });
  assert.deepEqual(parseFastCommand("goal build a hut by the river"), { name: "goal", text: "build a hut by the river" });
  assert.deepEqual(parseFastCommand("goal clear"), { name: "goal_clear" });
  assert.equal(parseFastCommand("what do you see"), null);
});

const agent = {
  name: "Clay",
  body: { username: "Clay" },
  players: { owners: ["Viola"], trusted: ["Sam"], ignored: ["Spammer"] },
  chat: { listen: "addressed", address: ["{name}", "@{name}", "hey {name}"] },
} as unknown as AgentConfig;

test("chat routing", () => {
  assert.equal(routeChat(agent, { text: "hi", sender: "Clay", kind: "chat" }).action, "drop");
  assert.equal(routeChat(agent, { text: "Clay hi", sender: "Spammer", kind: "chat" }).action, "drop");
  assert.equal(routeChat(agent, { text: "nice day", sender: "Sam", kind: "chat" }).action, "drop");
  const r = routeChat(agent, { text: "Clay, come here", sender: "Sam", kind: "chat" });
  assert.equal(r.action, "inbox");
  const f = routeChat(agent, { text: "Clay met", sender: "Viola", kind: "chat" });
  assert.equal(f.action, "fast");
  const o = routeChat(agent, { text: "Clay what do you see", sender: "Viola", kind: "chat" });
  assert.equal(o.action, "inbox");
  if (o.action === "inbox") assert.equal(o.priority, 80);
  const all = routeChat({ ...agent, chat: { ...agent.chat, listen: "all" } } as AgentConfig, { text: "nice day", sender: "Sam", kind: "chat" });
  assert.equal(all.action, "inbox");
});
