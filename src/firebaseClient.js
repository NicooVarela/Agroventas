import { initializeApp } from 'firebase/app'
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  push,
  ref,
  serverTimestamp,
  set,
  update,
} from 'firebase/database'
import { PHONE_COUNTRY_CODES } from './phonePrefixes'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
}

const DEFAULT_SESSION_ID = import.meta.env.VITE_FIREBASE_SESSION_ID || 'session_001'
let activeSessionId = DEFAULT_SESSION_ID

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.appId &&
    firebaseConfig.databaseURL,
)

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null
const realtimeDb = app ? getDatabase(app) : null

const USERS_KEY = 'agroventas.users'
const RESULTS_KEY = 'agroventas.game_results'
const LIVE_GAMES_KEY = 'agroventas.live_games'
const SESSIONS_KEY = 'agroventas.sessions'
const ADMIN_KEY = 'agroventas.admin'
const COMPONENT_TIMEOUT_MS = 5_000
const COMPONENT_CHECK_INTERVAL_MS = 2_000
const REQUIRED_COMPONENTS = [
  'controller',
  'screen',
  'realtime_database',
  'sensors',
  'motors',
  'dispenser',
  'button',
]
const COMPONENT_STATUS_TO_COMPONENT = {
  esp32: 'controller',
  sensors: 'sensors',
  motors: 'motors',
  dispenser: 'dispenser',
  button: 'button',
}

const ADMIN_DEFAULTS = {
  settings: {
    allow_new_games: true,
    active_session_id: DEFAULT_SESSION_ID,
    require_component_check: true,
    interrupted_timeout_ms: 90_000,
  },
  components: {
    sensors: true,
    controller: true,
    screen: true,
    realtime_database: true,
    power: true,
    motors: true,
    dispenser: true,
    button: true,
  },
  component_status: {
    screen: {
      online: true,
      last_seen: null,
      current_screen: null,
    },
  },
  game_control: {
    can_start: true,
    motors_enabled: false,
    status: 'ready',
    last_check_at: null,
    start_signal: {
      active: false,
      request_id: null,
      requested_at: null,
      source: null,
      last_handled_at: null,
      last_ignored_at: null,
      last_ignored_reason: null,
    },
  },
  interrupted_game: {
    active: false,
    status: 'none',
    game_id: null,
    detected_at: null,
    reason: null,
  },
  errors: {
    last_error: null,
  },
}

const ERROR_CODES = {
  ADMIN_NEW_GAMES_DISABLED: 'ADM-001',
  ADMIN_GLOBAL_START_BLOCKED: 'ADM-002',
  ADMIN_COMPONENTS_BLOCKED: 'ADM-003',
  ADMIN_UNAVAILABLE: 'ADM-004',
}

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function now() {
  return Date.now()
}

function dbTimestamp() {
  return isFirebaseConfigured ? serverTimestamp() : now()
}

function processRankingNotifications(sessionId, resultId) {
  if (!isFirebaseConfigured || !resultId) return

  fetch('/api/process-ranking-notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      result_id: resultId,
    }),
  }).catch((error) => {
    console.warn('No se pudo procesar la notificacion de ranking.', error)
  })
}

function getActiveSessionId() {
  return activeSessionId
}

function setCachedActiveSessionId(sessionId) {
  if (sessionId) activeSessionId = sessionId
}

