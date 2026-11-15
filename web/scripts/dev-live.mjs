import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const webRoot = dirname(fileURLToPath(import.meta.url))
const repoWebRoot = dirname(webRoot)
const nextBin = join(repoWebRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
const STARTUP_TIMEOUT_MS = 30_000

export function parsePort(value, name, fallback) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  return port
}

export function kubectlArgs(forwardPort) {
  return ['-n', 'dotfiles', 'port-forward', '--address', '127.0.0.1', 'service/anvild', `${forwardPort}:8080`]
}

export function waitForForwardReady(child, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error(`kubectl port-forward did not become ready within ${timeoutMs}ms`)), timeoutMs)

    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdout?.removeListener('data', onOutput)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      error ? reject(error) : resolve()
    }
    const onOutput = chunk => {
      output += chunk.toString()
      if (output.includes('Forwarding from 127.0.0.1:')) finish()
    }
    const onError = error => finish(new Error(`Unable to start kubectl: ${error.message}`))
    const onExit = (code, signal) => finish(new Error(`kubectl port-forward exited before becoming ready (code=${code}, signal=${signal ?? 'none'})`))

    child.stdout?.on('data', onOutput)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
}

async function run() {
  const devPort = parsePort(process.env.DEV_LIVE_PORT, 'DEV_LIVE_PORT', 3000)
  const forwardPort = parsePort(process.env.ANVIL_FORWARD_PORT, 'ANVIL_FORWARD_PORT', 18080)
  const kubectl = process.env.KUBECTL_BIN || 'kubectl'
  let forward
  let next
  let requestedSignal
  const onSignal = signal => {
    requestedSignal = signal
    stop(next)
    stop(forward)
  }
  const onInt = () => onSignal('SIGINT')
  const onTerm = () => onSignal('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)

  try {
    forward = spawn(kubectl, kubectlArgs(forwardPort), { stdio: ['ignore', 'pipe', 'inherit'] })
    await waitForForwardReady(forward)
    if (requestedSignal) return 1

    next = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(devPort)], {
      cwd: repoWebRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development' },
    })

    const outcome = await new Promise((resolve, reject) => {
      next.once('error', reject)
      next.once('exit', (code, signal) => resolve({ code, signal }))
      forward.once('exit', (code, signal) => {
        stop(next)
        resolve({ code: code ?? 1, signal, forwardExited: true })
      })
    })
    if (outcome.forwardExited) {
      console.error(`kubectl port-forward stopped unexpectedly (code=${outcome.code}, signal=${outcome.signal ?? 'none'})`)
      return 1
    }
    return outcome.code ?? (outcome.signal ? 1 : 0)
  } finally {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    stop(next)
    stop(forward)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().then(code => { process.exitCode = code }).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
