import { fork } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_ENTRY = fileURLToPath(new URL('./trial-worker.mjs', import.meta.url))
const SAFE_ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']
const STDERR_TAIL_LIMIT = 4096

/** Spawn the native runner without inheriting arbitrary parent credentials or profile paths. */
export function runTrialWorkerProcess(options) {
  return runWorkerProcess(options)
}

function runWorkerProcess({ onProgress, getRunRecords, workerCredentials, forkProcess = fork, processCwd, ...plan }) {
  const workerCwd = processCwd ?? plan.workerRoot ?? process.cwd()
  mkdirSync(workerCwd, { recursive: true })
  const stderrTail = createStderrTail(workerCredentials)
  const child = forkProcess(WORKER_ENTRY, [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: workerCwd,
    env: workerEnvironment(workerCredentials),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  })
  child.stderr?.on('data', chunk => stderrTail.append(chunk))
  const pidMarker = plan.workerRoot && child.pid ? join(plan.workerRoot, '.worker-process.json') : undefined
  if (pidMarker) {
    writeFileSync(pidMarker, JSON.stringify({ trialId: plan.trialId, pid: child.pid }), 'utf8')
  }
  const removePidMarker = () => {
    if (!pidMarker) return
    try {
      const marker = JSON.parse(readFileSync(pidMarker, 'utf8'))
      if (marker.trialId === plan.trialId && marker.pid === child.pid) rmSync(pidMarker, { force: true })
    } catch {}
  }
  let settled = false
  let cancelPending
  let cancelTimer
  let cancelPromise
  const settleCancel = () => {
    clearTimeout(cancelTimer)
    cancelTimer = undefined
    const resolve = cancelPending?.resolve
    cancelPending = undefined
    cancelPromise = undefined
    resolve?.()
  }
  const done = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'progress') onProgress?.(message.event)
      else if (message?.type === 'cancelled') {
        settleCancel()
      } else if (message?.type === 'result' && !settled) {
        settled = true
        resolve(message.result)
      } else if (message?.type === 'error' && !settled) {
        settled = true
        const error = new Error(message.message || 'The isolated trial worker failed.')
        error.code = message.code
        reject(error)
      }
    })
    child.once('error', error => {
      removePidMarker()
      if (settled) return
      settled = true
      reject(new Error(`The isolated trial worker could not start: ${safeError(error)}`))
    })
    child.once('exit', (code, signal) => {
      removePidMarker()
      if (!settled) {
        settled = true
        const diagnostic = stderrTail.text()
        reject(new Error(`The isolated trial worker exited (${signal || code}).${diagnostic ? `\nWorker stderr:\n${diagnostic}` : ''}`))
      }
      settleCancel()
    })
  })

  child.send({ type: 'run', plan })
  return {
    done,
    async cancel(reason) {
      if (settled || !child.connected) return
      if (!cancelPromise) {
        cancelPromise = new Promise(resolve => {
          cancelPending = { resolve }
          cancelTimer = setTimeout(() => {
            const resolvePending = cancelPending?.resolve
            cancelPending = undefined
            cancelTimer = undefined
            cancelPromise = undefined
            resolvePending?.()
            if (!child.killed) child.kill()
          }, 30_000)
          cancelTimer.unref?.()
        })
        child.send({ type: 'cancel', reason: String(reason || 'cancelled') })
      }
      await cancelPromise
    },
  }
}

function workerEnvironment(credentials = {}) {
  const environment = {}
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key]
  for (const [key, value] of Object.entries(credentials)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || !value) continue
    environment[key] = value
  }
  environment.ELECTRON_RUN_AS_NODE = '1'
  environment.DSH_TELEMETRY_DISABLED = '1'
  return environment
}

function safeError(error) {
  return String(error?.message ?? error).replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[credential omitted]')
}

function createStderrTail(credentials) {
  let value = ''
  const secrets = Object.values(credentials ?? {}).filter(secret => typeof secret === 'string' && secret.length > 0)
    .sort((left, right) => right.length - left.length)
  return {
    append(chunk) {
      value = (value + String(chunk)).slice(-STDERR_TAIL_LIMIT)
    },
    text() {
      return secrets.reduce((text, secret) => text.split(secret).join('[credential omitted]'), value)
        .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[credential omitted]').trim()
    },
  }
}
