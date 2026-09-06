import { test } from "node:test";
import assert from "node:assert/strict";
import { faceToward, parsePos, yawPitchTo, awayFrom } from "./geom.ts";

test("yawPitchTo follows Minecraft conventions", () => {
  const eye = { x: 0, y: 65.62, z: 0 };
  assert.equal(Math.abs(Math.round(yawPitchTo(eye, { x: 0, y: 65.62, z: 10 }).yaw)), 0);  // south (may be -0)
  assert.equal(Math.round(yawPitchTo(eye, { x: -10, y: 65.62, z: 0 }).yaw), 90);    // west
  assert.equal(Math.abs(Math.round(yawPitchTo(eye, { x: 0, y: 65.62, z: -10 }).yaw)), 180); // north
  assert.equal(Math.round(yawPitchTo(eye, { x: 10, y: 65.62, z: 0 }).yaw), -90);    // east
  assert.ok(yawPitchTo(eye, { x: 0, y: 55, z: 0.001 }).pitch > 80);                  // down is positive
  assert.ok(yawPitchTo(eye, { x: 0, y: 75, z: 0.001 }).pitch < -80);                 // up is negative
});

test("faceToward picks the face nearest the viewer", () => {
  assert.equal(faceToward({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 70, z: 0.5 }), "up");
  assert.equal(faceToward({ x: 0, y: 64, z: 0 }, { x: 5, y: 64.5, z: 0.5 }), "east");
  assert.equal(faceToward({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 64.5, z: -5 }), "north");
});

test("parsePos accepts the usual spellings", () => {
  assert.deepEqual(parsePos("1 2 3"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(parsePos("(1, 2, 3)"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(parsePos("-1.9,64,3"), { x: -2, y: 64, z: 3 });
  assert.equal(parsePos("1 2"), undefined);
});

test("awayFrom moves in the XZ plane away from the threat", () => {
  const p = awayFrom({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 5);
  assert.deepEqual({ x: Math.round(p.x), z: Math.round(p.z) }, { x: -5, z: 0 });
  assert.equal(p.y, 64);
});
