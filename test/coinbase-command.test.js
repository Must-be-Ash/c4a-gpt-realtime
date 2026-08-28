import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { coinbaseCommand } from "../src/services/coinbase-command.js";

const execFileAsync = promisify(execFile);

test("launches the pinned local Coinbase CLI", async () => {
  assert.equal(coinbaseCommand.command, process.execPath);
  assert.match(coinbaseCommand.args[0], /@coinbase\/coinbase-cli\/dist\/index\.js$/);

  const { stdout } = await execFileAsync(coinbaseCommand.command, [...coinbaseCommand.args, "--version"]);
  assert.match(stdout, /coinbase 0\.0\.6/);
});
