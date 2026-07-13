import { initializeApp } from 'firebase/app'
import { get, getDatabase, push, ref, set, update } from 'firebase/database'

const TOP_RANKING_LIMIT = 7
const PREVIEW_RANKING_LIMIT = 8
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_DAILY_LIMIT = 3
const DEFAULT_RUN_LIMIT = 3
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0'

let app
let realtimeDb

function now() {
  return Date.now()
}

function getFirebaseConfig() {
  return {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID,
    databaseURL: process.env.VITE_FIREBASE_DATABASE_URL,
  }
}

function getDb() {
  if (realtimeDb) return realtimeDb

  const config = getFirebaseConfig()
  const configured = config.apiKey && config.projectId && config.appId && config.databaseURL
  if (!configured) {
    throw new Error('Firebase runtime env vars are missing.')
  }

  app = app || initializeApp(config, 'agroventas-whatsapp-notifications')
  realtimeDb = getDatabase(app)
  return realtimeDb
}

function safeKey(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function dayKey(timestamp = now()) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function getNumberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function isDryRun() {
  return process.env.WHATSAPP_DRY_RUN !== 'false'
}

function getUser(usersByPhone, phone) {
  return usersByPhone?.[phone] ?? null
}

function getParticipantName(usersByPhone, phone) {
  const user = getUser(usersByPhone, phone)
  return user?.nombre || phone
}

function getParticipantProfile(usersByPhone, phone) {
  const user = getUser(usersByPhone, phone)
  return user?.perfil_productor || ''
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '-'
  return `${(ms / 1000).toFixed(2)}s`
}

function getBestResultsByPhone(results) {
  const bestByPhone = new Map()

  results.forEach((result) => {
    if (!result.celular || !Number.isFinite(result.tiempo_ms)) return
    const current = bestByPhone.get(result.celular)
    if (!current || result.tiempo_ms < current.tiempo_ms) {
      bestByPhone.set(result.celular, result)
    }
  })

  return [...bestByPhone.values()].sort((a, b) => {
    if (a.tiempo_ms !== b.tiempo_ms) return a.tiempo_ms - b.tiempo_ms
    return (a.completado_at ?? 0) - (b.completado_at ?? 0)
  })
}

function buildRanking(resultsById, usersByPhone, sessionId, options = {}) {
  const excludedResultId = options.excludedResultId

  const sessionResults = Object.entries(resultsById || {})
    .map(([id, value]) => ({ id, ...value }))
    .filter((result) => {
      return (
        result.id !== excludedResultId &&
        result.session_id === sessionId &&
        Number.isFinite(result.tiempo_ms) &&
        result.celular
      )
    })

  return getBestResultsByPhone(sessionResults).map((result, index) => ({
    id: result.id,
    phone: result.celular,
    rank: index + 1,
    name: getParticipantName(usersByPhone, result.celular),
    profile: getParticipantProfile(usersByPhone, result.celular),
    timeMs: result.tiempo_ms,
    timeLabel: formatTime(result.tiempo_ms),
    completedAt: result.completado_at ?? null,
  }))
}

function getImpactedParticipants(previousRanking, currentRanking, winnerPhone) {
  const currentByPhone = new Map(currentRanking.map((entry) => [entry.phone, entry]))

  return previousRanking
    .filter((entry) => entry.rank <= TOP_RANKING_LIMIT)
    .map((previousEntry) => {
      const currentEntry = currentByPhone.get(previousEntry.phone)
      return {
        ...previousEntry,
        previousRank: previousEntry.rank,
        currentRank: currentEntry?.rank ?? null,
        currentTimeLabel: currentEntry?.timeLabel ?? previousEntry.timeLabel,
      }
    })
    .filter((entry) => {
      if (entry.phone === winnerPhone) return false
      if (!entry.currentRank) return true
      return entry.currentRank > entry.previousRank
    })
}

function shouldSkipByLimits(state, latestResultId, timestamp, dryRun) {
  if (dryRun && state?.last_dry_run_result_id === latestResultId) return 'duplicate_result'
  if (!dryRun && state?.last_sent_result_id === latestResultId) return 'duplicate_result'

  const cooldownMs = getNumberEnv('WHATSAPP_COOLDOWN_MS', DEFAULT_COOLDOWN_MS)
  const lastActivityAt = dryRun ? state?.last_dry_run_at : state?.last_sent_at
  if (Number.isFinite(lastActivityAt) && timestamp - lastActivityAt < cooldownMs) {
    return 'cooldown'
  }

  const today = dayKey(timestamp)
  const dailyLimit = getNumberEnv('WHATSAPP_DAILY_LIMIT', DEFAULT_DAILY_LIMIT)
  const stateDayKey = dryRun ? state?.dry_run_day_key : state?.sent_day_key
  const stateDayCount = dryRun ? state?.dry_run_day_count : state?.sent_day_count
  const dailyCount = stateDayKey === today ? Number(stateDayCount || 0) : 0
  if (dailyCount >= dailyLimit) return 'daily_limit'

  return null
}

async function sendWhatsAppTemplate(notification) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME
  const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE

  if (!token || !phoneNumberId || !templateName || !templateLanguage) {
    throw new Error('WhatsApp runtime env vars are missing.')
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: notification.phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: notification.name },
              { type: 'text', text: notification.sessionName },
              { type: 'text', text: String(notification.currentRank ?? '8+') },
              { type: 'text', text: notification.timeLabel },
            ],
          },
        ],
      },
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'WhatsApp API request failed.')
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}

