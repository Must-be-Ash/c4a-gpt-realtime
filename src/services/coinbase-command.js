import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@coinbase/coinbase-cli/package.json"));

export const coinbaseCommand = Object.freeze({
  command: process.execPath,
  args: [join(packageRoot, "dist", "index.js")],
});
