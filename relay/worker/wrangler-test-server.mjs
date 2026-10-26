import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_RESPONSE_SIGNING } from '../test-fixtures/response-signing-key.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

export async function startWorker(vars = {}, options = {}) {
  const persist = options.persist ?? mkdtempSync(join(tmpdir(), 'friends-worker-test-'))
  const port = 22000 + Math.floor(Math.random() * 10000)
  const base = `http://127.0.0.1:${port}`
  let stderr = ''
  const allVars = {
    RESPONSE_SIGNING_PRIVATE_KEY: TEST_RESPONSE_SIGNING.privateKeyPkcs8,
    RESPONSE_SIGNING_KEY_ID: TEST_RESPONSE_SIGNING.keyId,
    ...vars,
  }
  const args = [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
    '--show-interactive-dev-session=false']
  for (const [key, value] of Object.entries(allVars)) args.push('--var', `${key}:${value}`)
  const child = spawn(process.execPath, args, {
    cwd: here, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: join(persist, 'xdg') },
  })
  child.stderr.on('data', data => { stderr += data })
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited ${child.exitCode}: ${stderr}`)
    try { if ((await fetch(base + '/health')).ok) return { base, child, persist, stderr: () => stderr } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await stopWorker({ child, persist })
  throw new Error(`wrangler dev was not ready in 60 seconds: ${stderr}`)
}

export async function stopWorker(server, options = {}) {
  if (!server) return
  const { child, persist } = server
  if (child) {
    const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    } else child.kill()
    child.stderr?.destroy()
    child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    child.unref()
  }
  if (options.keepPersist) return
  for (let i = 0; i <= 20; i++) {
    try { rmSync(persist, { recursive: true, force: true }); break } catch {
      if (i < 20) await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}
