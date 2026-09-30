import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("real DOM rows retain identity and only elapsed leaves mutate", () => {
  const fixture = new URL("./session-row-dom.test.html", import.meta.url)
  const output = execFileSync("chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files",
    "--dump-dom", fileURLToPath(fixture),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  assert.match(output, /<title>PASS<\/title>/)
  assert.match(output, /Ready for review/)
  assert.match(output, />Working</)
})
