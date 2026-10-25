import assert from "node:assert/strict";
import test from "node:test";
import { orderTasksByPostPageToken } from "../src/services/jobRunner.js";

test("orders tasks as post → page → token", () => {
  const tasks = [];
  for (const token of [1, 2, 3]) {
    for (const page of [1, 2]) {
      for (const post of [1, 2, 3]) {
        tasks.push({
          account_id: token,
          page_row_id: token * 100 + page,
          page_name: `Page ${page}`,
          opts: { post_round: post },
        });
      }
    }
  }

  const ordered = orderTasksByPostPageToken(tasks);
  const actual = ordered.map((t) => [t.opts.post_round, t.page_name, t.account_id]);
  const expected = [];
  for (const post of [1, 2, 3]) {
    for (const page of [1, 2]) {
      for (const token of [1, 2, 3]) expected.push([post, `Page ${page}`, token]);
    }
  }
  assert.deepEqual(actual, expected);
});

test("keeps stable order for same post/page/token", () => {
  const a = { account_id: 1, page_row_id: 11, opts: { post_round: 1 }, marker: "a" };
  const b = { account_id: 1, page_row_id: 11, opts: { post_round: 1 }, marker: "b" };
  assert.deepEqual(orderTasksByPostPageToken([b, a]).map((t) => t.marker), ["b", "a"]);
});
