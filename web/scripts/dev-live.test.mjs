import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { kubectlArgs, parsePort, waitForForwardReady } from './dev-live.mjs'

test('dev-live validates configurable ports', () => {
  assert.equal(parsePort(undefined, 'PORT', 3000), 3000)
  assert.equal(parsePort('4310', 'PORT', 3000), 4310)
  for (const invalid of ['0', '65536', '1.5', 'nope']) {
    assert.throws(() => parsePort(invalid, 'PORT', 3000), /PORT must be an integer/)
  }
})

test('development config skips trailing-slash redirects while keeping export slash behavior', async () => {
  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'

  try {
    const { default: config } = await import('../next.config.mjs?dev-live-test')
    assert.equal(config.skipTrailingSlashRedirect, true)
    assert.equal(config.trailingSlash, true)
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  }
})

test('kubectl forwards the anvild service in dotfiles only on loopback', () => {
  assert.deepEqual(kubectlArgs(18080), [
    '-n', 'dotfiles', 'port-forward', '--address', '127.0.0.1', 'service/anvild', '18080:8080',
  ])
})

test('forward readiness requires kubectl confirmation and fails on early exit', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  const ready = waitForForwardReady(child, 1000)
  child.stdout.write('Forwarding from 127.0.0.1:18080 -> 8080\n')
  await ready

  const exited = new EventEmitter()
  exited.stdout = new PassThrough()
  const failed = waitForForwardReady(exited, 1000)
  exited.emit('exit', 1, null)
  await assert.rejects(failed, /exited before becoming ready/)
})

test('forward readiness is bounded by a startup timeout', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  await assert.rejects(waitForForwardReady(child, 5), /did not become ready within 5ms/)
})
