import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously } from 'firebase/auth'
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
let realtimeDatabaseConnected = false

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.appId &&
    firebaseConfig.databaseURL,
)

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null
const realtimeDb = app ? getDatabase(app) : null
const firebaseAuth = app ? getAuth(app) : null

// The ESP32 uses anonymous Firebase auth. Keep the web client compatible with
// those rules, while preserving public-rule deployments as a fallback.
const firebaseAuthReady = firebaseAuth
  ? (firebaseAuth.currentUser
      ? Promise.resolve(firebaseAuth.currentUser)
      : signInAnonymously(firebaseAuth).catch((error) => {
          console.warn('Anonymous Firebase auth unavailable; continuing with database rules.', error)
          return null
        }))
  : Promise.resolve(null)

let realtimeConnectionMonitorCleanup = null
let realtimeConnectionMonitorPromise = null
let processedFinishSignalRequestIds = []

async function ensureRealtimeConnectionMonitor() {
  if (!isFirebaseConfigured || !realtimeDb) return
  if (realtimeConnectionMonitorPromise) return realtimeConnectionMonitorPromise

  realtimeConnectionMonitorPromise = (async () => {
    await firebaseAuthReady
    if (!isFirebaseConfigured || !realtimeDb || realtimeConnectionMonitorCleanup) return

    const connectedRef = ref(realtimeDb, '.info/connected')
    realtimeConnectionMonitorCleanup = onValue(
      connectedRef,
      (snapshot) => {
        realtimeDatabaseConnected = snapshot.val() === true
      },
      (error) => {
        realtimeDatabaseConnected = false
        console.warn('Could not monitor realtime connection.', error)
      },
    )
  })()

  return realtimeConnectionMonitorPromise
}

function releaseRealtimeConnectionMonitor() {
  if (realtimeConnectionMonitorCleanup) {
    realtimeConnectionMonitorCleanup()
    realtimeConnectionMonitorCleanup = null
  }
  realtimeConnectionMonitorPromise = null
}

