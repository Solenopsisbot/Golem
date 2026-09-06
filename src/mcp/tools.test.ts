import { test } from "node:test";
import assert from "node:assert/strict";
import { saveScriptPath } from "./tools.ts";

test("save paths stay under shem/ and off the standard library", () => {
  assert.equal(saveScriptPath("shem/harvest.shem"), "shem/harvest.shem");
  assert.equal(saveScriptPath("./shem/farm/melons.shem"), "shem/farm/melons.shem");
  for (const bad of ["harvest.shem", "shem/lib/x.shem", "shem/../x.shem", "shem/x.txt", "/etc/passwd"]) assert.throws(() => saveScriptPath(bad), new RegExp("save must be"));
});

