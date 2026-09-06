import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapSnippet } from "./engine.ts";

test("wrapSnippet wraps loose statements, keeps declarations, and hoists use imports", () => {
  assert.equal(wrapSnippet('goto((1,2,3))\nsay("hi")'), 'script main() {\n  goto((1,2,3))\n  say("hi")\n}\n');
  // the bug Codex hit: `use` the checker told it to add must land above a wrapped main, not inside it
  assert.equal(
    wrapSnippet('use "lib/wood"\nlet n = collect_any_wood(want: 4)\nreturn n'),
    'use "lib/wood"\nscript main() {\n  let n = collect_any_wood(want: 4)\n  return n\n}\n',
  );
  // a real script declaration is left alone (uses stay on top)
  assert.match(wrapSnippet('use "lib/craft"\nscript x() {\n  make_planks()\n}'), /^use "lib\/craft"\nscript x\(\)/);
});
