import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFor } from "../src/surface/playwright.js";

const base = {
  ref: "e1", type: "", text: "", id: "", nameAttr: "", tdLabel: "", cssPath: "body > div", enabled: true,
};

test("legacy input named only by its row label gets NO role candidate (a11y engine cannot see it)", () => {
  const c = candidatesFor({ ...base, tag: "input", role: "textbox", name: "Operator ID:", tdLabel: "Operator ID:", nameAttr: "txtUser" });
  assert.ok(!c.some((x) => x.strategy === "role"));
  assert.equal(c[0]!.strategy, "tdlabel");
});

test("button with a real accessible name ranks role+name first", () => {
  const c = candidatesFor({ ...base, tag: "input", type: "submit", role: "button", name: "Sign On" });
  assert.equal(c[0]!.strategy, "role");
  assert.equal(c[0]!.value, "button::Sign On");
});

test("framework-generated ids are kept but marked low trust", () => {
  const c = candidatesFor({ ...base, tag: "input", role: "textbox", name: "X:", tdLabel: "X:", id: "ctl00_main_txt1" });
  const idCand = c.find((x) => x.strategy === "attr" && x.value.startsWith("#"))!;
  assert.match(idCand.note!, /low trust/);
});

test("form-field name attribute ranks above a generated id", () => {
  const c = candidatesFor({ ...base, tag: "input", role: "textbox", name: "X:", tdLabel: "X:", nameAttr: "txtUser", id: "ctl00_main_txt1" });
  const nameIdx = c.findIndex((x) => x.value === '[name="txtUser"]');
  const idIdx = c.findIndex((x) => x.value.startsWith("#"));
  assert.ok(nameIdx >= 0 && nameIdx < idIdx);
});

test("data cells (extraction targets) anchor to their row label first", () => {
  const c = candidatesFor({ ...base, tag: "td", role: "text", name: "Savings Balance $1.00", tdLabel: "Savings Balance", id: "ctl00_cph_lblSav" });
  assert.equal(c[0]!.strategy, "css");
  assert.ok(c[0]!.value.includes("Savings Balance"));
});

test("structural css path is always the last resort", () => {
  const c = candidatesFor({ ...base, tag: "a", role: "link", name: "View", text: "View" });
  assert.equal(c[c.length - 1]!.strategy, "css");
});