async function writeNotificationLog(db, sessionId, notification) {
  const logRef = push(ref(db, `admin/whatsapp/notifications/${safeKey(sessionId)}`))
  await set(logRef, notification)
  return logRef.key
}

async function updateParticipantState(db, sessionId, phone, statePatch) {
  await update(ref(db, `admin/whatsapp/participant_state/${safeKey(sessionId)}/${safeKey(phone)}`), statePatch)
}

export async function processRankingNotifications(options = {}) {
  const db = getDb()
  const timestamp = now()

  const [adminSnapshot, resultsSnapshot, usersSnapshot, sessionsSnapshot] = await Promise.all([
    get(ref(db, 'admin/settings')),
    get(ref(db, 'game_results')),
    get(ref(db, 'users')),
    get(ref(db, 'sessions')),
  ])

  const adminSettings = adminSnapshot.val() || {}
  const sessionId = options.sessionId || adminSettings.active_session_id || process.env.VITE_FIREBASE_SESSION_ID
  const resultsById = resultsSnapshot.val() || {}
  const usersByPhone = usersSnapshot.val() || {}
  const sessionsById = sessionsSnapshot.val() || {}
  const latestResultId = options.resultId || Object.entries(resultsById).sort((a, b) => {
    return (b[1]?.completado_at ?? 0) - (a[1]?.completado_at ?? 0)
  })[0]?.[0]

  if (!sessionId) {
    throw new Error('No active session found for WhatsApp ranking notifications.')
  }

  const runRef = push(ref(db, `admin/whatsapp/runs/${safeKey(sessionId)}`))
  const runId = runRef.key
  const stateSnapshot = await get(ref(db, `admin/whatsapp/participant_state/${safeKey(sessionId)}`))
  const stateByPhone = stateSnapshot.val() || {}

  if (!latestResultId || !resultsById[latestResultId]) {
    await set(runRef, {
      status: 'skipped',
      reason: 'missing_latest_result',
      dry_run: isDryRun(),
      created_at: timestamp,
    })
    return { status: 'skipped', reason: 'missing_latest_result', notifications: [] }
  }

  const latestResult = { id: latestResultId, ...resultsById[latestResultId] }
  if (latestResult.session_id !== sessionId || !Number.isFinite(latestResult.tiempo_ms)) {
    await set(runRef, {
      status: 'skipped',
      reason: 'result_outside_active_session',
      session_id: sessionId,
      result_id: latestResultId,
      dry_run: isDryRun(),
      created_at: timestamp,
    })
    return { status: 'skipped', reason: 'result_outside_active_session', notifications: [] }
  }

  const previousRanking = buildRanking(resultsById, usersByPhone, sessionId, {
    excludedResultId: latestResultId,
  })
  const currentRanking = buildRanking(resultsById, usersByPhone, sessionId)
  const winner = currentRanking.find((entry) => entry.id === latestResultId || entry.phone === latestResult.celular)

  if (!winner || winner.rank > TOP_RANKING_LIMIT) {
    await set(runRef, {
      status: 'skipped',
      reason: 'winner_outside_top_ranking',
      session_id: sessionId,
      result_id: latestResultId,
      winner_rank: winner?.rank ?? null,
      dry_run: isDryRun(),
      created_at: timestamp,
    })
    return { status: 'skipped', reason: 'winner_outside_top_ranking', notifications: [] }
  }

  const sessionName = sessionsById[sessionId]?.nombre || sessionId
  const runLimit = getNumberEnv('WHATSAPP_RUN_LIMIT', DEFAULT_RUN_LIMIT)
  const candidates = getImpactedParticipants(previousRanking, currentRanking, latestResult.celular).slice(0, PREVIEW_RANKING_LIMIT)
  const notifications = []

  for (const candidate of candidates) {
    if (notifications.filter((entry) => entry.status === 'sent' || entry.status === 'dry_run').length >= runLimit) {
      notifications.push({
        phone: candidate.phone,
        name: candidate.name,
        status: 'skipped',
        reason: 'run_limit',
      })
      continue
    }

    const state = stateByPhone[safeKey(candidate.phone)] || {}
    const dryRun = isDryRun()
    const limitReason = shouldSkipByLimits(state, latestResultId, timestamp, dryRun)
    if (limitReason) {
      notifications.push({
        phone: candidate.phone,
        name: candidate.name,
        status: 'skipped',
        reason: limitReason,
      })
      continue
    }

    const notification = {
      type: 'ranking_superado',
      status: dryRun ? 'dry_run' : 'pending',
      dry_run: dryRun,
      session_id: sessionId,
      session_name: sessionName,
      result_id: latestResultId,
      winner_phone: latestResult.celular,
      winner_name: winner.name,
      phone: candidate.phone,
      name: candidate.name,
      previous_rank: candidate.previousRank,
      current_rank: candidate.currentRank,
      time_label: candidate.currentTimeLabel,
      created_at: timestamp,
    }

    try {
      if (!dryRun) {
        const whatsappResponse = await sendWhatsAppTemplate({
          phone: candidate.phone,
          name: candidate.name,
          sessionName,
          currentRank: candidate.currentRank,
          timeLabel: candidate.currentTimeLabel,
        })
        notification.status = 'sent'
        notification.whatsapp_response = whatsappResponse
        notification.sent_at = now()
      }

      const logId = await writeNotificationLog(db, sessionId, notification)
      const today = dayKey(timestamp)
      const sentDailyCount = state?.sent_day_key === today ? Number(state?.sent_day_count || 0) : 0
      const dryRunDailyCount = state?.dry_run_day_key === today ? Number(state?.dry_run_day_count || 0) : 0
      const statePatch = {
        last_status: notification.status,
        last_notification_id: logId,
      }

      if (dryRun) {
        statePatch.dry_run_day_key = today
        statePatch.dry_run_day_count = dryRunDailyCount + 1
        statePatch.last_dry_run_result_id = latestResultId
        statePatch.last_dry_run_at = timestamp
      } else {
        statePatch.sent_day_key = today
        statePatch.sent_day_count = sentDailyCount + 1
        statePatch.last_sent_result_id = latestResultId
        statePatch.last_sent_at = timestamp
      }

      await updateParticipantState(db, sessionId, candidate.phone, statePatch)

      notifications.push({ ...notification, id: logId })
    } catch (error) {
      const failedNotification = {
        ...notification,
        status: 'error',
        error_message: error.message,
        error_status: error.status ?? null,
        error_payload: error.payload ?? null,
      }
      const logId = await writeNotificationLog(db, sessionId, failedNotification)
      notifications.push({ ...failedNotification, id: logId })
    }
  }

  const runPayload = {
    status: 'completed',
    dry_run: isDryRun(),
    session_id: sessionId,
    result_id: latestResultId,
    winner_phone: latestResult.celular,
    winner_rank: winner.rank,
    candidates_count: candidates.length,
    notifications_count: notifications.filter((entry) => entry.status === 'sent' || entry.status === 'dry_run').length,
    skipped_count: notifications.filter((entry) => entry.status === 'skipped').length,
    error_count: notifications.filter((entry) => entry.status === 'error').length,
    created_at: timestamp,
    notifications: notifications.map((entry) => ({
      phone: entry.phone,
      name: entry.name,
      status: entry.status,
      reason: entry.reason ?? null,
      previous_rank: entry.previous_rank ?? null,
      current_rank: entry.current_rank ?? null,
    })),
  }

  await set(runRef, runPayload)
  return { ...runPayload, id: runId }
}
