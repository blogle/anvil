import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, execFileSync } from "node:child_process"

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
}

test("worker diff endpoint keeps immutable base and includes commits, index, worktree and untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "anvil-files-diff-"))
  const project = join(root, "demo")
  const port = 41000 + Math.floor(Math.random() * 10000)
  let server
  try {
    await mkdir(project)
    git(project, "init", "-b", "main")
    git(project, "config", "user.name", "Test")
    git(project, "config", "user.email", "test@example.invalid")
    await writeFile(join(project, "modify.txt"), "base\n")
    await writeFile(join(project, "delete.txt"), "delete\n")
    await writeFile(join(project, "old-name.txt"), "line one\nline two\nline three\n")
    git(project, "add", ".")
    git(project, "commit", "-m", "base")
    const base = git(project, "rev-parse", "HEAD")
    git(project, "update-ref", "refs/anvil/session-base", base)
    await writeFile(join(project, ".git/anvil-session-base"), `${base}\n`)
    git(project, "switch", "-c", "worker")
    git(project, "switch", "-c", "upstream", base)
    await writeFile(join(project, "upstream-only.txt"), "main moved\n")
    git(project, "add", ".")
    git(project, "commit", "-m", "upstream")
    git(project, "update-ref", "refs/heads/main", git(project, "rev-parse", "HEAD"))
    git(project, "switch", "worker")
    await writeFile(join(project, "modify.txt"), "committed change\n")
    git(project, "add", "modify.txt")
    git(project, "commit", "-m", "worker commit")
    await writeFile(join(project, "modify.txt"), "committed plus worktree\n")
    await writeFile(join(project, "staged.txt"), "index change\n")
    git(project, "add", "staged.txt")
    await rm(join(project, "delete.txt"))
    git(project, "mv", "old-name.txt", "new-name.txt")
    await writeFile(join(project, "untracked.txt"), "added without git add\n")
    await writeFile(join(project, "image.bin"), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(project, "huge.txt"), Buffer.alloc(70 * 1024, 120))

    server = spawn(process.execPath, [resolve("runtime/git-diff-server.mjs")], {
      env: { ...process.env, ANVIL_PROJECT: "demo", ANVIL_WORKSPACE_ROOT: root, ANVIL_DIFF_PORT: String(port) },
      stdio: "ignore",
    })
    let response
    for (let attempt = 0; attempt < 60; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/v1/diff`); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(response, "worker diff service should start")
    const baseResponse = await fetch(`http://127.0.0.1:${port}/v1/base`)
    assert.equal((await baseResponse.json()).base_revision, base)
    const payload = await response.json()
    assert.equal(payload.status, "ready")
    assert.equal(payload.diff.base_revision, base)
    const files = new Map(payload.diff.files.map((file) => [file.path, file]))
    assert.equal(files.get("modify.txt").status, "modified")
    assert.match(files.get("modify.txt").diff, /committed plus worktree/)
    assert.equal(files.get("staged.txt").status, "added")
    assert.equal(files.get("untracked.txt").status, "added")
    assert.equal(files.get("delete.txt").status, "deleted")
    assert.equal(files.get("new-name.txt").status, "renamed")
    assert.equal(files.get("new-name.txt").old_path, "old-name.txt")
    assert.match(files.get("new-name.txt").diff, /rename from old-name\.txt/)
    assert.match(files.get("new-name.txt").diff, /rename to new-name\.txt/)
    assert.equal(files.get("new-name.txt").additions, 0)
    assert.equal(files.get("new-name.txt").deletions, 0)
    assert.equal(files.get("image.bin").binary, true)
    assert.equal(files.get("huge.txt").too_large, true)
    assert.equal(files.has("upstream-only.txt"), false)
  } finally {
    server?.kill("SIGTERM")
    await rm(root, { recursive: true, force: true })
  }
})

test("suppressed binary patches do not consume the returned diff budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "anvil-files-budget-"))
  const project = join(root, "demo")
  const port = 41000 + Math.floor(Math.random() * 10000)
  let server
  try {
    await mkdir(project)
    git(project, "init", "-b", "main")
    git(project, "config", "user.name", "Test")
    git(project, "config", "user.email", "test@example.invalid")
    await writeFile(join(project, "small.txt"), "base\n")
    git(project, "add", ".")
    git(project, "commit", "-m", "base")
    const base = git(project, "rev-parse", "HEAD")
    git(project, "update-ref", "refs/anvil/session-base", base)
    await writeFile(join(project, ".git/anvil-session-base"), `${base}\n`)
    for (let index = 0; index < 100; index++) {
      const data = Buffer.alloc(6000)
      for (let byte = 0; byte < data.length; byte++) data[byte] = (byte * 31 + index * 17) % 256
      await writeFile(join(project, `a-binary-${String(index).padStart(3, "0")}.bin`), data)
    }
    await writeFile(join(project, "small.txt"), "updated\n")
    server = spawn(process.execPath, [resolve("runtime/git-diff-server.mjs")], {
      env: { ...process.env, ANVIL_PROJECT: "demo", ANVIL_WORKSPACE_ROOT: root, ANVIL_DIFF_PORT: String(port) },
      stdio: "ignore",
    })
    let response
    for (let attempt = 0; attempt < 60; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/v1/diff`); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(response)
    const payload = await response.json()
    const files = new Map(payload.diff.files.map((file) => [file.path, file]))
    assert.equal(files.get("a-binary-000.bin").binary, true)
    assert.match(files.get("small.txt").diff, /updated/)
    assert.equal(files.get("small.txt").too_large, false)
  } finally {
    server?.kill("SIGTERM")
    await rm(root, { recursive: true, force: true })
  }
})

test("worker diff endpoint explicitly reports a missing legacy base", async () => {
  const root = await mkdtemp(join(tmpdir(), "anvil-files-legacy-"))
  const project = join(root, "demo")
  const port = 51000 + Math.floor(Math.random() * 10000)
  let server
  try {
    await mkdir(project)
    git(project, "init", "-b", "main")
    server = spawn(process.execPath, [resolve("runtime/git-diff-server.mjs")], {
      env: { ...process.env, ANVIL_PROJECT: "demo", ANVIL_WORKSPACE_ROOT: root, ANVIL_DIFF_PORT: String(port) },
      stdio: "ignore",
    })
    let response
    for (let attempt = 0; attempt < 60; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/v1/diff`); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(response)
    const payload = await response.json()
    assert.equal(payload.status, "unavailable")
    assert.match(payload.message, /no recorded worker base revision/i)
  } finally {
    server?.kill("SIGTERM")
    await rm(root, { recursive: true, force: true })
  }
})