function createSessionId(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug || 'feria'}_${Date.now()}`
}

function toSessionList(sessionsById = {}) {
  return Object.entries(sessionsById)
    .map(([id, session]) => ({ id, ...session }))
    .sort((a, b) => (b.fecha_inicio ?? 0) - (a.fecha_inicio ?? 0))
}

function mergeAdminConfig(config = {}) {
  const admin = {
    ...ADMIN_DEFAULTS,
    ...config,
    settings: { ...ADMIN_DEFAULTS.settings, ...(config.settings ?? {}) },
    components: { ...ADMIN_DEFAULTS.components, ...(config.components ?? {}) },
    component_status: { ...ADMIN_DEFAULTS.component_status, ...(config.component_status ?? {}) },
    game_control: { ...ADMIN_DEFAULTS.game_control, ...(config.game_control ?? {}) },
    interrupted_game: { ...ADMIN_DEFAULTS.interrupted_game, ...(config.interrupted_game ?? {}) },
    errors: { ...ADMIN_DEFAULTS.errors, ...(config.errors ?? {}) },
  }
  setCachedActiveSessionId(admin.settings.active_session_id)
  return admin
}

function getBlockedComponents(components) {
  return Object.entries(components)
    .filter(([, value]) => value !== true)
    .map(([key]) => key)
}

function componentIsAlive(status, referenceTime = now()) {
  return status?.online === true && Number.isFinite(status?.last_seen) && referenceTime - status.last_seen < COMPONENT_TIMEOUT_MS
}

function getComponentHealthFromStatus(componentStatus = {}) {
  const referenceTime = now()
  const components = {
    power: true,
    realtime_database: isFirebaseConfigured,
    screen: componentIsAlive(componentStatus.screen, referenceTime),
  }

  Object.entries(COMPONENT_STATUS_TO_COMPONENT).forEach(([statusKey, componentKey]) => {
    components[componentKey] = componentIsAlive(componentStatus[statusKey], referenceTime)
  })

  REQUIRED_COMPONENTS.forEach((component) => {
    components[component] = components[component] === true
  })

  return components
}

function getRequiredComponentsOk(components) {
  return REQUIRED_COMPONENTS.every((component) => components[component] === true)
}

function getComponentError(components) {
  return REQUIRED_COMPONENTS.filter((component) => components[component] !== true)
}

function createAppError(code, message) {
  const error = new Error(message)
  error.code = code
  error.userMessage = `[${code}] ${message}`
  return error
}

function getAdminHealth(config = ADMIN_DEFAULTS) {
  const admin = mergeAdminConfig(config)
  const blockedComponents = getBlockedComponents(admin.components)

  if (admin.settings.allow_new_games !== true) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_NEW_GAMES_DISABLED,
      message: 'El inicio de partidas está desactivado desde Admin.',
      blockedComponents,
    }
  }

  if (admin.game_control.can_start !== true) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_GLOBAL_START_BLOCKED,
      message: 'El bloqueo operativo global está activo desde Admin.',
      blockedComponents,
    }
  }

  if (admin.settings.require_component_check !== false && blockedComponents.length > 0) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_COMPONENTS_BLOCKED,
      message: `Componentes con error: ${blockedComponents.join(', ')}.`,
      blockedComponents,
    }
  }

  return {
    blocked: false,
    code: null,
    message: '',
    blockedComponents: [],
  }
}

export function normalizeEmail(email) {
  return email.trim().toLowerCase()
}

export function normalizePhone(phone) {
  return phone.replace(/\D/g, '')
}

function getPhoneLookupKeys(phone) {
  const phoneKey = normalizePhone(phone)
  const keys = new Set([phoneKey])

  PHONE_COUNTRY_CODES.forEach((countryCode) => {
    if (phoneKey.startsWith(`${countryCode}0`)) {
      keys.add(`${countryCode}${phoneKey.slice(countryCode.length + 1)}`)
    } else if (phoneKey.startsWith(countryCode) && phoneKey.length > countryCode.length) {
      keys.add(`${countryCode}0${phoneKey.slice(countryCode.length)}`)
    }
  })

  return [...keys].filter(Boolean)
}

function getPhoneGroupingKeys(phone) {
  const phoneKey = normalizePhone(phone)
  const keys = new Set(getPhoneLookupKeys(phoneKey))
  if (!phoneKey) return []

  PHONE_COUNTRY_CODES.forEach((countryCode) => {
    if (phoneKey.startsWith(countryCode) && phoneKey.length > countryCode.length) {
      const localNumber = phoneKey.slice(countryCode.length)
      const localWithoutZero = localNumber.replace(/^0+/, '')
      if (localWithoutZero) {
        keys.add(`${countryCode}${localWithoutZero}`)
        keys.add(`${countryCode}0${localWithoutZero}`)
        keys.add(localWithoutZero)
        keys.add(`0${localWithoutZero}`)
      }
      return
    }

    const localWithoutZero = phoneKey.replace(/^0+/, '')
    if (localWithoutZero) {
      keys.add(localWithoutZero)
      keys.add(`0${localWithoutZero}`)
      keys.add(`${countryCode}${localWithoutZero}`)
      keys.add(`${countryCode}0${localWithoutZero}`)
    }
  })

  return [...keys].filter(Boolean)
}

function getCanonicalPhoneKey(phone, usersByPhone = {}) {
  const phoneKey = normalizePhone(phone)
  const groupingKeys = getPhoneGroupingKeys(phoneKey)
  const countryCode = PHONE_COUNTRY_CODES.find(
    (code) => phoneKey.startsWith(code) && phoneKey.length > code.length,
  )
  if (countryCode) {
    const localWithoutZero = phoneKey.slice(countryCode.length).replace(/^0+/, '')
    return `${countryCode}${localWithoutZero}`
  }

  const storedCountryKey = groupingKeys.find((key) =>
    PHONE_COUNTRY_CODES.some(
      (code) => usersByPhone[key] && key.startsWith(code) && key.length > code.length,
    ),
  )
  if (storedCountryKey) return getCanonicalPhoneKey(storedCountryKey)

  const storedUserKey = groupingKeys.find((key) => usersByPhone[key])
  if (storedUserKey) return storedUserKey

  return phoneKey.replace(/^0+/, '') || phoneKey
}

function getUserByPhoneKey(usersByPhone = {}, phone) {
  const phoneKey = normalizePhone(phone)
  return usersByPhone[phoneKey] ?? getPhoneGroupingKeys(phoneKey).map((key) => usersByPhone[key]).find(Boolean)
}

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '--:--.---'
  const safeMs = Math.max(0, ms)
  const seconds = Math.floor(safeMs / 1000)
  const millis = Math.floor(safeMs % 1000)
  return `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}s`
}

export function listenAdminHealth(callback) {
  if (isFirebaseConfigured) {
    const adminRef = ref(realtimeDb, 'admin')
    const unsubscribe = onValue(
      adminRef,
      (snapshot) => {
        callback(getAdminHealth(snapshot.exists() ? snapshot.val() : ADMIN_DEFAULTS))
      },
      (error) => {
        callback({
          blocked: true,
          code: ERROR_CODES.ADMIN_UNAVAILABLE,
          message: `No se puede verificar el estado de Admin. Firebase: ${error.code ?? 'desconocido'}.`,
          blockedComponents: [],
        })
      },
    )
    return unsubscribe
  }

  callback(getAdminHealth(readLocal(ADMIN_KEY, ADMIN_DEFAULTS)))
  const interval = window.setInterval(() => {
    callback(getAdminHealth(readLocal(ADMIN_KEY, ADMIN_DEFAULTS)))
  }, 1000)
  return () => window.clearInterval(interval)
}

export function startComponentStatusMonitor(getCurrentScreen) {
  const getScreen = typeof getCurrentScreen === 'function' ? getCurrentScreen : () => 'unknown'

  if (isFirebaseConfigured) {
    let latestComponentStatus = {}

    const screenStatusRef = ref(realtimeDb, 'admin/component_status/screen')
    onDisconnect(screenStatusRef).update({
      online: false,
      disconnected_at: serverTimestamp(),
      disconnected_at_client: now(),
    }).catch((error) => console.warn('Could not register screen onDisconnect.', error))

    const writeHealth = async () => {
      const timestamp = now()
      const nextComponentStatus = {
        ...latestComponentStatus,
        screen: {
          online: true,
          last_seen: timestamp,
          current_screen: getScreen(),
        },
      }
      const nextComponents = getComponentHealthFromStatus(nextComponentStatus)
      const allOk = getRequiredComponentsOk(nextComponents)
      const failedComponents = getComponentError(nextComponents)

      const updates = {
        'admin/component_status/screen': nextComponentStatus.screen,
        'admin/components': nextComponents,
        'admin/game_control/can_start': allOk,
        'admin/game_control/status': allOk ? 'ready' : 'component_error',
      }

      if (!allOk) {
        updates['admin/game_control/motors_enabled'] = false
        updates['admin/errors/last_error'] = {
          type: 'component_error',
          detected_at: timestamp,
          failed_components: failedComponents,
        }
      }

      await update(ref(realtimeDb), updates)
    }

    const unsubscribeStatus = onValue(
      ref(realtimeDb, 'admin/component_status'),
      (snapshot) => {
        latestComponentStatus = snapshot.val() ?? {}
        writeHealth().catch((error) => console.warn('Could not update component health.', error))
      },
      (error) => console.warn('Could not read component_status.', error),
    )

    const interval = window.setInterval(() => {
      writeHealth().catch((error) => console.warn('Could not update component heartbeat.', error))
    }, COMPONENT_CHECK_INTERVAL_MS)

    return () => {
      window.clearInterval(interval)
      unsubscribeStatus()
      update(screenStatusRef, {
        online: false,
        last_seen: now(),
        current_screen: getScreen(),
      }).catch((error) => console.warn('Could not mark screen offline.', error))
    }
  }

  const writeLocalHealth = () => {
    const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
    const timestamp = now()
    admin.component_status = {
      ...(admin.component_status ?? {}),
      screen: {
        online: true,
        last_seen: timestamp,
        current_screen: getScreen(),
      },
    }
    admin.components = getComponentHealthFromStatus(admin.component_status)
    const allOk = getRequiredComponentsOk(admin.components)
    admin.game_control.can_start = allOk
    admin.game_control.status = allOk ? 'ready' : 'component_error'
    if (!allOk) {
      admin.game_control.motors_enabled = false
      admin.errors.last_error = {
        type: 'component_error',
        detected_at: timestamp,
        failed_components: getComponentError(admin.components),
      }
    }
    writeLocal(ADMIN_KEY, admin)
  }

  writeLocalHealth()
  const interval = window.setInterval(writeLocalHealth, COMPONENT_CHECK_INTERVAL_MS)
  return () => window.clearInterval(interval)
}

function getStartSignalToken(value) {
  if (!value) return ''
  if (typeof value !== 'object') return String(value)
  return String(
    value.request_id ??
      value.nonce ??
      value.requested_at ??
      value.timestamp ??
      value.updated_at ??
      JSON.stringify(value),
  )
}

async function updateStartSignalStatus(payload) {
  const updates = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [`game_control/start_signal/${key}`, value]),
  )
  await safeAdminUpdate(updates)
}

export function listenForPhysicalStart(callback) {
  if (isFirebaseConfigured) {
    const startRef = ref(realtimeDb, 'admin/game_control/start_signal')
    let lastToken = null
    let initialized = false

    return onValue(startRef, async (snapshot) => {
      const value = snapshot.val()
      const token = getStartSignalToken(value)

      if (!initialized) {
        initialized = true
        lastToken = token
        return
      }

      if (!token) return
      if (token === lastToken) return
      lastToken = token

      const handled = await callback(value)
      await updateStartSignalStatus({
        active: false,
        [handled ? 'last_handled_at' : 'last_ignored_at']: now(),
        last_ignored_reason: handled ? null : 'tablet_not_on_idle_screen',
      })
    })
  }

  let lastToken = null
  let initialized = false
  const interval = window.setInterval(async () => {
    const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
    const value = admin.game_control.start_signal
    const token = getStartSignalToken(value)

    if (!initialized) {
      initialized = true
      lastToken = token
      return
    }

    if (!token) return
    if (token === lastToken) return
    lastToken = token
    const handled = await callback(value)
    await updateStartSignalStatus({
      active: false,
      [handled ? 'last_handled_at' : 'last_ignored_at']: now(),
      last_ignored_reason: handled ? null : 'tablet_not_on_idle_screen',
    })
  }, 250)

  return () => window.clearInterval(interval)
}

export async function signalPhysicalStart(source = 'staff_panel') {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `start_${now()}_${Math.random().toString(16).slice(2)}`

  await safeAdminUpdate({
    'game_control/start_signal/active': true,
    'game_control/start_signal/request_id': requestId,
    'game_control/start_signal/requested_at': now(),
    'game_control/start_signal/source': source,
  })

  return requestId
}

export async function setMotorsEnabled(enabled) {
  await safeAdminUpdate({
    'game_control/motors_enabled': enabled === true,
  })
}

export async function getStaffSettings() {
  const [admin, sessions] = await Promise.all([getAdminConfig(), getSessions()])
  return {
    activeSessionId: getActiveSessionId(),
    allowNewGames: admin.settings.allow_new_games === true,
    sessions,
  }
}

export async function getSessions() {
  if (isFirebaseConfigured) {
    const snapshot = await get(ref(realtimeDb, 'sessions'))
    return toSessionList(snapshot.val() ?? {})
  }

  return toSessionList(readLocal(SESSIONS_KEY, {}))
}

export async function setGameEnabled(enabled) {
  if (isFirebaseConfigured) {
    await update(ref(realtimeDb, 'admin'), {
      'settings/allow_new_games': enabled,
      'game_control/status': enabled ? 'ready' : 'blocked',
    })
    return
  }

  const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
  admin.settings.allow_new_games = enabled
  admin.game_control.status = enabled ? 'ready' : 'blocked'
  writeLocal(ADMIN_KEY, admin)
}

export async function setActiveSession(sessionId) {
  if (!sessionId) return
  setCachedActiveSessionId(sessionId)
  await ensureActiveSession()

  if (isFirebaseConfigured) {
    await update(ref(realtimeDb, 'admin'), {
      'settings/active_session_id': sessionId,
    })
    return
  }

  const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
  admin.settings.active_session_id = sessionId
  writeLocal(ADMIN_KEY, admin)
}

export async function createFairSession(name) {
  const cleanName = name.trim()
  if (!cleanName) throw createAppError('ADM-005', 'Ingresá un nombre para la feria.')

  const sessionId = createSessionId(cleanName)
  const payload = {
    nombre: cleanName,
    fecha_inicio: now(),
    fecha_fin: null,
    estado: 'activa',
  }

  if (isFirebaseConfigured) {
    await set(ref(realtimeDb, `sessions/${sessionId}`), payload)
  } else {
    const sessions = readLocal(SESSIONS_KEY, {})
    sessions[sessionId] = payload
    writeLocal(SESSIONS_KEY, sessions)
  }

  await setActiveSession(sessionId)
  return { id: sessionId, ...payload }
}

function toDbUser(participant) {
  const celular = normalizePhone(participant.phone ?? participant.celular ?? '')
  return {
    nombre: (participant.name ?? participant.nombre ?? '').trim(),
    email: normalizeEmail(participant.email ?? ''),
    celular,
    perfil_productor: participant.profile ?? participant.perfil_productor ?? '',
    created_at: participant.created_at ?? now(),
  }
}

function toAppUser(id, user) {
  return {
    id,
    name: user.nombre ?? '',
    email: user.email ?? '',
    phone: user.celular ?? id,
    profile: user.perfil_productor ?? '',
    nombre: user.nombre ?? '',
    celular: user.celular ?? id,
    perfil_productor: user.perfil_productor ?? '',
    created_at: user.created_at,
  }
}

function toRankingEntry(result, user, rank) {
  return {
    id: result.celular,
    rank,
    resultId: result.id,
    celular: result.celular,
    phone: result.celular,
    name: user?.nombre ?? result.celular,
    email: user?.email ?? '',
    profile: user?.perfil_productor ?? '',
    bestTimeMs: result.tiempo_ms,
    tiempo_ms: result.tiempo_ms,
    puesto_ranking: rank,
    completado_at: result.completado_at,
  }
}

function buildRankingFromData(resultsById = {}, usersByPhone = {}, sessionId = getActiveSessionId(), max = 50) {
  const results = Object.entries(resultsById)
    .map(([id, value]) => ({ id, ...value }))
    .filter((result) => result.session_id === sessionId && Number.isFinite(result.tiempo_ms))

  const bestResults = getBestResultsByParticipant(results, usersByPhone)

  return bestResults
    .slice(0, max)
    .map((result, index) => toRankingEntry(result, getUserByPhoneKey(usersByPhone, result.celular), index + 1))
}

function getBestResultsByParticipant(results, usersByPhone = {}) {
  const groupedResults = new Map()

  results.forEach((result) => {
    const phoneKey = getCanonicalPhoneKey(result.celular, usersByPhone)
    const current = groupedResults.get(phoneKey)
    if (!current || result.tiempo_ms < current.tiempo_ms) {
      groupedResults.set(phoneKey, {
        ...result,
        celular: phoneKey,
        resultId: result.id,
        originalCelular: result.celular,
      })
    }
  })

  return [...groupedResults.values()].sort((a, b) => a.tiempo_ms - b.tiempo_ms)
}

async function ensureActiveSession() {
  const sessionId = getActiveSessionId()

  if (isFirebaseConfigured) {
    const sessionRef = ref(realtimeDb, `sessions/${sessionId}`)
    const snapshot = await get(sessionRef)
    if (!snapshot.exists()) {
      await set(sessionRef, {
        nombre: 'Agroventas Demo',
        fecha_inicio: now(),
        fecha_fin: null,
        estado: 'activa',
      })
    }
    return sessionId
  }

  const sessions = readLocal(SESSIONS_KEY, {})
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      nombre: 'Agroventas Demo',
      fecha_inicio: now(),
      fecha_fin: null,
      estado: 'activa',
    }
    writeLocal(SESSIONS_KEY, sessions)
  }
  return sessionId
}

async function getAdminConfig() {
  if (isFirebaseConfigured) {
    try {
      const adminRef = ref(realtimeDb, 'admin')
      const snapshot = await get(adminRef)
      if (snapshot.exists()) return mergeAdminConfig(snapshot.val())

      await set(adminRef, ADMIN_DEFAULTS)
      return mergeAdminConfig(ADMIN_DEFAULTS)
    } catch (error) {
      console.warn('Admin config unavailable, using local defaults.', error)
      return mergeAdminConfig(ADMIN_DEFAULTS)
    }
  }

  const admin = readLocal(ADMIN_KEY, ADMIN_DEFAULTS)
  writeLocal(ADMIN_KEY, mergeAdminConfig(admin))
  return mergeAdminConfig(admin)
}

async function safeAdminUpdate(payload) {
  if (isFirebaseConfigured) {
    try {
      await update(ref(realtimeDb, 'admin'), payload)
    } catch (error) {
      console.warn('Could not update admin node.', error)
    }
    return
  }

  const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
  Object.entries(payload).forEach(([path, value]) => {
    const parts = path.split('/')
    let cursor = admin
    parts.slice(0, -1).forEach((part) => {
      cursor[part] = cursor[part] ?? {}
      cursor = cursor[part]
    })
    cursor[parts.at(-1)] = value
  })
  writeLocal(ADMIN_KEY, admin)
}

async function assertCanStartGame() {
  const admin = await getAdminConfig()
  const health = getAdminHealth(admin)

  await safeAdminUpdate({
    'game_control/last_check_at': now(),
    'game_control/status': health.blocked ? 'blocked' : 'ready',
  })

  if (health.blocked) throw createAppError(health.code, health.message)
}

async function getCurrentLiveGames(sessionId) {
  if (isFirebaseConfigured) {
    const snapshot = await get(ref(realtimeDb, `sessions/${sessionId}/live_games`))
    return snapshot.val() ?? {}
  }

  return Object.fromEntries(
    Object.entries(readLocal(LIVE_GAMES_KEY, {})).filter(
      ([, game]) => game?.session_id === sessionId,
    ),
  )
}

async function recordInterruptedLiveGame(sessionId) {
  const liveGames = await getCurrentLiveGames(sessionId)
  const [gameId, game] =
    Object.entries(liveGames).find(
      ([, value]) =>
        ['running', 'won'].includes(value?.status) ||
        value?.connection_state === 'disconnected',
    ) ?? []

  if (!gameId || !game) return

  const reason =
    game.connection_state === 'disconnected'
      ? 'tablet_disconnected'
      : game.status === 'won'
        ? 'unfinished_after_victory_signal'
        : 'interrupted_before_finish'
  const detectedAt = now()

  await safeAdminUpdate({
    'interrupted_game/active': true,
    'interrupted_game/status': 'detected',
    'interrupted_game/game_id': gameId,
    'interrupted_game/session_id': sessionId,
    'interrupted_game/celular': game.celular ?? null,
    'interrupted_game/started_at': game.started_at ?? null,
    'interrupted_game/detected_at': detectedAt,
    'interrupted_game/reason': reason,
    'errors/last_error': {
      type: 'interrupted_game',
      game_id: gameId,
      session_id: sessionId,
      detected_at: detectedAt,
      reason,
    },
  })

  if (isFirebaseConfigured) {
    await update(ref(realtimeDb, `sessions/${sessionId}/live_games/${gameId}`), {
      status: 'interrupted',
      interrupted_at: detectedAt,
      interrupted_reason: reason,
      updated_at: detectedAt,
    })
    return
  }

  const storedLiveGames = readLocal(LIVE_GAMES_KEY, {})
  storedLiveGames[gameId] = {
    ...(storedLiveGames[gameId] ?? {}),
    status: 'interrupted',
    interrupted_at: detectedAt,
    interrupted_reason: reason,
    updated_at: detectedAt,
  }
  writeLocal(LIVE_GAMES_KEY, storedLiveGames)
}

async function ensureUser(participant) {
  const user = toDbUser(participant)
  if (!user.celular) throw new Error('Missing participant phone')

  if (isFirebaseConfigured) {
    const userRef = ref(realtimeDb, `users/${user.celular}`)
    const snapshot = await get(userRef)
    if (snapshot.exists()) return toAppUser(user.celular, snapshot.val())

    await set(userRef, user)
    return toAppUser(user.celular, user)
  }

  const users = readLocal(USERS_KEY, {})
  if (!users[user.celular]) {
    users[user.celular] = user
    writeLocal(USERS_KEY, users)
  }
  return toAppUser(user.celular, users[user.celular])
}

async function getSessionResults(sessionId = getActiveSessionId()) {
  if (isFirebaseConfigured) {
    const snapshot = await get(ref(realtimeDb, 'game_results'))
    const results = []
    snapshot.forEach((childSnapshot) => {
      const value = childSnapshot.val()
      if (value?.session_id === sessionId && Number.isFinite(value?.tiempo_ms)) {
        results.push({ id: childSnapshot.key, ...value })
      }
    })
    return results
  }

  return Object.entries(readLocal(RESULTS_KEY, {}))
    .map(([id, value]) => ({ id, ...value }))
    .filter((result) => result.session_id === sessionId && Number.isFinite(result.tiempo_ms))
}

async function getUsersByPhone() {
  if (isFirebaseConfigured) {
    const snapshot = await get(ref(realtimeDb, 'users'))
    return snapshot.val() ?? {}
  }

  return readLocal(USERS_KEY, {})
}

async function refreshRankingPositions(sessionId = getActiveSessionId()) {
  const [results, usersByPhone] = await Promise.all([getSessionResults(sessionId), getUsersByPhone()])
  const bestResults = getBestResultsByParticipant(results, usersByPhone)
  const rankByPhone = bestResults.reduce((acc, result, index) => {
    acc[result.celular] = index + 1
    return acc
  }, {})

  if (isFirebaseConfigured) {
    const updates = {}
    results.forEach((result) => {
      const phoneKey = getCanonicalPhoneKey(result.celular, usersByPhone)
      updates[`game_results/${result.id}/puesto_ranking`] = rankByPhone[phoneKey] ?? null
    })
    if (Object.keys(updates).length > 0) await update(ref(realtimeDb), updates)
  } else {
    const storedResults = readLocal(RESULTS_KEY, {})
    results.forEach((result) => {
      const phoneKey = getCanonicalPhoneKey(result.celular, usersByPhone)
      storedResults[result.id] = {
        ...(storedResults[result.id] ?? {}),
        puesto_ranking: rankByPhone[phoneKey] ?? null,
      }
    })
    writeLocal(RESULTS_KEY, storedResults)
  }

  return bestResults.map((result, index) => ({ ...result, puesto_ranking: index + 1 }))
}

export async function createGameSession(participant) {
  const sessionId = await ensureActiveSession()
  await assertCanStartGame()
  await recordInterruptedLiveGame(sessionId)
  const user = await ensureUser(participant)
  const liveGame = {
    celular: user.phone,
    session_id: sessionId,
    status: 'running',
    connection_state: 'connected',
    tablet_connected: true,
    started_at: dbTimestamp(),
    started_at_client: now(),
    heartbeat_at: dbTimestamp(),
    updated_at: dbTimestamp(),
  }

  if (isFirebaseConfigured) {
    const liveGameRef = push(ref(realtimeDb, `sessions/${sessionId}/live_games`))
    await set(ref(realtimeDb, `sessions/${sessionId}/live_games`), {
      [liveGameRef.key]: liveGame,
    })
    await onDisconnect(liveGameRef).update({
      connection_state: 'disconnected',
      tablet_connected: false,
      disconnected_at: serverTimestamp(),
      disconnected_at_client: now(),
      updated_at: serverTimestamp(),
    })
    return liveGameRef.key
  }

  const id = `local-${crypto.randomUUID()}`
  writeLocal(LIVE_GAMES_KEY, { [id]: { id, ...liveGame } })
  return id
}

export function startGameHeartbeat(gameId) {
  if (!gameId) return () => {}

  if (isFirebaseConfigured) {
    const gameRef = ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`)
    const writeHeartbeat = () =>
      update(gameRef, {
        connection_state: 'connected',
        tablet_connected: true,
        heartbeat_at: serverTimestamp(),
        heartbeat_at_client: now(),
        updated_at: serverTimestamp(),
      }).catch((error) => console.warn('Could not update heartbeat.', error))

    writeHeartbeat()
    const interval = window.setInterval(writeHeartbeat, 5000)
    return () => window.clearInterval(interval)
  }

  const writeHeartbeat = () => {
    const liveGames = readLocal(LIVE_GAMES_KEY, {})
    if (!liveGames[gameId]) return
    liveGames[gameId] = {
      ...liveGames[gameId],
      connection_state: 'connected',
      tablet_connected: true,
      heartbeat_at: now(),
      updated_at: now(),
    }
    writeLocal(LIVE_GAMES_KEY, liveGames)
  }

  writeHeartbeat()
  const interval = window.setInterval(writeHeartbeat, 5000)
  return () => window.clearInterval(interval)
}

