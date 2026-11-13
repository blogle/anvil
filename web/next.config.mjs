import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const ignoredDirectories = new Set(['node_modules', 'out', '.next'])
const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((a, b) => comparePaths(a.name, b.name))) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await listSourceFiles(join(directory, entry.name)))
      }
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name))
    }
  }

  return files
}

async function generateBuildId() {
  const hash = createHash('sha256')
  const files = await listSourceFiles(webRoot)

  for (const file of files.sort((a, b) => comparePaths(relative(webRoot, a), relative(webRoot, b)))) {
    const path = relative(webRoot, file).split(sep).join('/')
    hash.update(path).update('\0').update(await readFile(file)).update('\0')
  }

  return hash.digest('hex')
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  generateBuildId,
}

export default nextConfig