const USERS_KEY = 'agroventas.users'
const RESULTS_KEY = 'agroventas.game_results'
const LIVE_GAMES_KEY = 'agroventas.live_games'
const SESSIONS_KEY = 'agroventas.sessions'
const ADMIN_KEY = 'agroventas.admin'
const COMPONENT_TIMEOUT_MS = 15_000
const RESETTING_COMPONENT_TIMEOUT_MS = 25_000
const COMPONENT_CHECK_INTERVAL_MS = 4_000
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
    components_ok: true,
    manual_block: false,
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
    finish_signal: {
      active: false,
      request_id: null,
      detected_at: null,
      acknowledged_at: null,
      acknowledged_request_id: null,
      handled_by: null,
    },
    home_calibration: {
      active: false,
      request_id: null,
      requested_at: null,
      expires_at: null,
      source: null,
      status: 'idle',
      accepted_at: null,
      acknowledged_request_id: null,
      completed_at: null,
      cancelled_at: null,
      timed_out_at: null,
      responded_at: null,
      handled_by: null,
      motor_1_position: null,
      motor_2_position: null,
      error: null,
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
  CALIBRATION_ACTIVE: 'ADM-006',
  CALIBRATION_NOT_READY: 'CAL-001',
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
  const gameControlConfig = config.game_control ?? {}
  const admin = {
    ...ADMIN_DEFAULTS,
    ...config,
    settings: { ...ADMIN_DEFAULTS.settings, ...(config.settings ?? {}) },
    components: { ...ADMIN_DEFAULTS.components, ...(config.components ?? {}) },
    component_status: { ...ADMIN_DEFAULTS.component_status, ...(config.component_status ?? {}) },
    game_control: {
      ...ADMIN_DEFAULTS.game_control,
      ...gameControlConfig,
      start_signal: {
        ...ADMIN_DEFAULTS.game_control.start_signal,
        ...(gameControlConfig.start_signal ?? {}),
      },
      finish_signal: {
        ...ADMIN_DEFAULTS.game_control.finish_signal,
        ...(gameControlConfig.finish_signal ?? {}),
      },
      home_calibration: {
        ...ADMIN_DEFAULTS.game_control.home_calibration,
        ...(gameControlConfig.home_calibration ?? {}),
      },
    },
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

function componentIsAlive(status, referenceTime = now(), timeoutMs = COMPONENT_TIMEOUT_MS) {
  return (
    status?.online === true &&
    Number.isFinite(status?.last_seen) &&
    referenceTime - status.last_seen < timeoutMs
  )
}

function componentReportsError(status) {
  const state = String(status?.current_state ?? '').trim().toLowerCase()
  return (
    status?.reset_timed_out === true ||
    ['error', 'fault', 'failed', 'offline'].includes(state)
  )
}

function componentIsHealthy(status, referenceTime, timeoutMs) {
  return componentIsAlive(status, referenceTime, timeoutMs) && !componentReportsError(status)
}

function getComponentHealthFromStatus(componentStatus = {}) {
  const referenceTime = now()
  const controllerStatus = componentStatus.esp32 ?? {}
  const controllerState = String(controllerStatus.current_state ?? '').toLowerCase()
  const controllerBusy =
    controllerStatus.resetting === true ||
    [
      'resetting',
      'dispensing',
      'dispensing_close',
      'returning_home',
      'waiting_for_home',
      'calibrating',
      'busy',
    ].includes(controllerState)
  const effectiveTimeoutMs = controllerBusy
    ? RESETTING_COMPONENT_TIMEOUT_MS
    : COMPONENT_TIMEOUT_MS
  const components = {
    power: true,
    realtime_database: realtimeDatabaseConnected,
    screen: componentIsHealthy(componentStatus.screen, referenceTime, effectiveTimeoutMs),
  }

  Object.entries(COMPONENT_STATUS_TO_COMPONENT).forEach(([statusKey, componentKey]) => {
    components[componentKey] = componentIsHealthy(
      componentStatus[statusKey],
      referenceTime,
      effectiveTimeoutMs,
    )
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
  const firebaseAvailable = !isFirebaseConfigured || realtimeDatabaseConnected
  const componentsOk = getRequiredComponentsOk(admin.components)
  const manualBlocked = admin.game_control.manual_block === true

  if (!firebaseAvailable) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_UNAVAILABLE,
      message: 'No se puede verificar el estado de Admin.',
      blockedComponents,
    }
  }

  if (admin.settings.allow_new_games !== true) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_NEW_GAMES_DISABLED,
      message: 'El inicio de partidas está desactivado desde Admin.',
      blockedComponents,
    }
  }

  if (admin.settings.require_component_check !== false && !componentsOk) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_COMPONENTS_BLOCKED,
      message: `Componentes con error: ${blockedComponents.join(', ')}.`,
      blockedComponents,
    }
  }

  if (manualBlocked) {
    return {
      blocked: true,
      code: ERROR_CODES.ADMIN_GLOBAL_START_BLOCKED,
      message: 'El bloqueo operativo global está activo desde Admin.',
      blockedComponents: [],
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
    let unsubscribe = () => {}
    let cancelled = false

    const initialize = async () => {
      await firebaseAuthReady
      if (cancelled) return

      const adminRef = ref(realtimeDb, 'admin')
      unsubscribe = onValue(
        adminRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            callback({
              blocked: true,
              code: ERROR_CODES.ADMIN_UNAVAILABLE,
              message: 'No se puede verificar el estado de Admin.',
              blockedComponents: [],
            })
            return
          }

          callback(getAdminHealth(snapshot.val()))
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
    }

    initialize().catch((error) => {
      callback({
        blocked: true,
        code: ERROR_CODES.ADMIN_UNAVAILABLE,
        message: `No se puede verificar el estado de Admin. Firebase: ${error.code ?? 'desconocido'}.`,
        blockedComponents: [],
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
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
    let latestAdminConfig = mergeAdminConfig(ADMIN_DEFAULTS)
    let healthWriteInProgress = false
    let receivedFirstStatus = false
    let receivedFirstAdmin = false
    let initialHealthWriteTriggered = false
    let cleanup = () => {}
    let cancelled = false

    const initialize = async () => {
      await firebaseAuthReady
      if (cancelled) return
      await ensureRealtimeConnectionMonitor()
      if (cancelled) return

      const screenStatusRef = ref(realtimeDb, 'admin/component_status/screen')
      cleanup = () => {
        window.clearInterval(interval)
        unsubscribeStatus?.()
        unsubscribeAdmin?.()
        update(screenStatusRef, {
          online: false,
          last_seen: now(),
          current_screen: getScreen(),
        }).catch((error) => console.warn('Could not mark screen offline.', error))
      }

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
        const currentAdmin = mergeAdminConfig(latestAdminConfig)
        const currentLastError = currentAdmin.errors?.last_error ?? null
        const manualBlocked = currentAdmin.game_control?.manual_block === true
        const calibrationActive = currentAdmin.game_control?.home_calibration?.active === true
        const componentsOk = allOk
        const canStart =
          currentAdmin.settings.allow_new_games === true &&
          componentsOk &&
          !manualBlocked &&
          !calibrationActive
        const nextStatus = calibrationActive
          ? 'calibrating'
          : manualBlocked
            ? 'blocked'
            : (allOk ? 'ready' : 'component_error')

        let nextLastError = currentLastError
        if (!allOk) {
          const currentFailedComponents = currentLastError?.failed_components ?? []
          const sameFailedComponents =
            currentLastError?.type === 'component_error' &&
            currentFailedComponents.length === failedComponents.length &&
            currentFailedComponents.every((component, index) => component === failedComponents[index])

          if (!sameFailedComponents) {
            nextLastError = {
              type: 'component_error',
              detected_at: timestamp,
              failed_components: failedComponents,
            }
          }
        } else if (nextLastError?.type === 'component_error') {
          nextLastError = null
        }

        const updates = {
          'admin/component_status/screen': nextComponentStatus.screen,
        }
        const componentsChanged = Object.entries(nextComponents).some(
          ([component, value]) => currentAdmin.components?.[component] !== value,
        )

        if (componentsChanged) updates['admin/components'] = nextComponents
        if (currentAdmin.game_control?.components_ok !== componentsOk) {
          updates['admin/game_control/components_ok'] = componentsOk
        }
        if (currentAdmin.game_control?.can_start !== canStart) {
          updates['admin/game_control/can_start'] = canStart
        }
        if (currentAdmin.game_control?.status !== nextStatus) {
          updates['admin/game_control/status'] = nextStatus
        }
        if (JSON.stringify(currentLastError) !== JSON.stringify(nextLastError)) {
          updates['admin/errors/last_error'] = nextLastError
        }
        if (!allOk && currentAdmin.game_control?.motors_enabled !== false) {
          updates['admin/game_control/motors_enabled'] = false
        }

        await update(ref(realtimeDb), updates)
      }

      const safelyWriteHealth = async () => {
        if (healthWriteInProgress) return
        healthWriteInProgress = true

        try {
          await writeHealth()
        } finally {
          healthWriteInProgress = false
        }
      }

      const tryInitialHealthWrite = () => {
        if (!receivedFirstStatus || !receivedFirstAdmin || initialHealthWriteTriggered) return
        initialHealthWriteTriggered = true
        safelyWriteHealth().catch((error) =>
          console.warn('Could not update component health.', error)
        )
      }

      const unsubscribeStatus = onValue(
        ref(realtimeDb, 'admin/component_status'),
        (snapshot) => {
          latestComponentStatus = snapshot.val() ?? {}
          receivedFirstStatus = true
          tryInitialHealthWrite()
        },
        (error) => {
          console.warn('Could not read component_status.', error)
        },
      )

      const unsubscribeAdmin = onValue(
        ref(realtimeDb, 'admin'),
        (snapshot) => {
          latestAdminConfig = snapshot.exists()
            ? mergeAdminConfig(snapshot.val())
            : mergeAdminConfig(ADMIN_DEFAULTS)
          receivedFirstAdmin = true
          tryInitialHealthWrite()
        },
        (error) => {
          console.warn('Could not read admin configuration.', error)
        },
      )

      const interval = window.setInterval(() => {
        safelyWriteHealth().catch((error) =>
          console.warn('Could not update component health.', error)
        )
      }, COMPONENT_CHECK_INTERVAL_MS)
    }

    initialize().catch((error) => console.warn('Could not initialize component status monitor.', error))

    return () => {
      cancelled = true
      cleanup()
      releaseRealtimeConnectionMonitor()
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
    const currentLastError = admin.errors?.last_error
    const manualBlocked = admin.game_control?.manual_block === true
    const calibrationActive = admin.game_control?.home_calibration?.active === true
    const componentsOk = allOk
    const canStart =
      admin.settings.allow_new_games === true &&
      componentsOk &&
      !manualBlocked &&
      !calibrationActive
    admin.game_control.components_ok = componentsOk
    admin.game_control.can_start = canStart
    admin.game_control.status = calibrationActive
      ? 'calibrating'
      : manualBlocked
        ? 'blocked'
        : (allOk ? 'ready' : 'component_error')
    let nextLastError = currentLastError ?? null
    if (!allOk) {
      nextLastError = {
        type: 'component_error',
        detected_at: timestamp,
        failed_components: getComponentError(admin.components),
      }
    } else if (nextLastError?.type === 'component_error') {
      nextLastError = null
    }
    admin.errors.last_error = nextLastError
    if (!allOk) {
      admin.game_control.motors_enabled = false
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
  let cleanup = () => {}
  let cancelled = false

  const initialize = async () => {
    await firebaseAuthReady
    if (cancelled) return

    if (isFirebaseConfigured) {
      const startRef = ref(realtimeDb, 'admin/game_control/start_signal')
      let lastToken = null
      let initialized = false

      cleanup = onValue(startRef, async (snapshot) => {
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
      return
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

    cleanup = () => window.clearInterval(interval)
  }

  initialize().catch((error) => console.warn('Could not initialize physical start listener.', error))

  return () => {
    cancelled = true
    cleanup()
  }
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


function getCalibrationRequestId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `calibration_${crypto.randomUUID()}`
    : `calibration_${now()}_${Math.random().toString(16).slice(2)}`
}

function calibrationMachineIsReady(admin) {
  const referenceTime = now()
  const controller = admin.component_status?.esp32 ?? {}
  const motors = admin.component_status?.motors ?? {}
  const dispenser = admin.component_status?.dispenser ?? {}
  const controllerState = String(controller.current_state ?? '').toLowerCase()
  const motorsState = String(motors.current_state ?? '').toLowerCase()
  const dispenserState = String(dispenser.current_state ?? '').toLowerCase()
  const allowedControllerState = ['idle', 'finished', 'error'].includes(controllerState)

  return (
    allowedControllerState &&
    controller.resetting !== true &&
    admin.game_control?.motors_enabled !== true &&
    admin.game_control?.home_calibration?.active !== true &&
    componentIsAlive(controller, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    componentIsAlive(motors, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    componentIsAlive(dispenser, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    motorsState !== 'enabled' &&
    !['returning_home', 'resetting', 'dispensing'].includes(motorsState) &&
    !['open', 'closing', 'busy'].includes(dispenserState)
  )
}

export async function requestHomeCalibration() {
  const admin = await getAdminConfig()

  if (!calibrationMachineIsReady(admin)) {
    throw createAppError(
      ERROR_CODES.CALIBRATION_NOT_READY,
      'La máquina debe estar detenida y sin un retorno o dispensado en curso.',
    )
  }

  const requestId = getCalibrationRequestId()
  const requestedAt = now()

  await safeAdminUpdate({
    'game_control/motors_enabled': false,
    'game_control/can_start': false,
    'game_control/status': 'calibrating',
    'game_control/home_calibration/active': true,
    'game_control/home_calibration/request_id': requestId,
    'game_control/home_calibration/requested_at': requestedAt,
    'game_control/home_calibration/expires_at': requestedAt + 60_000,
    'game_control/home_calibration/source': 'dev_panel',
    'game_control/home_calibration/status': 'requested',
    'game_control/home_calibration/accepted_at': null,
    'game_control/home_calibration/acknowledged_request_id': null,
    'game_control/home_calibration/completed_at': null,
    'game_control/home_calibration/cancelled_at': null,
    'game_control/home_calibration/timed_out_at': null,
    'game_control/home_calibration/responded_at': null,
    'game_control/home_calibration/handled_by': null,
    'game_control/home_calibration/motor_1_position': null,
    'game_control/home_calibration/motor_2_position': null,
    'game_control/home_calibration/error': null,
  })

  return requestId
}

export async function cancelHomeCalibration(requestId) {
  if (!requestId) return

  await safeAdminUpdate({
    'game_control/home_calibration/active': false,
    'game_control/home_calibration/request_id': requestId,
    'game_control/home_calibration/status': 'cancelled',
    'game_control/home_calibration/cancelled_at': now(),
    'game_control/home_calibration/error': 'cancelled_from_dev_panel',
  })
}

export function listenHomeCalibration(requestId, callback, onError) {
  if (!requestId) return () => {}

  if (isFirebaseConfigured) {
    let unsubscribe = () => {}
    let cancelled = false

    const initialize = async () => {
      await firebaseAuthReady
      if (cancelled) return

      unsubscribe = onValue(
        ref(realtimeDb, 'admin/game_control/home_calibration'),
        (snapshot) => {
          const value = snapshot.val() ?? {}
          if (value.request_id !== requestId) return
          callback(value)
        },
        onError,
      )
    }

    initialize().catch((error) => onError?.(error))

    return () => {
      cancelled = true
      unsubscribe()
    }
  }

  const emitLocal = () => {
    const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
    const value = admin.game_control.home_calibration ?? {}
    if (value.request_id === requestId) callback(value)
  }

  emitLocal()
  const interval = window.setInterval(emitLocal, 300)
  return () => window.clearInterval(interval)
}

function hardwareCycleIsReady(componentStatus = {}, notBefore = 0) {
  const referenceTime = now()
  const controller = componentStatus.esp32 ?? {}
  const motors = componentStatus.motors ?? {}
  const dispenser = componentStatus.dispenser ?? {}
  const controllerState = String(controller.current_state ?? '').toLowerCase()
  const motorsState = String(motors.current_state ?? '').toLowerCase()
  const dispenserState = String(dispenser.current_state ?? '').toLowerCase()
  const freshestRequiredHeartbeat = Math.min(
    Number(controller.last_seen) || 0,
    Number(motors.last_seen) || 0,
    Number(dispenser.last_seen) || 0,
  )

  return (
    freshestRequiredHeartbeat >= notBefore &&
    componentIsHealthy(controller, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    componentIsHealthy(motors, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    componentIsHealthy(dispenser, referenceTime, RESETTING_COMPONENT_TIMEOUT_MS) &&
    controller.resetting !== true &&
    controller.reset_timed_out !== true &&
    ['idle', 'finished'].includes(controllerState) &&
    motorsState === 'ready' &&
    dispenserState === 'ready'
  )
}

export function listenForHardwareReady(options, callback, onError) {
  const notBefore = Number(options?.notBefore) || 0

  if (isFirebaseConfigured) {
    let unsubscribe = () => {}
    let cancelled = false

    const initialize = async () => {
      await firebaseAuthReady
      if (cancelled) return

      unsubscribe = onValue(
        ref(realtimeDb, 'admin/component_status'),
        (snapshot) => {
          callback(hardwareCycleIsReady(snapshot.val() ?? {}, notBefore))
        },
        onError,
      )
    }

    initialize().catch((error) => onError?.(error))

    return () => {
      cancelled = true
      unsubscribe()
    }
  }

  const checkLocalStatus = () => {
    const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
    callback(hardwareCycleIsReady(admin.component_status ?? {}, notBefore))
  }

  checkLocalStatus()
  const interval = window.setInterval(checkLocalStatus, 500)
  return () => window.clearInterval(interval)
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
  const payload = {
    'settings/allow_new_games': enabled === true,
    'game_control/manual_block': false,
    'game_control/status': enabled ? 'ready' : 'blocked',
  }

  if (isFirebaseConfigured) {
    await safeAdminUpdate(payload)
    return
  }

  const admin = mergeAdminConfig(readLocal(ADMIN_KEY, ADMIN_DEFAULTS))
  admin.settings.allow_new_games = enabled === true
  admin.game_control.manual_block = false
  admin.game_control.status = enabled ? 'ready' : 'blocked'
  writeLocal(ADMIN_KEY, admin)
}

export async function setActiveSession(sessionId) {
  if (!sessionId) return
  setCachedActiveSessionId(sessionId)
  await ensureActiveSession()

  if (isFirebaseConfigured) {
    await safeAdminUpdate({
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
    await firebaseAuthReady
    try {
      const adminRef = ref(realtimeDb, 'admin')
      const snapshot = await get(adminRef)
      if (snapshot.exists()) return mergeAdminConfig(snapshot.val())

      throw createAppError(ERROR_CODES.ADMIN_UNAVAILABLE, 'No se puede verificar el estado de Admin.')
    } catch (error) {
      if (error?.code === ERROR_CODES.ADMIN_UNAVAILABLE) throw error
      console.warn('Admin config unavailable.', error)
      throw createAppError(ERROR_CODES.ADMIN_UNAVAILABLE, 'No se puede verificar el estado de Admin.')
    }
  }

  const admin = readLocal(ADMIN_KEY, ADMIN_DEFAULTS)
  writeLocal(ADMIN_KEY, mergeAdminConfig(admin))
  return mergeAdminConfig(admin)
}

async function safeAdminUpdate(payload) {
  if (isFirebaseConfigured) {
    try {
      await firebaseAuthReady
      await update(ref(realtimeDb, 'admin'), payload)
      return true
    } catch (error) {
      console.warn('Could not update admin node.', error)
      throw error
    }
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
  return true
}

async function assertCanStartGame() {
  const admin = await getAdminConfig()
  const health = getAdminHealth(admin)
  const calibrationActive = admin.game_control?.home_calibration?.active === true

  await safeAdminUpdate({
    'game_control/last_check_at': now(),
    'game_control/status': calibrationActive
      ? 'calibrating'
      : (health.blocked ? 'blocked' : 'ready'),
  })

  if (calibrationActive) {
    throw createAppError(
      ERROR_CODES.CALIBRATION_ACTIVE,
      'El punto inicial se está configurando. Esperá a que termine la calibración.',
    )
  }

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

async function getRankedSessionResults(sessionId = getActiveSessionId()) {
  const [results, usersByPhone] = await Promise.all([
    getSessionResults(sessionId),
    getUsersByPhone(),
  ])
  const rankedResults = getBestResultsByParticipant(results, usersByPhone)
    .map((result, index) => ({ ...result, puesto_ranking: index + 1 }))

  return { rankedResults, usersByPhone }
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
    await set(liveGameRef, liveGame)
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
  let cleanup = () => {}
  let cancelled = false

  const initialize = async () => {
    await firebaseAuthReady
    if (cancelled) return

    if (isFirebaseConfigured) {
      const gameRef = ref(realtimeDb, `sessions/${getActiveSessionId()}/live_games/${gameId}`)
      const finishSignalRef = ref(realtimeDb, 'admin/game_control/finish_signal')
      let latestGame = null
      let latestFinishSignal = null
      let ackInProgress = false
      let finishSignalInitialized = false
      let initialFinishSignalRequestId = null
      let initialFinishSignalWasActive = false
      let finishSignalObservedAfterInitialization = false
      const deliveredHardwareRequestIds = new Set()
      let gameStatusVictoryDelivered = false

      const deliverHardwareVictory = (value, requestId) => {
        if (deliveredHardwareRequestIds.has(requestId)) return
        deliveredHardwareRequestIds.add(requestId)
        callback({ ...value, status: 'won', hardware_signal: true })
      }

      const finishSignalBelongsToCurrentGame = (value) => {
        const detectedAt = Number(value?.detected_at)
        const gameStartedAt = Number(latestGame?.started_at_client)

        if (!Number.isFinite(gameStartedAt)) return false

        // When the ESP32 has NTP time, compare both Unix timestamps directly.
        if (Number.isFinite(detectedAt) && detectedAt > 1_000_000_000_000) {
          return detectedAt >= gameStartedAt - 2_000
        }

        // Before NTP synchronizes, the ESP32 can temporarily report millis().
        // In that case, only trust a request observed after the listener's
        // initial Firebase snapshot, which prevents accepting an old stale signal.
        return finishSignalObservedAfterInitialization
      }

      const processLatestFinishSignal = async () => {
        const value = latestFinishSignal
        if (cancelled || ackInProgress || !value?.active) return

        const requestId = value?.request_id ?? value?.requestId ?? null
        if (!requestId) return
        if (value?.acknowledged_request_id === requestId) return
        if (!finishSignalBelongsToCurrentGame(value)) return

        deliverHardwareVictory(value, requestId)
        ackInProgress = true

        try {
          await safeAdminUpdate({
            'game_control/finish_signal/active': false,
            'game_control/finish_signal/acknowledged_at': now(),
            'game_control/finish_signal/acknowledged_request_id': requestId,
            'game_control/finish_signal/handled_by': 'web',
            'game_control/finish_signal/detected_at': value?.detected_at ?? now(),
            'game_control/finish_signal/request_id': requestId,
          })

          processedFinishSignalRequestIds = [
            ...processedFinishSignalRequestIds.filter((id) => id !== requestId),
            requestId,
          ].slice(-20)
        } catch (error) {
          // Do not mark it as processed. The interval below retries the ACK.
          console.warn('Could not acknowledge finish signal; retrying.', error)
        } finally {
          ackInProgress = false
        }
      }

      const unsubscribeGame = onValue(
        gameRef,
        (snapshot) => {
          latestGame = snapshot.val()

          if (latestGame?.status === 'won' && !gameStatusVictoryDelivered) {
            gameStatusVictoryDelivered = true
            callback(latestGame)
          }

          processLatestFinishSignal().catch((error) =>
            console.warn('Could not process finish signal.', error),
          )
        },
        (error) => console.warn('Could not listen to live game.', error),
      )

      const unsubscribeFinishSignal = onValue(
        finishSignalRef,
        (snapshot) => {
          latestFinishSignal = snapshot.val()
          const requestId =
            latestFinishSignal?.request_id ?? latestFinishSignal?.requestId ?? null

          if (!finishSignalInitialized) {
            finishSignalInitialized = true
            initialFinishSignalRequestId = requestId
            initialFinishSignalWasActive = latestFinishSignal?.active === true
          } else if (
            requestId &&
            (
              requestId !== initialFinishSignalRequestId ||
              (!initialFinishSignalWasActive && latestFinishSignal?.active === true)
            )
          ) {
            finishSignalObservedAfterInitialization = true
          }

          processLatestFinishSignal().catch((error) =>
            console.warn('Could not process finish signal.', error),
          )
        },
        (error) => console.warn('Could not listen to finish signal.', error),
      )

      const retryInterval = window.setInterval(() => {
        processLatestFinishSignal().catch((error) =>
          console.warn('Could not retry finish signal acknowledgment.', error),
        )
      }, 1_000)

      cleanup = () => {
        window.clearInterval(retryInterval)
        unsubscribeGame()
        unsubscribeFinishSignal()
      }
      return
    }

    let victoryDelivered = false
    const interval = window.setInterval(() => {
      const liveGames = readLocal(LIVE_GAMES_KEY, {})
      if (liveGames[gameId]?.status === 'won' && !victoryDelivered) {
        victoryDelivered = true
        callback(liveGames[gameId])
      }
    }, 250)

    cleanup = () => window.clearInterval(interval)
  }

  initialize().catch((error) => console.warn('Could not initialize victory listener.', error))

  return () => {
    cancelled = true
    cleanup()
  }
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

  const { rankedResults, usersByPhone } = await getRankedSessionResults(sessionId)
  const participantKey = getCanonicalPhoneKey(user.phone, usersByPhone)
  const rankedResult = rankedResults.find((entry) => entry.celular === participantKey)
  const rank = rankedResult?.puesto_ranking ?? null

  if (rank != null) {
    if (isFirebaseConfigured) {
      await update(ref(realtimeDb, `game_results/${resultId}`), {
        puesto_ranking: rank,
      })
    } else {
      const results = readLocal(RESULTS_KEY, {})
      results[resultId] = {
        ...(results[resultId] ?? resultPayload),
        puesto_ranking: rank,
      }
      writeLocal(RESULTS_KEY, results)
    }
  }

  processRankingNotifications(sessionId, resultId)
  return rank
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
  const { rankedResults, usersByPhone } = await getRankedSessionResults(sessionId)

  return rankedResults
    .slice(0, max)
    .map((result, index) =>
      toRankingEntry(
        result,
        getUserByPhoneKey(usersByPhone, result.celular),
        index + 1,
      ),
    )
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
