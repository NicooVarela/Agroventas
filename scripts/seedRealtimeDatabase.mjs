import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { get, getDatabase, ref, update } from 'firebase/database'

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
  databaseURL: process.env.VITE_FIREBASE_DATABASE_URL,
}

const requiredConfig = ['apiKey', 'projectId', 'appId', 'databaseURL']
const missingConfig = requiredConfig.filter((key) => !firebaseConfig[key])

if (missingConfig.length > 0) {
  console.error(`Faltan variables de Firebase: ${missingConfig.join(', ')}`)
  console.error('Ejecutá el script cargando el mismo archivo .env que usa Vite.')
  process.exit(1)
}

const sessionId = process.env.VITE_FIREBASE_SESSION_ID || 'session_001'
const resetControl = process.argv.includes('--reset-control')
const timestamp = Date.now()

const initialData = {
  admin: {
    settings: {
      allow_new_games: true,
      active_session_id: sessionId,
      require_component_check: true,
      interrupted_timeout_ms: 90_000,
    },
    components: {
      sensors: false,
      controller: false,
      screen: false,
      realtime_database: false,
      power: true,
      motors: false,
      dispenser: false,
      button: false,
    },
    component_status: {
      screen: {
        online: false,
        last_seen: 0,
        current_screen: 'offline',
      },
    },
    game_control: {
      can_start: false,
      components_ok: false,
      manual_block: false,
      motors_enabled: false,
      status: 'component_error',
      last_check_at: 0,
      start_signal: {
        active: false,
        request_id: '',
        requested_at: 0,
        source: '',
        last_handled_at: 0,
        last_ignored_at: 0,
        last_ignored_reason: '',
      },
      finish_signal: {
        active: false,
        request_id: '',
        detected_at: 0,
        acknowledged_at: 0,
        acknowledged_request_id: '',
        handled_by: '',
      },
      home_calibration: {
        active: false,
        request_id: '',
        requested_at: 0,
        expires_at: 0,
        source: '',
        status: 'idle',
        accepted_at: 0,
        acknowledged_request_id: '',
        completed_at: 0,
        cancelled_at: 0,
        timed_out_at: 0,
        responded_at: 0,
        handled_by: '',
        motor_1_position: 0,
        motor_2_position: 0,
        error: '',
      },
    },
    interrupted_game: {
      active: false,
      status: 'none',
      game_id: '',
      session_id: sessionId,
      detected_at: 0,
      reason: '',
    },
  },
  sessions: {
    [sessionId]: {
      nombre: 'Agroventas Demo',
      fecha_inicio: timestamp,
      fecha_fin: 0,
      estado: 'activa',
    },
  },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function collectMissingUpdates(existing, defaults, prefix = '', updates = {}) {
  Object.entries(defaults).forEach(([key, defaultValue]) => {
    const path = prefix ? `${prefix}/${key}` : key
    const existingValue = existing?.[key]

    if (existingValue === undefined || existingValue === null) {
      updates[path] = defaultValue
      return
    }

    if (isPlainObject(defaultValue) && isPlainObject(existingValue)) {
      collectMissingUpdates(existingValue, defaultValue, path, updates)
    }
  })

  return updates
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const database = getDatabase(app)

try {
  await signInAnonymously(auth)

  const rootReference = ref(database)
  const snapshot = await get(rootReference)
  const existingData = snapshot.val() ?? {}
  const updates = collectMissingUpdates(existingData, initialData)

  if (resetControl) {
    Object.assign(updates, {
      'admin/game_control/can_start': false,
      'admin/game_control/components_ok': false,
      'admin/game_control/motors_enabled': false,
      'admin/game_control/status': 'component_error',
      'admin/game_control/start_signal/active': false,
      'admin/game_control/finish_signal/active': false,
      'admin/game_control/home_calibration/active': false,
      'admin/game_control/home_calibration/status': 'idle',
      'admin/game_control/home_calibration/request_id': '',
      'admin/game_control/home_calibration/acknowledged_request_id': '',
      'admin/game_control/home_calibration/error': '',
    })
  }

  if (Object.keys(updates).length === 0) {
    console.log('La base ya contiene toda la estructura necesaria. No se modificó nada.')
  } else {
    await update(rootReference, updates)
    console.log(`Firebase actualizado correctamente. Rutas escritas: ${Object.keys(updates).length}`)
  }

  console.log(`Sesión activa configurada: ${sessionId}`)
  console.log(
    resetControl
      ? 'Los controles operativos también fueron reiniciados.'
      : 'Los datos existentes fueron preservados; solo se agregaron rutas faltantes.',
  )
} catch (error) {
  console.error('No se pudo inicializar Realtime Database.')
  console.error(error)
  process.exitCode = 1
}
