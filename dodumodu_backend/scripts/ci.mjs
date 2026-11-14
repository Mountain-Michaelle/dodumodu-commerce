// scripts/ci.mjs - the deploy pipeline's single line of communication with the Worker (zero dependencies).
//
//   node scripts/ci.mjs start                       report the run (build id, run link) - creates the build if the
//                                                   Worker never queued one (manual run)
//   node scripts/ci.mjs step <key> "<label>" -- <command...>
//                                                   run a command as a named step: report running, stream its output,
//                                                   keep the tail, report ok / failed WITH the error text
//   node scripts/ci.mjs call <endpoint>             POST /ci/builds/:id/<endpoint> (pre-deploy, mark-deployed, ...);
//                                                   a non-2xx answer fails the step, with the Worker's reason printed
//   node scripts/ci.mjs event <key> "<label>" <running|ok|failed> [message]   report one step by hand
//   node scripts/ci.mjs fail                        the last step of a failed run: names the step that broke
//
// Env: WORKER_URL, DEPLOY_TRIGGER_SECRET, BUILD_ID, optional RUN_URL, STEPS_JSON (the `steps` context).
// Reporting is best-effort for progress (a lost event never fails a deploy) and strict for decisions
// (pre-deploy / mark-*), where silence would mean deploying blind.
import { spawn } from 'node:child_process'

const WORKER_URL = (process.env.WORKER_URL ?? '').replace(/\/+$/, '')
const SECRET = (process.env.DEPLOY_TRIGGER_SECRET ?? '').trim()
const BUILD_ID = (process.env.BUILD_ID ?? '').trim()

/** Removes anything secret-shaped from text that is about to be stored and shown in the admin. */
export function redact(text) {
  let out = String(text)
  for (const v of [SECRET, process.env.CLOUDFLARE_API_TOKEN, process.env.GITHUB_TOKEN]) {
    if (v && v.length >= 8) out = out.split(v).join('***')
  }
  return out
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1***@')
    .replace(/\b(github_pat_|ghp_|gho_)[A-Za-z0-9_]{10,}/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
}

export async function post(path, body = {}, { retries = 3 } = {}) {
  if (!WORKER_URL || !SECRET || !BUILD_ID) {
    return { ok: false, status: 0, text: 'WORKER_URL, DEPLOY_TRIGGER_SECRET or BUILD_ID is not set' }
  }
  let last = { ok: false, status: 0, text: 'no attempt' }
  for (let i = 1; i <= retries; i += 1) {
    try {
      const res = await fetch(`${WORKER_URL}/ci/builds/${encodeURIComponent(BUILD_ID)}/${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = (await res.text().catch(() => '')).slice(0, 500)
      last = { ok: res.ok, status: res.status, text }
      // 4xx is an answer, not a blip: retrying cannot change it.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return last
    } catch (err) {
      last = { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) }
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * i))
  }
  return last
}

async function event(step, label, status, message) {
  const r = await post('events', { step, label, status, ...(message ? { message: redact(message).slice(-3500) } : {}) })
  if (!r.ok) console.warn(`ci: could not report step "${step}" (${r.status}): ${r.text}`)
}

async function runStep(step, label, cmd) {
  await event(step, label, 'running')
  const tail = []
  const keep = (chunk, sink) => {
    sink.write(chunk)
    for (const line of String(chunk).split('\n')) if (line.trim()) tail.push(line)
    if (tail.length > 60) tail.splice(0, tail.length - 60)
  }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  child.stdout.on('data', (d) => keep(d, process.stdout))
  child.stderr.on('data', (d) => keep(d, process.stderr))
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { tail.push(String(e)); resolve(1) })
    child.on('close', (c) => resolve(c ?? 1))
  })
  if (code === 0) { await event(step, label, 'ok'); return 0 }
  await event(step, label, 'failed', `${label} failed (exit ${code}).\n${tail.slice(-25).join('\n')}`)
  return code
}

async function callEndpoint(endpoint) {
  const r = await post(endpoint, {}, { retries: endpoint === 'pre-deploy' ? 2 : 4 })
  if (r.ok) { console.log(`ci: ${endpoint} accepted (${r.status})`); return 0 }
  console.error(`ci: ${endpoint} was refused by the Worker: HTTP ${r.status} ${r.text}`)
  if (r.status === 409) console.error('ci: this build is stale - a newer publish or build exists, so this run stops here.')
  return 1
}

// The `steps` context names every step's outcome; the first failure is the one to report.
async function failRun() {
  let failed = null
  try {
    const steps = JSON.parse(process.env.STEPS_JSON ?? '{}')
    failed = Object.entries(steps).find(([, v]) => v?.outcome === 'failure')?.[0] ?? null
  } catch { /* fall through */ }
  const message = failed
    ? `The "${failed}" step of the GitHub run failed. Open the run for the full log.`
    : 'The GitHub run failed before reporting a step. Open the run for the full log.'
  // A step that already reported its own error has failed the build with a better message: this is a no-op then.
  const r = await post('mark-failed', { error: message, step: failed ?? 'run' })
  console.log(`ci: mark-failed -> ${r.status} ${r.text}`)
  return 0
}

const [, , command, ...args] = process.argv
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ci.mjs')) {
  let code = 0
  if (command === 'start') {
    const r = await post('start', process.env.RUN_URL ? { runUrl: process.env.RUN_URL } : {})
    console.log(`ci: start -> ${r.status} ${r.text}`)
    await event('workflow', 'GitHub run started', 'ok', process.env.RUN_URL ? `Run: ${process.env.RUN_URL}` : undefined)
  } else if (command === 'step') {
    const dash = args.indexOf('--')
    code = await runStep(args[0], args[1], args.slice(dash + 1))
  } else if (command === 'event') {
    await event(args[0], args[1], args[2], args[3])
  } else if (command === 'call') {
    code = await callEndpoint(args[0])
  } else if (command === 'fail') {
    code = await failRun()
  } else {
    console.error('usage: ci.mjs start | step <key> <label> -- <cmd...> | call <endpoint> | fail')
    code = 2
  }
  process.exit(code)
}
