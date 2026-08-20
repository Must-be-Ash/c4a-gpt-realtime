import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reports and order previews append as reusable conversation timeline entries", async () => {
  const [page, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<section\s+id="artifacts"[^>]+aria-label="Conversation timeline"/);
  assert.match(page, /<template\s+id="reportTemplate"/);
  assert.match(page, /<template\s+id="tradeTemplate"/);
  assert.doesNotMatch(page, /id="(?:reportSection|tradePanel)"/);
  assert.match(app, /const entry = elements\.reportTemplate\.content\.firstElementChild\.cloneNode\(true\)/);
  assert.match(app, /appendTimelineEntry\(entry, \{ scroll: true \}\)/);
  assert.match(app, /const panel = elements\.tradeTemplate\.content\.firstElementChild\.cloneNode\(true\)/);
  assert.match(app, /appendTimelineEntry\(panel, \{ scroll: true \}\)/);
});

test("timeline entries preserve request order by appending to one feed", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const helper = app.slice(
    app.indexOf("function appendTimelineEntry"),
    app.indexOf("function clearLiveCaption"),
  );

  assert.match(helper, /elements\.artifacts\.append\(entry\)/);
  assert.doesNotMatch(helper, /prepend|insertBefore/);
  assert.match(app, /const position = appendTimelineEntry\(artifact\)/);
});