export function listenForVictory(gameId, callback) {
  if (isFirebaseConfigured) {
    const gameRef = ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`)
    const unsubscribe = onValue(gameRef, (snapshot) => {
      const value = snapshot.val()
      if (value?.status === 'won') callback(value)
    })
    return unsubscribe
  }

  const interval = window.setInterval(() => {
    const liveGames = readLocal(LIVE_GAMES_KEY, {})
    if (liveGames[gameId]?.status === 'won') callback(liveGames[gameId])
  }, 250)

  return () => window.clearInterval(interval)
}

export async function signalVictory(gameId) {
  if (!gameId) return

  if (isFirebaseConfigured) {
    await update(ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`), {
      status: 'won',
      updated_at: serverTimestamp(),
      updated_at_client: now(),
    })
    return
  }

  const liveGames = readLocal(LIVE_GAMES_KEY, {})
  liveGames[gameId] = {
    ...(liveGames[gameId] ?? {}),
    id: gameId,
    status: 'won',
    updated_at: now(),
  }
  writeLocal(LIVE_GAMES_KEY, liveGames)
}

export async function finishGameSession(gameId, result, elapsedMs) {
  await setMotorsEnabled(false)
  if (!gameId) return

  const payload = {
    status: result === 'won' ? 'finished' : 'lost',
    result,
    elapsed_ms: elapsedMs,
    connection_state: 'connected',
    tablet_connected: true,
    finished_at: dbTimestamp(),
    finished_at_client: now(),
    updated_at: dbTimestamp(),
  }

  if (isFirebaseConfigured) {
    const gameRef = ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`)
    await onDisconnect(gameRef).cancel()
    await update(gameRef, payload)
    return
  }

  const liveGames = readLocal(LIVE_GAMES_KEY, {})
  liveGames[gameId] = { ...(liveGames[gameId] ?? {}), ...payload }
  writeLocal(LIVE_GAMES_KEY, liveGames)
}

export async function interruptGameSession(gameId, reason = 'admin_blocked') {
  await setMotorsEnabled(false)
  if (!gameId) return

  const payload = {
    status: 'interrupted',
    result: 'interrupted',
    interrupted_reason: reason,
    interrupted_at: dbTimestamp(),
    interrupted_at_client: now(),
    connection_state: 'connected',
    tablet_connected: true,
    updated_at: dbTimestamp(),
  }

  if (isFirebaseConfigured) {
    const gameRef = ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`)
    await onDisconnect(gameRef).cancel()
    await update(gameRef, payload)
    await safeAdminUpdate({
      'interrupted_game/active': true,
      'interrupted_game/status': 'detected',
      'interrupted_game/game_id': gameId,
      'interrupted_game/session_id': getActiveSessionId(),
      'interrupted_game/detected_at': now(),
      'interrupted_game/reason': reason,
      'errors/last_error': {
        type: 'interrupted_game',
        game_id: gameId,
        session_id: getActiveSessionId(),
        detected_at: now(),
        reason,
      },
    })
    return
  }

  const liveGames = readLocal(LIVE_GAMES_KEY, {})
  liveGames[gameId] = { ...(liveGames[gameId] ?? {}), ...payload }
  writeLocal(LIVE_GAMES_KEY, liveGames)
}

