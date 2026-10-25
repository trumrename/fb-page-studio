import assert from "node:assert/strict";
import test from "node:test";
import { csvEscape } from "../src/services/export.js";

test("quick CSV escapes commas, quotes, and line breaks as fields", () => {
  assert.equal(csvEscape("Page A, Page B"), '"Page A, Page B"');
  assert.equal(csvEscape('A "quoted" page'), '"A ""quoted"" page"');
  assert.equal(csvEscape("line 1\nline 2"), '"line 1\nline 2"');
  assert.equal(csvEscape("plain"), "plain");
});
