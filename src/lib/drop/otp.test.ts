import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCode } from "./otp.ts";

test("a bare code is the whole text", () => {
  assert.equal(extractCode(" 482913\n"), "482913");
  assert.equal(extractCode("A7K2Q9"), "A7K2Q9");
  assert.equal(extractCode("1234"), "1234");
});

test("a bare word without digits, or too short/long, is not a code", () => {
  assert.equal(extractCode("hello"), null);
  assert.equal(extractCode("123"), null);
  assert.equal(extractCode("123456789"), null);
  assert.equal(extractCode("13800138000"), null);
});

test("finds the code in a short SMS", () => {
  assert.equal(extractCode("【某银行】您的验证码是 482913，5分钟内有效。"), "482913");
  assert.equal(extractCode("验证码：7731，请勿泄露"), "7731");
  assert.equal(extractCode("G-551203 is your Google verification code."), "551203");
  assert.equal(extractCode("Your OTP: 90X12B. Do not share."), "90X12B");
});

test("prefers the token after the keyword", () => {
  assert.equal(extractCode("Order 2026 code 8841"), "8841");
});

test("text without a keyword or a code token is not a code", () => {
  assert.equal(extractCode("Meet at 1530 near gate 12"), null);
  assert.equal(extractCode("the code is great"), null);
  assert.equal(extractCode(`code 1234 ${"x".repeat(200)}`), null);
});

test("keywords only count as whole words", () => {
  assert.equal(extractCode("shopping list: 2 eggs, 1234 Main St"), null);
  assert.equal(extractCode("scan the barcode 5012345"), null);
  assert.equal(extractCode("decode step 2048 done"), null);
  assert.equal(extractCode("PIN: 4821"), "4821");
  assert.equal(extractCode("code是 8841"), "8841");
});