export async function upsertParticipantResult(participant, elapsedMs, won) {
  const user = await ensureUser(participant)
  if (!won) return null

  const sessionId = await ensureActiveSession()
  const resultPayload = {
    celular: user.phone,
    session_id: sessionId,
    tiempo_ms: elapsedMs,
    puesto_ranking: null,
    completado_at: now(),
  }

  let resultId
  if (isFirebaseConfigured) {
    const resultRef = push(ref(realtimeDb, 'game_results'))
    resultId = resultRef.key
    await set(resultRef, resultPayload)
  } else {
    const results = readLocal(RESULTS_KEY, {})
    resultId = `local-${crypto.randomUUID()}`
    results[resultId] = resultPayload
    writeLocal(RESULTS_KEY, results)
  }

  const rankedResults = await refreshRankingPositions(sessionId)
  const usersByPhone = await getUsersByPhone()
  const participantKey = getCanonicalPhoneKey(user.phone, usersByPhone)
  const rankedResult = rankedResults.find((entry) => entry.id === resultId || entry.celular === participantKey)
  processRankingNotifications(sessionId, resultId)
  return rankedResult?.puesto_ranking ?? null
}

export async function findParticipantByPhone(phone) {
  const phoneKey = normalizePhone(phone)
  if (phoneKey.length < 8) return null
  const lookupKeys = getPhoneLookupKeys(phoneKey)
  const sessionId = getActiveSessionId()

  let participant = null
  if (isFirebaseConfigured) {
    for (const lookupKey of lookupKeys) {
      const snapshot = await get(ref(realtimeDb, `users/${lookupKey}`))
      if (snapshot.exists()) {
        participant = toAppUser(lookupKey, snapshot.val())
        break
      }
    }
  } else {
    const users = readLocal(USERS_KEY, {})
    const lookupKey = lookupKeys.find((key) => users[key])
    participant = lookupKey ? toAppUser(lookupKey, users[lookupKey]) : null
  }

  if (!participant) return null

  const [sessionResults, sessionLiveGames] = await Promise.all([
    getSessionResults(sessionId),
    getCurrentLiveGames(sessionId),
  ])
  const matchesPhone = (candidatePhone) =>
    getPhoneGroupingKeys(participant.phone).includes(normalizePhone(candidatePhone))

  const participatedInSession =
    sessionResults.some((result) => matchesPhone(result.celular)) ||
    Object.values(sessionLiveGames).some((game) => matchesPhone(game?.celular))

  return participatedInSession ? participant : null
}

