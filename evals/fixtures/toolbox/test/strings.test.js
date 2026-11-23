import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalize } from "../src/strings.js";

test("capitalize pone en mayúscula la primera letra", () => {
  assert.equal(capitalize("hola"), "Hola");
  assert.equal(capitalize(""), "");
});
