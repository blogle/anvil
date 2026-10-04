import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"

const exec = promisify(execFile)
const root = `${process.env.ANVIL_WORKSPACE_ROOT || "/home/anvil/workspace"}/${process.env.ANVIL_PROJECT}`
const maxFiles = 200
const maxFileBytes = 64 * 1024
const maxResponseBytes = 512 * 1024

async function git(args, maxBuffer = 1024 * 1024) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer })
  return stdout
}

async function gitDiff(args, maxBuffer) {
  try { return await git(args, maxBuffer) }
  catch (error) {
    if (error.code === 1 && error.stdout) return Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout)
    throw error
  }
}

async function recordedBase() {
  let baseRevision
  try { baseRevision = (await (await import("node:fs/promises")).readFile(`${root}/.git/anvil-session-base`, "utf8")).trim() }
  catch { throw new Error("This session has no recorded worker base revision.") }
  if (!/^[0-9a-f]{40,64}$/.test(baseRevision)) throw new Error("Recorded worker base revision is missing or invalid.")
  const pinned = (await git(["rev-parse", "--verify", "refs/anvil/session-base^{commit}"])).toString().trim()
  if (pinned !== baseRevision) throw new Error("Recorded worker base revision does not match the pinned workspace base.")
  return baseRevision
}

async function diff() {
  const baseRevision = await recordedBase()
  const raw = await git(["diff", "--name-status", "-z", "--find-renames", baseRevision, "--"])
  const tokens = raw.toString().split("\0").filter(Boolean)
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
  for (const path of untracked) tokens.push("A", path)
  const files = []
  let responseBytes = 0
  let truncated = false
  for (let i = 0; i < tokens.length;) {
    const statusToken = tokens[i++]
    const oldOrPath = tokens[i++]
    if (!oldOrPath) break
    const renamed = statusToken.startsWith("R") || statusToken.startsWith("C")
    const path = renamed ? tokens[i++] : oldOrPath
    const status = renamed ? "renamed" : statusToken === "A" ? "added" : statusToken === "D" ? "deleted" : "modified"
    if (files.length >= maxFiles) { truncated = true; break }
    const isUntracked = statusToken === "A" && (await git(["ls-files", "--error-unmatch", path]).catch(() => null)) === null
    const args = isUntracked
      ? ["diff", "--no-index", "--no-ext-diff", "--no-color", "--binary", "--", "/dev/null", path]
      : ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", baseRevision, "--", ...(renamed ? [oldOrPath] : []), path]
    let patch
    try { patch = isUntracked ? await gitDiff(args, maxFileBytes + 1) : await git(args, maxFileBytes + 1) }
    catch (error) {
      if (error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error
      patch = Buffer.alloc(maxFileBytes + 1)
    }
    const tooLarge = patch.length > maxFileBytes
    const binary = patch.includes(Buffer.from("GIT binary patch")) || patch.includes(Buffer.from("Binary files"))
    let additions = 0, deletions = 0
    if (isUntracked) {
      additions = patch.toString("utf8").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length
    } else {
      const numstat = (await git(["diff", "--numstat", "-z", "--find-renames", baseRevision, "--", ...(renamed ? [oldOrPath] : []), path])).toString().split("\t")
      if (numstat[0] === "-") { additions = null; deletions = null }
      else { additions = Number(numstat[0]) || 0; deletions = Number((numstat[1] || "").split("\0")[0]) || 0 }
    }
    const overBudget = !binary && responseBytes + patch.length > maxResponseBytes
    if (!binary && !tooLarge && !overBudget) responseBytes += patch.length
    files.push({ path, old_path: renamed ? oldOrPath : null, status, additions, deletions, binary, too_large: tooLarge || overBudget, diff: binary || tooLarge || overBudget ? "" : patch.toString("utf8") })
  }
  return { status: "ready", diff: { base_revision: baseRevision, files, truncated } }
}

createServer(async (request, response) => {
  if (!new Set(["/v1/diff", "/v1/base"]).has(request.url) || request.method !== "GET") { response.writeHead(404).end(); return }
  try {
    const result = request.url === "/v1/base" ? { status: "ready", base_revision: await recordedBase() } : await diff()
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ status: "unavailable", message: String(error.message || error) }))
  }
}).listen(Number(process.env.ANVIL_DIFF_PORT || 4097), "0.0.0.0")
