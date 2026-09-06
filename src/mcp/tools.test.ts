import { test } from "node:test";
import assert from "node:assert/strict";
import { saveScriptPath, wrapAsScript } from "./tools.ts";

test("save paths stay under shem/ and off the standard library", () => {
  assert.equal(saveScriptPath("shem/harvest.shem"), "shem/harvest.shem");
  assert.equal(saveScriptPath("./shem/farm/melons.shem"), "shem/farm/melons.shem");
  for (const bad of ["harvest.shem", "shem/lib/x.shem", "shem/../x.shem", "shem/x.txt", "/etc/passwd"]) assert.throws(() => saveScriptPath(bad), new RegExp("save must be"));
});

test("bare statements are wrapped as script main; declarations are kept", () => {
  assert.equal(wrapAsScript('goto((1,2,3))\nsay("hi")'), 'script main() {\n  goto((1,2,3))\n  say("hi")\n}\n');
  assert.equal(wrapAsScript("script dig(n: int) {\n  mine_down(n)\n}"), "script dig(n: int) {\n  mine_down(n)\n}\n");
  assert.match(wrapAsScript('use "lib/craft"\nscript x() {}'), /^use "lib\/craft"/);
});
