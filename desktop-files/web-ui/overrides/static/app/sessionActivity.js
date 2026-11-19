import { signal } from '@preact/signals'

const currentActivity = signal(null)
const statuses = new Set(['running', 'waiting', 'idle', 'stopped', 'error', 'starting', 'queued'])

export function updateSessionActivity(sessionId, history) {
  const status = history.activity === 'awaiting_input' ? 'waiting'
    : history.activity === 'request_failed' ? 'error'
    : history.turnRunning ? 'running'
    : statuses.has(history.activity) ? history.activity : history.status
  if (!statuses.has(status)) return
  if (currentActivity.value?.sessionId === sessionId && currentActivity.value.status === status) return
  currentActivity.value = { sessionId, status }
}

export function clearSessionActivity(sessionId) {
  if (currentActivity.value?.sessionId === sessionId) currentActivity.value = null
}

export function sessionIndicatorStatus(session) {
  const observed = currentActivity.value
  return observed?.sessionId === session.id ? observed.status : session.status
}
