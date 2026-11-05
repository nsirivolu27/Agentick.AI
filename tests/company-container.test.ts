import test from "node:test";
import assert from "node:assert/strict";
import { companyListenHost } from "../workbench/company-server.js";

test("company container binding is explicit and refuses arbitrary hosts", () => {
  assert.equal(companyListenHost(""), "127.0.0.1");
  assert.equal(companyListenHost("127.0.0.1"), "127.0.0.1");
  assert.equal(companyListenHost("0.0.0.0"), "0.0.0.0");
  assert.throws(() => companyListenHost("portal.example"), /MAGENTIC_WORKBENCH_HOST/);
  assert.throws(() => companyListenHost("::"), /MAGENTIC_WORKBENCH_HOST/);
});