export async function getParticipantRank(resultId) {
  const ranking = await getRanking(200)
  const index = ranking.findIndex((entry) => entry.resultId === resultId || entry.id === resultId)
  return index === -1 ? null : index + 1
}

export async function getRanking(max = 50) {
  const sessionId = await ensureActiveSession()
  const [results, usersByPhone] = await Promise.all([
    refreshRankingPositions(sessionId),
    getUsersByPhone(),
  ])

  return results
    .sort((a, b) => a.tiempo_ms - b.tiempo_ms)
    .slice(0, max)
    .map((result, index) => toRankingEntry(result, getUserByPhoneKey(usersByPhone, result.celular), index + 1))
}

export function listenRanking(max = 50, callback, onError) {
  if (isFirebaseConfigured) {
    let currentSessionId = getActiveSessionId()
    let resultsById = {}
    let usersByPhone = {}

    const emitRanking = () => {
      callback(buildRankingFromData(resultsById, usersByPhone, currentSessionId, max))
    }

    const adminUnsubscribe = onValue(
      ref(realtimeDb, 'admin/settings/active_session_id'),
      (snapshot) => {
        currentSessionId = snapshot.val() || getActiveSessionId()
        setCachedActiveSessionId(currentSessionId)
        emitRanking()
      },
      onError,
    )

    const resultsUnsubscribe = onValue(
      ref(realtimeDb, 'game_results'),
      (snapshot) => {
        resultsById = snapshot.val() ?? {}
        emitRanking()
      },
      onError,
    )

    const usersUnsubscribe = onValue(
      ref(realtimeDb, 'users'),
      (snapshot) => {
        usersByPhone = snapshot.val() ?? {}
        emitRanking()
      },
      onError,
    )

    return () => {
      adminUnsubscribe()
      resultsUnsubscribe()
      usersUnsubscribe()
    }
  }

  const emitLocalRanking = () => {
    callback(
      buildRankingFromData(
        readLocal(RESULTS_KEY, {}),
        readLocal(USERS_KEY, {}),
        getActiveSessionId(),
        max,
      ),
    )
  }

  emitLocalRanking()
  const interval = window.setInterval(emitLocalRanking, 1000)
  return () => window.clearInterval(interval)
}

