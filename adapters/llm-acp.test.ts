import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMsg, parseChat, anthropicMsg, parseAnthropic, responsesItems, parseResponses, type Msg } from "./llm-acp.ts";

const history: Msg[] = [
  { role: "user", content: "look" },
  { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "look_around", args: { radius: 8 } }] },
  { role: "tool", toolCallId: "c1", name: "look_around", content: "grass, a cow" },
];

test("chat wire: assistant tool_calls and tool role serialise, response parses text + tool calls", () => {
  const a = chatMsg(history[1]!) as any;
  assert.equal(a.role, "assistant"); assert.equal(a.tool_calls[0].function.name, "look_around");
  assert.equal(JSON.parse(a.tool_calls[0].function.arguments).radius, 8);
  assert.deepEqual(chatMsg(history[2]!), { role: "tool", tool_call_id: "c1", content: "grass, a cow" });
  const r = parseChat({ choices: [{ message: { content: "hi", tool_calls: [{ id: "x", function: { name: "mine", arguments: '{"n":2}' } }] } }], usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 100 } } });
  assert.equal(r.text, "hi"); assert.equal(r.toolCalls[0]!.name, "mine"); assert.equal(r.toolCalls[0]!.args.n, 2);
  assert.deepEqual(r.usage, { input: 500, cached: 100 });
});

test("anthropic wire: tool_use / tool_result blocks and response parse", () => {
  const a = anthropicMsg(history[1]!) as any;
  assert.equal(a.content.find((c: any) => c.type === "tool_use").name, "look_around");
  const t = anthropicMsg(history[2]!) as any;
  assert.equal(t.role, "user"); assert.equal(t.content[0].type, "tool_result"); assert.equal(t.content[0].tool_use_id, "c1");
  const r = parseAnthropic({ content: [{ type: "text", text: "yo" }, { type: "tool_use", id: "u1", name: "eat", input: { item: "bread" } }], usage: { input_tokens: 700, cache_read_input_tokens: 200 } });
  assert.equal(r.text, "yo"); assert.equal(r.toolCalls[0]!.name, "eat"); assert.equal(r.toolCalls[0]!.args.item, "bread");
  assert.deepEqual(r.usage, { input: 700, cached: 200 });
});

test("responses wire: function_call / function_call_output items and response parse", () => {
  const items = responsesItems(history[1]!) as any[];
  assert.ok(items.some((i) => i.type === "function_call" && i.name === "look_around"));
  const out = responsesItems(history[2]!) as any[];
  assert.equal(out[0].type, "function_call_output"); assert.equal(out[0].call_id, "c1");
  const r = parseResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }, { type: "function_call", call_id: "c2", name: "craft", arguments: '{"item":"stick"}' }], usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 400 } } });
  assert.equal(r.text, "done"); assert.equal(r.toolCalls[0]!.name, "craft"); assert.equal(r.toolCalls[0]!.args.item, "stick");
  assert.deepEqual(r.usage, { input: 900, cached: 400 });
});
