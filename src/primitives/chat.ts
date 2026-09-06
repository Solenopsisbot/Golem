// Speech, subject to policy: length cap, rate limit, slash-command allowlist.
import { type Ctx } from "./context.ts";
import { GolemError, fromClef } from "./errors.ts";

function clean(text: string, maxLen: number): string {
  const one = text.replace(/\s*\n+\s*/g, " ").trim();
  return one.length > maxLen ? one.slice(0, maxLen - 1) + "…" : one;
}

export async function say(ctx: Ctx, text: string): Promise<{ sent: string }> {
  const msg = clean(text, ctx.agent.chat.max_len);
  if (!msg) throw new GolemError("policy", "empty message");
  if (msg.startsWith("/")) {
    const cmd = msg.slice(1).split(/\s+/)[0]!.toLowerCase();
    if (!ctx.agent.etiquette.slash_commands.includes(cmd)) {
      throw new GolemError("policy", `/${cmd} is not in etiquette.slash_commands`);
    }
  }
  await ctx.chatLimiter.acquire(ctx.token);
  try { await ctx.body.call("chat", { message: msg }); }
  catch (e) { throw fromClef(e, "chat"); }
  ctx.trace.mark("say", { text: msg });
  return { sent: msg };
}

export async function whisper(ctx: Ctx, player: string, text: string): Promise<{ sent: string }> {
  if (ctx.body.caps.has("whisper")) {   // protocol 2: the body knows which command this server has
    const msg = clean(text, ctx.agent.chat.max_len);
    await ctx.chatLimiter.acquire(ctx.token);
    try { await ctx.body.call("whisper", { player, text: msg }); } catch (e) { throw fromClef(e, "whisper"); }
    ctx.trace.mark("whisper", { player, text: msg });
    return { sent: msg };
  }
  const cmd = ctx.agent.etiquette.slash_commands.find((c) => ["msg", "tell", "w"].includes(c));
  if (!cmd) throw new GolemError("policy", "no whisper command (msg/tell/w) allowed in etiquette.slash_commands");
  return say(ctx, `/${cmd} ${player} ${text}`);
}
