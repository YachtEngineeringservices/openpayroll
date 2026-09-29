import { test } from "node:test";
import assert from "node:assert/strict";
import { D, Dec } from "../src/money.js";

test("parses decimal strings exactly", () => {
  assert.equal(D("0.1").add("0.2").eq("0.3"), true);
  assert.equal(D("$1,234.50").toMoney(), "1234.50");
  assert.equal(D("-7.005").round(2).toMoney(), "-7.01");
});

test("rounds half away from zero", () => {
  assert.equal(D("2.345").round(2).toMoney(), "2.35");
  assert.equal(D("2.344999").round(2).toMoney(), "2.34");
  assert.equal(D("958.3333333").round(2).toMoney(), "958.33");
  assert.equal(D("766.666666").round(2).toMoney(), "766.67");
});

test("refuses floats", () => {
  assert.throws(() => D(0.1), /fractional numbers must be passed as strings/);
  assert.equal(D(5).eq("5"), true);
});

test("exact rationals: 1/24 of 21000", () => {
  assert.equal(D("21000").div(24n).toMoney(), "875.00");
  assert.equal(Dec.cents(12345).toMoney(), "123.45");
});