export async function getAllParticipants() {
  const [usersByPhone, results] = await Promise.all([getUsersByPhone(), getSessionResults()])
  const groupedResults = results.reduce((acc, result) => {
    const phoneKey = getCanonicalPhoneKey(result.celular, usersByPhone)
    const current = acc[phoneKey] ?? {
      attempts: 0,
      wins: 0,
      bestTimeMs: null,
      lastPlayedAt: null,
    }

    current.attempts += 1
    current.wins += 1
    current.bestTimeMs =
      current.bestTimeMs === null ? result.tiempo_ms : Math.min(current.bestTimeMs, result.tiempo_ms)
    current.lastPlayedAt = Math.max(current.lastPlayedAt ?? 0, result.completado_at ?? 0)
    acc[phoneKey] = current
    return acc
  }, {})

  const groupedUsers = Object.entries(usersByPhone).reduce((acc, [phone, user]) => {
    const phoneKey = getCanonicalPhoneKey(phone, usersByPhone)
    acc[phoneKey] = acc[phoneKey] ?? { phone: phoneKey, user }
    return acc
  }, {})

  return Object.entries(groupedUsers).map(([phone, { user }]) => {
    const resultSummary = groupedResults[phone] ?? {}
    return {
      id: phone,
      name: user.nombre ?? '',
      email: user.email ?? '',
      phone: user.celular ?? phone,
      profile: user.perfil_productor ?? '',
      bestTimeMs: resultSummary.bestTimeMs ?? null,
      attempts: resultSummary.attempts ?? 0,
      wins: resultSummary.wins ?? 0,
      lastResult: resultSummary.wins ? 'won' : '',
      lastPlayedAt: resultSummary.lastPlayedAt ?? '',
    }
  })
}

export async function clearLocalData() {
  localStorage.removeItem(USERS_KEY)
  localStorage.removeItem(RESULTS_KEY)
  localStorage.removeItem(LIVE_GAMES_KEY)
  localStorage.removeItem(SESSIONS_KEY)
}
