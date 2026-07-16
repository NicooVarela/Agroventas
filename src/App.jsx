import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Download,
  Mail,
  Medal,
  Settings,
  Smartphone,
  TimerOff,
  UserRound,
} from 'lucide-react'
import './App.css'
import { PHONE_PREFIX_OPTIONS } from './phonePrefixes'
import {
  clearLocalData,
  createGameSession,
  findParticipantByPhone,
  finishGameSession,
  formatTime,
  getAllParticipants,
  getRanking,
  getStaffSettings,
  isFirebaseConfigured,
  interruptGameSession,
  listenAdminHealth,
  listenForHardwareReady,
  listenHomeCalibration,
  listenForVictory,
  listenForPhysicalStart,
  listenRanking,
  normalizeEmail,
  normalizePhone,
  startComponentStatusMonitor,
  signalVictory,
  signalPhysicalStart,
  requestHomeCalibration,
  cancelHomeCalibration,
  setMotorsEnabled,
  startGameHeartbeat,
  createFairSession,
  setActiveSession,
  setGameEnabled,
  upsertParticipantResult,
} from './firebaseClient'

const GAME_DURATION_MS = 60_000
const TIMER_RENDER_INTERVAL_MS = 100
const RESULT_SCREEN_MS = 6_500
const RESET_SCREEN_MS = 3_000
const CONTENT_STORAGE_KEY = 'agroventas.cms_content'
const IS_VISUAL_PREVIEW =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1'
const APP_CONTENT_DEFAULTS = {
  idle: {
    eyebrow: 'Agroventas challenge',
    title: '¿Listo para jugar?',
    subtitle: 'Apretá el botón para arrancar',
  },
  register: {
    title: 'Registrate y a jugar',
    subtitle: 'Ingresá tus datos para el ranking',
    nameLabel: 'Nombre y apellido',
    emailLabel: 'E-mail',
    phoneLabel: 'Celular',
    nextButton: 'Siguiente',
    returningButton: 'Ya estoy registrado',
    stepLabel: 'Paso 1 de 2',
  },
  returning: {
    title: 'Ya te conocemos',
    subtitle: 'Ingresá tu número para jugar nuevamente',
    continueButton: 'Continuar',
    backButton: 'Volver al registro',
    notFound: 'No encontramos ese celular. Registrate por primera vez.',
  },
  profile: {
    title: 'Elegí tu perfil',
    subtitle: 'Tocá la opción que más te representa',
    stepLabel: 'Paso 2 de 2',
    readyButton: 'Listo',
    options: [
      ['Ganadero bovino', 'Cría, recría, invernada', 'cattle'],
      ['Tambero', 'Bovino, ovino, caprino', 'dairy'],
      ['Ovejero y caprino', 'Lana, carne, fibra', 'sheep'],
      ['Productor de granja', 'Cerdos, pollos, huevos, conejos, caballos', 'farm'],
      ['Agricultor', 'Cereales, oleaginosas, arroz', 'crop'],
      ['Horticultor y fruticultor', 'Verduras, frutas, cítricos, vid', 'fruit'],
      ['Apicultor y acuicultor', 'Miel, pesca, cultivo acuático', 'bee'],
      ['Forestador', 'Madera, silvopastoril', 'forest'],
    ],
  },
  instructions: {
    title: '¿Cómo jugar?',
    subtitle: 'Mové las palancas y llevá la pelota hasta el final antes de que se acabe el tiempo.',
    readyButton: 'Apretá el botón para empezar',
  },
  countdown: {
    eyebrow: 'Preparate',
    title: 'El juego arranca en...',
    playNow: '¡A jugar!',
  },
  resultWon: {
    eyebrow: 'Lo lograste',
    title: '¡La rompiste!',
    rankLabel: 'Terminaste en el puesto',
    timeLabel: 'Tu tiempo',
  },
  resultLost: {
    eyebrow: 'Casi lo lográs',
    title: 'Se terminó el tiempo',
    label: 'No completaste el recorrido',
    timeLabel: 'Tiempo',
  },
  resetting: {
    title: 'Listo para el siguiente jugador',
  },
  ranking: {
    title: 'Ranking',
    backButton: 'Volver al juego',
    emptyTitle: 'Todavía no hay tiempos registrados',
  },
  validation: {
    name: 'Ingresá tu nombre y apellido, sin números.',
    email: 'Ingresá un correo válido.',
    phone: 'Ingresá un celular válido para el país seleccionado.',
    duplicatePhone: 'Este celular ya está registrado. Tocá "Ya estoy registrado" para continuar.',
  },
  blocker: {
    title: 'Juego pausado',
    footer: 'Corregí el estado en Firebase Admin para continuar.',
    button: 'Abrir panel staff',
  },
}

const CMS_FIELDS = [
  ['Inicio', 'idle.eyebrow', 'Etiqueta superior'],
  ['Inicio', 'idle.title', 'Título'],
  ['Inicio', 'idle.subtitle', 'Texto'],
  ['Registro', 'register.title', 'Título'],
  ['Registro', 'register.subtitle', 'Texto'],
  ['Registro', 'register.nameLabel', 'Label nombre'],
  ['Registro', 'register.emailLabel', 'Label email'],
  ['Registro', 'register.phoneLabel', 'Label celular'],
  ['Registro', 'register.nextButton', 'Botón siguiente'],
  ['Registro', 'register.returningButton', 'Botón ya registrado'],
  ['Registro', 'register.stepLabel', 'Paso'],
  ['Ya registrado', 'returning.title', 'Título'],
  ['Ya registrado', 'returning.subtitle', 'Texto'],
  ['Ya registrado', 'returning.continueButton', 'Botón continuar'],
  ['Ya registrado', 'returning.backButton', 'Botón volver'],
  ['Perfiles', 'profile.title', 'Título'],
  ['Perfiles', 'profile.subtitle', 'Texto'],
  ['Perfiles', 'profile.stepLabel', 'Paso'],
  ['Perfiles', 'profile.readyButton', 'Botón'],
  ['Instrucciones', 'instructions.title', 'Título'],
  ['Instrucciones', 'instructions.subtitle', 'Texto'],
  ['Instrucciones', 'instructions.readyButton', 'Texto botón físico'],
  ['Cuenta regresiva', 'countdown.eyebrow', 'Etiqueta'],
  ['Cuenta regresiva', 'countdown.title', 'Título'],
  ['Cuenta regresiva', 'countdown.playNow', 'Ya'],
  ['Resultado ganador', 'resultWon.eyebrow', 'Etiqueta'],
  ['Resultado ganador', 'resultWon.title', 'Título'],
  ['Resultado ganador', 'resultWon.rankLabel', 'Label puesto'],
  ['Resultado ganador', 'resultWon.timeLabel', 'Label tiempo'],
  ['Resultado derrota', 'resultLost.eyebrow', 'Etiqueta'],
  ['Resultado derrota', 'resultLost.title', 'Título'],
  ['Resultado derrota', 'resultLost.label', 'Label'],
  ['Resultado derrota', 'resultLost.timeLabel', 'Label tiempo'],
  ['Reinicio', 'resetting.title', 'Título'],
  ['Ranking', 'ranking.title', 'Título'],
  ['Ranking', 'ranking.backButton', 'Botón volver'],
  ['Ranking', 'ranking.emptyTitle', 'Sin resultados'],
  ['Errores', 'validation.name', 'Error nombre'],
  ['Errores', 'validation.email', 'Error email'],
  ['Errores', 'validation.phone', 'Error celular'],
  ['Errores', 'validation.duplicatePhone', 'Celular duplicado'],
  ['Bloqueo global', 'blocker.title', 'Título'],
  ['Bloqueo global', 'blocker.footer', 'Texto final'],
  ['Bloqueo global', 'blocker.button', 'Botón'],
]

const initialForm = {
  name: '',
  email: '',
  phone: '',
}

const screenLabels = {
  idle: 'Inicio',
  register: 'Registro',
  returning: 'Identificación',
  profile: 'Perfil',
  instructions: 'Instrucciones',
  countdown: 'Cuenta regresiva',
  playing: 'Jugando',
  result: 'Resultado',
  resetting: 'Reinicio',
  ranking: 'Ranking',
  cms: 'CMS',
}

function getInitialScreen() {
  if (IS_VISUAL_PREVIEW) {
    const previewScreen = new URLSearchParams(window.location.search).get('screen')
    if (Object.prototype.hasOwnProperty.call(screenLabels, previewScreen)) return previewScreen
  }
  if (window.location.hash === '#/ranking') return 'ranking'
  if (window.location.hash === '#/cms') return 'cms'
  return 'idle'
}

function mergeContent(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base
  if (Array.isArray(base)) return Array.isArray(overrides) ? overrides : base

  return Object.entries(base).reduce((acc, [key, value]) => {
    const overrideValue = overrides[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      acc[key] = mergeContent(value, overrideValue)
      return acc
    }

    acc[key] = overrideValue ?? value
    return acc
  }, {})
}

function readContent() {
  try {
    return mergeContent(APP_CONTENT_DEFAULTS, JSON.parse(localStorage.getItem(CONTENT_STORAGE_KEY)))
  } catch {
    return APP_CONTENT_DEFAULTS
  }
}

function getContentValue(content, path) {
  return path.split('.').reduce((value, key) => value?.[key], content) ?? ''
}

function cloneContent(content) {
  return JSON.parse(JSON.stringify(content))
}

function setContentValue(content, path, nextValue) {
  const nextContent = cloneContent(content)
  const parts = path.split('.')
  let cursor = nextContent
  parts.slice(0, -1).forEach((part) => {
    cursor[part] = cursor[part] ?? {}
    cursor = cursor[part]
  })
  cursor[parts.at(-1)] = nextValue
  return nextContent
}

function buildPhoneWithPrefix(prefix, phone) {
  const prefixDigits = normalizePhone(prefix)
  const phoneDigits = normalizePhone(phone)
  if (!phoneDigits) return ''
  if (phoneDigits.startsWith(`0${prefixDigits}`)) return phoneDigits.slice(1)
  if (phoneDigits.startsWith(prefixDigits)) return phoneDigits
  return `${prefixDigits}${phoneDigits.replace(/^0+/, '')}`
}

function normalizePersonName(name) {
  return name.trim().replace(/\s+/g, ' ')
}

function getLocalPhoneDigits(phone) {
  return normalizePhone(phone).replace(/^0+/, '')
}

function isValidPhone(prefix, phone) {
  const option = PHONE_PREFIX_OPTIONS.find((entry) => entry.code === prefix)
  const localDigits = getLocalPhoneDigits(phone)
  const minLength = option?.minLength ?? 7
  const maxLength = option?.maxLength ?? 12
  const fullPhone = buildPhoneWithPrefix(prefix, phone)
  return (
    localDigits.length >= minLength &&
    localDigits.length <= maxLength &&
    fullPhone.length >= 8 &&
    fullPhone.length <= 15
  )
}

function validateForm(form, phonePrefix = '+598', content = APP_CONTENT_DEFAULTS) {
  const errors = {}
  const normalizedName = normalizePersonName(form.name)
  const nameParts = normalizedName.split(' ').filter(Boolean)
  if (
    normalizedName.length < 5 ||
    normalizedName.length > 80 ||
    nameParts.length < 2 ||
    !/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]+$/.test(normalizedName)
  ) {
    errors.name = content.validation.name
  }
  if (
    form.email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
  ) {
    errors.email = content.validation.email
  }
  if (!isValidPhone(phonePrefix, form.phone)) {
    errors.phone = content.validation.phone
  }
  return errors
}

function msUntil(startedAt) {
  return Date.now() - startedAt
}

function formatError(code, message, error) {
  const detail = error?.code ? ` Firebase: ${error.code}.` : ''
  return `[${code}] ${message}${detail}`
}

function App() {
  const previewResultWon = new URLSearchParams(window.location.search).get('result') !== 'lost'
  const previewParticipant = IS_VISUAL_PREVIEW
    ? {
        name: 'Florencia Pérez',
        email: 'florencia@example.com',
        phone: '59891522077',
        profile: 'Ganadero bovino',
      }
    : null
  const [viewportHeight, setViewportHeight] = useState(() => {
    if (typeof window === 'undefined') return 800
    return window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 800
  })
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [screen, setScreen] = useState(getInitialScreen)
  const [form, setForm] = useState(initialForm)
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_OPTIONS[0].code)
  const [formErrors, setFormErrors] = useState({})
  const [returningPhone, setReturningPhone] = useState('')
  const [returningPhonePrefix, setReturningPhonePrefix] = useState(PHONE_PREFIX_OPTIONS[0].code)
  const [returningError, setReturningError] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')
  const [participant, setParticipant] = useState(previewParticipant)
  const [sessionId, setSessionId] = useState(null)
  const [countdown, setCountdown] = useState(() =>
    IS_VISUAL_PREVIEW && getInitialScreen() === 'countdown' ? 3 : null,
  )
  const [startedAt, setStartedAt] = useState(() =>
    IS_VISUAL_PREVIEW && getInitialScreen() === 'playing' ? Date.now() : null,
  )
  const [elapsedMs, setElapsedMs] = useState(() =>
    IS_VISUAL_PREVIEW && getInitialScreen() === 'result' ? 12_345 : 0,
  )
  const [result, setResult] = useState(() =>
    IS_VISUAL_PREVIEW && getInitialScreen() === 'result'
      ? {
          won: previewResultWon,
          rank: previewResultWon ? 2 : null,
          elapsedMs: previewResultWon ? 12_345 : GAME_DURATION_MS,
          isTopThree: previewResultWon,
          participant: previewParticipant,
        }
      : null,
  )
  const [ranking, setRanking] = useState([])
  const [content, setContent] = useState(readContent)
  const [adminOpen, setAdminOpen] = useState(false)
  const [staffSessions, setStaffSessions] = useState([])
  const [staffActiveSessionId, setStaffActiveSessionId] = useState('')
  const [staffGameEnabled, setStaffGameEnabled] = useState(true)
  const [newSessionName, setNewSessionName] = useState('')
  const [calibrationModalOpen, setCalibrationModalOpen] = useState(false)
  const [calibrationRequestId, setCalibrationRequestId] = useState(null)
  const [calibrationStatus, setCalibrationStatus] = useState('idle')
  const [calibrationDetails, setCalibrationDetails] = useState(null)
  const [calibrationError, setCalibrationError] = useState('')
  const [calibrationBusy, setCalibrationBusy] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [dataMessage, setDataMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [adminHealth, setAdminHealth] = useState({
    blocked: false,
    code: null,
    message: '',
    blockedComponents: [],
  })
  const victoryLockRef = useRef(false)
  const adminBlockedRef = useRef(false)
  const screenRef = useRef(screen)
  const adminHealthRef = useRef(adminHealth)
  const calibrationActiveRef = useRef(false)
  const startedAtRef = useRef(startedAt)
  const elapsedMsRef = useRef(elapsedMs)
  const finishGameRef = useRef(null)
  const resetWaitStartedAtRef = useRef(0)
  const staffTapsRef = useRef(0)
  const staffLastTapAtRef = useRef(0)
  const staffTapTimeoutRef = useRef(null)

  useEffect(() => {
    if (IS_VISUAL_PREVIEW) {
      localStorage.removeItem('agroventas.admin')
    }
    const updateViewportHeight = () => {
      const layoutHeight = window.innerHeight || document.documentElement.clientHeight || 800
      const nextHeight = window.visualViewport?.height || layoutHeight
      const viewportDifference = layoutHeight - nextHeight
      setViewportHeight(nextHeight)
      setKeyboardOpen(viewportDifference > 80 || nextHeight < 520)
      document.documentElement.style.setProperty('--app-height', `${nextHeight}px`)
    }

    updateViewportHeight()
    window.addEventListener('resize', updateViewportHeight)
    window.addEventListener('orientationchange', updateViewportHeight)
    window.visualViewport?.addEventListener('resize', updateViewportHeight)
    return () => {
      window.removeEventListener('resize', updateViewportHeight)
      window.removeEventListener('orientationchange', updateViewportHeight)
      window.visualViewport?.removeEventListener('resize', updateViewportHeight)
    }
  }, [])

  const loadRanking = useCallback(async () => {
    const nextRanking = await getRanking(20)
    setRanking(nextRanking)
  }, [])

  const loadStaffSettings = useCallback(async () => {
    try {
      const settings = await getStaffSettings()
      setStaffSessions(settings.sessions)
      setStaffActiveSessionId(settings.activeSessionId)
      setStaffGameEnabled(settings.allowNewGames)
      setDataMessage('')
    } catch (error) {
      setDataMessage(formatError('FB-008', 'No se pudo cargar el panel staff.', error))
    }
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      setScreen(getInitialScreen())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!adminOpen) return
    const timeout = window.setTimeout(() => {
      loadStaffSettings()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [adminOpen, loadStaffSettings])

  useEffect(() => {
    if (IS_VISUAL_PREVIEW) return undefined

    return listenAdminHealth((nextHealth) => {
      setAdminHealth((currentHealth) => {
        const currentComponents = currentHealth.blockedComponents ?? []
        const nextComponents = nextHealth.blockedComponents ?? []
        const sameComponents =
          currentComponents.length === nextComponents.length &&
          currentComponents.every((component, index) => component === nextComponents[index])
        const unchanged =
          currentHealth.blocked === nextHealth.blocked &&
          currentHealth.code === nextHealth.code &&
          currentHealth.message === nextHealth.message &&
          sameComponents

        return unchanged ? currentHealth : nextHealth
      })
    })
  }, [])

  useEffect(() => {
    if (IS_VISUAL_PREVIEW) return undefined
    setMotorsEnabled(false).catch((error) =>
      setErrorMessage(formatError('FB-013', 'No se pudo inicializar el estado de motores.', error)),
    )
    return undefined
  }, [])

  useEffect(() => {
    screenRef.current = screen
  }, [screen])

  useEffect(() => {
    adminHealthRef.current = adminHealth
  }, [adminHealth])

  useEffect(() => {
    calibrationActiveRef.current =
      calibrationModalOpen &&
      !['completed', 'cancelled', 'timeout', 'rejected_busy', 'error'].includes(calibrationStatus)
  }, [calibrationModalOpen, calibrationStatus])

  useEffect(() => {
    startedAtRef.current = startedAt
  }, [startedAt])

  useEffect(() => {
    elapsedMsRef.current = elapsedMs
  }, [elapsedMs])

  useEffect(() => {
    if (IS_VISUAL_PREVIEW) return undefined
    return startComponentStatusMonitor(() => screenRef.current)
  }, [])

  useEffect(
    () => {
      if (IS_VISUAL_PREVIEW) return undefined
      return listenForPhysicalStart(() => {
        if (calibrationActiveRef.current || adminHealthRef.current.blocked) {
          return false
        }

        if (screenRef.current === 'idle') {
          setScreen('register')
          return true
        }

        if (screenRef.current === 'instructions') {
          setCountdown(3)
          setScreen('countdown')
          return true
        }

        return false
      })
    },
    [],
  )

  const resetKioskToIdle = useCallback(() => {
    setMotorsEnabled(false).catch((error) =>
      setErrorMessage(formatError('FB-013', 'No se pudo apagar los motores.', error)),
    )
    victoryLockRef.current = false
    setForm(initialForm)
    setPhonePrefix(PHONE_PREFIX_OPTIONS[0].code)
    setFormErrors({})
    setReturningPhone('')
    setReturningPhonePrefix(PHONE_PREFIX_OPTIONS[0].code)
    setReturningError('')
    setSelectedProfile('')
    setParticipant(null)
    setSessionId(null)
    setCountdown(null)
    setStartedAt(null)
    setElapsedMs(0)
    setResult(null)
    setErrorMessage('')
    setIsBusy(false)
    setScreen('idle')
  }, [])

  useEffect(() => {
    if (adminHealth.blocked) {
      if (adminBlockedRef.current) return
      const activeSessionId = sessionId
      adminBlockedRef.current = true
      if (activeSessionId) {
        interruptGameSession(activeSessionId, adminHealth.code ?? 'admin_blocked').catch((error) =>
          setErrorMessage(formatError('FB-007', 'No se pudo marcar la partida como interrumpida.', error)),
        )
      }
      resetKioskToIdle()
      return
    }

    if (adminBlockedRef.current) {
      adminBlockedRef.current = false
      resetKioskToIdle()
    }
  }, [adminHealth.blocked, adminHealth.code, resetKioskToIdle, sessionId])

  useEffect(() => {
    if (screen !== 'idle') return undefined

    const timeout = window.setTimeout(() => {
      loadRanking().catch((error) =>
        setErrorMessage(formatError('FB-001', 'No se pudo cargar el ranking.', error)),
      )
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [screen, loadRanking])

  useEffect(() => {
    if (screen !== 'ranking') return undefined

    return listenRanking(
      8,
      setRanking,
      (error) => setErrorMessage(formatError('FB-001', 'No se pudo escuchar el ranking.', error)),
    )
  }, [screen])

  useEffect(() => {
    if (screen !== 'countdown' || IS_VISUAL_PREVIEW) return undefined

    let playTimeout = null
    let cancelled = false
    const steps = [2, 1, 'YA']
    const timeouts = steps.map((step, index) =>
      window.setTimeout(() => {
        if (cancelled || screenRef.current !== 'countdown') return

        setCountdown(step)
        if (step === 'YA') {
          playTimeout = window.setTimeout(async () => {
            if (
              cancelled ||
              screenRef.current !== 'countdown' ||
              adminHealthRef.current.blocked
            ) {
              return
            }

            try {
              await setMotorsEnabled(true)

              if (
                cancelled ||
                screenRef.current !== 'countdown' ||
                adminHealthRef.current.blocked
              ) {
                await setMotorsEnabled(false)
                return
              }

              setStartedAt(Date.now())
              setElapsedMs(0)
              setScreen('playing')
            } catch (error) {
              setErrorMessage(formatError('FB-014', 'No se pudo habilitar los motores.', error))
            }
          }, 780)
        }
      }, (index + 1) * 1000),
    )

    return () => {
      cancelled = true
      timeouts.forEach(window.clearTimeout)
      if (playTimeout !== null) window.clearTimeout(playTimeout)
    }
  }, [screen])

  const completeResetToIdle = useCallback(() => {
    victoryLockRef.current = false
    resetWaitStartedAtRef.current = 0
    setForm(initialForm)
    setPhonePrefix(PHONE_PREFIX_OPTIONS[0].code)
    setFormErrors({})
    setReturningPhone('')
    setReturningPhonePrefix(PHONE_PREFIX_OPTIONS[0].code)
    setReturningError('')
    setSelectedProfile('')
    setParticipant(null)
    setSessionId(null)
    setCountdown(null)
    setStartedAt(null)
    setElapsedMs(0)
    setResult(null)
    setErrorMessage('')
    setScreen('idle')
  }, [])

  const beginResetFlow = useCallback(() => {
    resetWaitStartedAtRef.current = Date.now()
    setMotorsEnabled(false).catch((error) =>
      setErrorMessage(formatError('FB-013', 'No se pudo apagar los motores.', error)),
    )
    setScreen('resetting')
  }, [])

  const finishGame = useCallback(
    async (won, explicitElapsedMs) => {
      if (victoryLockRef.current) return
      victoryLockRef.current = true

      const finalElapsedMs = Math.min(
        GAME_DURATION_MS,
        Math.max(0, explicitElapsedMs ?? elapsedMsRef.current),
      )

      setElapsedMs(finalElapsedMs)
      setResult({
        won,
        rank: null,
        rankLoading: won,
        rankError: false,
        saveError: false,
        elapsedMs: finalElapsedMs,
        isTopThree: false,
        participant,
      })
      setScreen('result')

      try {
        await finishGameSession(sessionId, won ? 'won' : 'lost', finalElapsedMs)

        if (won) {
          const rank = await upsertParticipantResult(participant, finalElapsedMs, true)
          setResult((currentResult) =>
            currentResult
              ? {
                  ...currentResult,
                  rank,
                  rankLoading: false,
                  rankError: rank == null,
                  isTopThree: Boolean(rank && rank <= 3),
                }
              : currentResult,
          )
        }
      } catch (error) {
        setResult((currentResult) =>
          currentResult
            ? {
                ...currentResult,
                rankLoading: false,
                rankError: won,
                saveError: true,
              }
            : currentResult,
        )
        setErrorMessage(formatError('FB-002', 'No se pudo guardar el resultado.', error))
      }
    },
    [participant, sessionId],
  )

  useEffect(() => {
    finishGameRef.current = finishGame
  }, [finishGame])


  useEffect(() => {
    if (!sessionId || IS_VISUAL_PREVIEW) {
      return undefined
    }

    return listenForVictory(sessionId, () => {
      if (screenRef.current !== 'playing') {
        return
      }

      const currentStartedAt = startedAtRef.current
      if (!currentStartedAt) {
        return
      }

      const finalElapsed = msUntil(currentStartedAt)
      finishGameRef.current?.(true, finalElapsed)
    })
  }, [sessionId])

  useEffect(() => {
    if (screen !== 'playing' || !sessionId) return undefined
    return startGameHeartbeat(sessionId)
  }, [screen, sessionId])

  useEffect(() => {
    if (screen !== 'result' || IS_VISUAL_PREVIEW) return undefined
    const timeout = window.setTimeout(() => beginResetFlow(), RESULT_SCREEN_MS)
    return () => window.clearTimeout(timeout)
  }, [beginResetFlow, screen])

  useEffect(() => {
    if (screen !== 'resetting') return undefined

    if (IS_VISUAL_PREVIEW || !isFirebaseConfigured) {
      const timeout = window.setTimeout(completeResetToIdle, RESET_SCREEN_MS)
      return () => window.clearTimeout(timeout)
    }

    return listenForHardwareReady(
      { notBefore: resetWaitStartedAtRef.current },
      (ready) => {
        if (ready && screenRef.current === 'resetting') {
          completeResetToIdle()
        }
      },
      (error) =>
        setErrorMessage(
          formatError('FB-015', 'No se pudo verificar que la máquina quedara lista.', error),
        ),
    )
  }, [completeResetToIdle, screen])

  useEffect(() => {
    if (!calibrationRequestId) return undefined

    return listenHomeCalibration(
      calibrationRequestId,
      (value) => {
        const nextStatus = value?.status ?? 'requested'
        setCalibrationDetails(value)
        setCalibrationStatus(nextStatus)
        setCalibrationError(value?.error ?? '')

        if (nextStatus === 'completed') {
          setDataMessage('Punto inicial configurado correctamente.')
        }
      },
      (error) => {
        setCalibrationStatus('error')
        setCalibrationError(formatError('CAL-002', 'No se pudo seguir la calibración.', error))
      },
    )
  }, [calibrationRequestId])


  const resultStateClass = screen === 'result' && result ? (result.won ? 'result-won' : 'result-lost') : ''
  const showBrandHeader = false
  const profileOptions = content.profile.options

  function updateRegisterField(field, value) {
    const sanitizedValue =
      field === 'phone'
        ? value.replace(/[^\d\s()-]/g, '').slice(0, 24)
        : field === 'name'
          ? value.slice(0, 80)
          : value.slice(0, 254)
    const nextForm = { ...form, [field]: sanitizedValue }
    setForm(nextForm)
    if (formErrors[field]) {
      const nextErrors = validateForm(nextForm, phonePrefix, content)
      setFormErrors((current) => ({ ...current, [field]: nextErrors[field] }))
    }
  }

  function updateRegisterPhonePrefix(nextPrefix) {
    setPhonePrefix(nextPrefix)
    if (formErrors.phone) {
      const nextErrors = validateForm(form, nextPrefix, content)
      setFormErrors((current) => ({ ...current, phone: nextErrors.phone }))
    }
  }

  function updateContentField(path, value) {
    const nextContent = setContentValue(content, path, value)
    setContent(nextContent)
    localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(nextContent))
  }

  function updateProfileContent(index, fieldIndex, value) {
    const nextContent = cloneContent(content)
    nextContent.profile.options[index][fieldIndex] = value
    setContent(nextContent)
    localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(nextContent))
  }

  function resetCmsContent() {
    localStorage.removeItem(CONTENT_STORAGE_KEY)
    setContent(APP_CONTENT_DEFAULTS)
  }

  function handleGlobalStaffTap(event) {
    if (calibrationModalOpen || adminOpen || event.target.closest('.admin-panel')) return

    const tapTime = event.timeStamp
    const isRapidTap = tapTime - staffLastTapAtRef.current < 650
    staffTapsRef.current = isRapidTap ? staffTapsRef.current + 1 : 1
    staffLastTapAtRef.current = tapTime
    window.clearTimeout(staffTapTimeoutRef.current)

    if (staffTapsRef.current >= 5) {
      setAdminOpen(true)
      staffTapsRef.current = 0
      staffLastTapAtRef.current = 0
      return
    }

    staffTapTimeoutRef.current = window.setTimeout(() => {
      staffTapsRef.current = 0
      staffLastTapAtRef.current = 0
    }, 1200)
  }

  async function handleRegisterSubmit(event) {
    event.preventDefault()
    const normalizedForm = {
      name: normalizePersonName(form.name),
      email: normalizeEmail(form.email),
      phone: form.phone.trim(),
    }
    const errors = validateForm(normalizedForm, phonePrefix, content)
    setForm(normalizedForm)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) {
      window.requestAnimationFrame(() => {
        document.querySelector('[aria-invalid="true"]')?.focus()
      })
      return
    }

    setIsBusy(true)
    setErrorMessage('')
    try {
      const fullPhone = buildPhoneWithPrefix(phonePrefix, form.phone)
      const existingParticipant = await findParticipantByPhone(fullPhone)
      if (existingParticipant) {
        setFormErrors({
          phone: content.validation.duplicatePhone,
        })
        return
      }
      setScreen('profile')
    } catch (error) {
      setErrorMessage(formatError('FB-003', 'No se pudo validar el celular.', error))
    } finally {
      setIsBusy(false)
    }
  }

  async function beginGameFor(nextParticipant, setError) {
    setIsBusy(true)
    setErrorMessage('')
    if (setError) setError('')

    try {
      const nextSessionId = await createGameSession(nextParticipant)
      setParticipant(nextParticipant)
      setSessionId(nextSessionId)
      setScreen('instructions')
    } catch (error) {
      const message =
        error.userMessage ?? formatError('FB-004', 'No se pudo iniciar la partida.', error)
      if (setError) setError(message)
      else setErrorMessage(message)
    } finally {
      setIsBusy(false)
    }
  }

  async function handleReturningSubmit(event) {
    event.preventDefault()
    const phoneKey = buildPhoneWithPrefix(returningPhonePrefix, returningPhone)
    if (!isValidPhone(returningPhonePrefix, returningPhone)) {
      setReturningError(content.validation.phone)
      window.requestAnimationFrame(() => {
        document.querySelector('[aria-invalid="true"]')?.focus()
      })
      return
    }

    setIsBusy(true)
    setReturningError('')
    try {
      const existingParticipant = await findParticipantByPhone(phoneKey)
      if (!existingParticipant) {
        setReturningError(content.returning.notFound)
        return
      }

      setForm({
        name: existingParticipant.name ?? '',
        email: existingParticipant.email ?? existingParticipant.id ?? '',
        phone: existingParticipant.phone ?? returningPhone,
      })
      setSelectedProfile(existingParticipant.profile ?? '')
      await beginGameFor(
        {
          name: existingParticipant.name ?? '',
          email: normalizeEmail(existingParticipant.email ?? existingParticipant.id ?? ''),
          emailKey: normalizeEmail(existingParticipant.email ?? existingParticipant.id ?? ''),
          phone: existingParticipant.phone ?? phoneKey,
          profile: existingParticipant.profile ?? '',
        },
        setReturningError,
      )
    } catch (error) {
      setReturningError(formatError('FB-005', 'No se pudo buscar el registro.', error))
    } finally {
      setIsBusy(false)
    }
  }

  async function startCountdown() {
    if (!selectedProfile) return
    const nextParticipant = {
      name: form.name.trim(),
      email: normalizeEmail(form.email),
      emailKey: normalizeEmail(form.email),
      phone: buildPhoneWithPrefix(phonePrefix, form.phone),
      profile: selectedProfile,
    }
    await beginGameFor(nextParticipant)
  }

  async function handleSimulateVictory() {
    if (screen === 'playing') {
      finishGame(true, startedAt ? msUntil(startedAt) : elapsedMs)
      return
    }

    await signalVictory(sessionId)
  }

  async function handleSimulateDefeat() {
    if (screen === 'playing') {
      finishGame(false, GAME_DURATION_MS)
    }
  }

  async function handleStartHomeCalibration() {
    setCalibrationModalOpen(true)
    setCalibrationRequestId(null)
    setCalibrationDetails(null)
    setCalibrationStatus('requesting')
    setCalibrationError('')
    setCalibrationBusy(true)
    setAdminOpen(false)

    try {
      const requestId = await requestHomeCalibration()
      setCalibrationRequestId(requestId)
      setCalibrationStatus('requested')
    } catch (error) {
      setCalibrationStatus('error')
      setCalibrationError(
        error?.userMessage ?? formatError('CAL-001', 'No se pudo iniciar la calibración.', error),
      )
    } finally {
      setCalibrationBusy(false)
    }
  }

  async function handleCancelHomeCalibration() {
    if (!calibrationRequestId) {
      setCalibrationModalOpen(false)
      setCalibrationStatus('idle')
      setCalibrationError('')
      return
    }

    setCalibrationBusy(true)
    try {
      await cancelHomeCalibration(calibrationRequestId)
      setCalibrationStatus('cancelled')
      setCalibrationError('')
    } catch (error) {
      setCalibrationError(formatError('CAL-003', 'No se pudo cancelar la calibración.', error))
    } finally {
      setCalibrationBusy(false)
    }
  }

  function handleCloseHomeCalibration() {
    setCalibrationModalOpen(false)
    setCalibrationRequestId(null)
    setCalibrationDetails(null)
    setCalibrationStatus('idle')
    setCalibrationError('')
  }

  async function handleSimulatePhysicalStart() {
    setIsBusy(true)
    setErrorMessage('')
    try {
      await signalPhysicalStart()
      setAdminOpen(false)
      setDataMessage('Señal de botón físico enviada.')
    } catch (error) {
      setDataMessage(formatError('FB-012', 'No se pudo simular el botón físico.', error))
    } finally {
      setIsBusy(false)
    }
  }

  async function exportCsv() {
    try {
      const participants = await getAllParticipants()
      const rows = participants
        .sort((a, b) => (a.bestTimeMs ?? Infinity) - (b.bestTimeMs ?? Infinity))
        .map((entry) => ({
          nombre: entry.name,
          correo: entry.email,
          celular: entry.phone,
          perfil: entry.profile,
          mejor_tiempo: Number.isFinite(entry.bestTimeMs) ? formatTime(entry.bestTimeMs) : '',
          mejor_tiempo_ms: entry.bestTimeMs ?? '',
          intentos: entry.attempts ?? 0,
          victorias: entry.wins ?? 0,
          ultimo_resultado: entry.lastResult ?? '',
          ultima_partida: entry.lastPlayedAt?.toDate?.().toISOString?.() ?? entry.lastPlayedAt ?? '',
        }))

      const header = Object.keys(rows[0] ?? {
        nombre: '',
        correo: '',
        celular: '',
        perfil: '',
        mejor_tiempo: '',
        mejor_tiempo_ms: '',
        intentos: '',
        victorias: '',
        ultimo_resultado: '',
        ultima_partida: '',
      })
      const csv = [
        header.join(','),
        ...rows.map((row) =>
          header
            .map((key) => `"${String(row[key] ?? '').replaceAll('"', '""')}"`)
            .join(','),
        ),
      ].join('\n')

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `agroventas-registros-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(url)
      setDataMessage('Exportación lista.')
    } catch (error) {
      setDataMessage(formatError('FB-006', 'No se pudo exportar el CSV.', error))
    }
  }

  async function resetLocalData() {
    await clearLocalData()
    await loadRanking()
    setDataMessage('Datos locales borrados.')
  }

  async function handleToggleGameEnabled() {
    const nextEnabled = !staffGameEnabled
    setIsBusy(true)
    try {
      await setGameEnabled(nextEnabled)
      setStaffGameEnabled(nextEnabled)
      setDataMessage(nextEnabled ? 'Juego habilitado.' : 'Juego deshabilitado.')
    } catch (error) {
      setDataMessage(formatError('FB-009', 'No se pudo cambiar el estado del juego.', error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleActiveSessionChange(nextSessionId) {
    if (!nextSessionId) return
    setIsBusy(true)
    try {
      await setActiveSession(nextSessionId)
      setStaffActiveSessionId(nextSessionId)
      await loadRanking()
      setDataMessage('Feria activa actualizada.')
    } catch (error) {
      setDataMessage(formatError('FB-010', 'No se pudo cambiar la feria activa.', error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleCreateSession(event) {
    event.preventDefault()
    setIsBusy(true)
    try {
      const nextSession = await createFairSession(newSessionName)
      setNewSessionName('')
      await loadStaffSettings()
      await loadRanking()
      setDataMessage(`Feria creada: ${nextSession.nombre}.`)
    } catch (error) {
      setDataMessage(error.userMessage ?? formatError('FB-011', 'No se pudo crear la feria.', error))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <main
      className={`app-shell screen-${screen} ${resultStateClass} countdown-${countdown} ${keyboardOpen ? 'keyboard-open' : ''}`}
      style={{ height: viewportHeight, minHeight: viewportHeight }}
      onPointerDownCapture={handleGlobalStaffTap}
    >
      <div className="field-pattern" />
      {showBrandHeader && (
        <header className="stand-header">
          <button className="brand" type="button" aria-label="Agroventas">
          </button>
          <div className="status-pill" aria-hidden="true">
            <span>{screenLabels[screen]}</span>
            <strong>{isFirebaseConfigured ? 'Firebase activo' : 'Modo local'}</strong>
          </div>
        </header>
      )}

      {screen === 'idle' && (
        <section className="screen idle-screen">
          <div className="hero-copy">
            <p className="eyebrow">{content.idle.eyebrow}</p>
            <h1>{content.idle.title}</h1>
            <p>{content.idle.subtitle}</p>
            <PhysicalButtonLoop />
          </div>
        </section>
      )}

      {screen === 'register' && (
        <section className="screen form-screen">
          <div className="form-copy">
            <span className="flow-step">{content.register.stepLabel}</span>
            <h1>{content.register.title}</h1>
            <p>{content.register.subtitle}</p>
          </div>
          <form className="register-form" onSubmit={handleRegisterSubmit} noValidate autoComplete="off">
            <LabelInput
              label={content.register.nameLabel}
              icon={<UserRound size={34} />}
              value={form.name}
              error={formErrors.name}
              onChange={(value) => updateRegisterField('name', value)}
              placeholder="Ej.: María González"
              autoComplete="off"
            />
            <LabelInput
              label={content.register.emailLabel}
              icon={<Mail size={34} />}
              type="email"
              value={form.email}
              error={formErrors.email}
              onChange={(value) => updateRegisterField('email', value)}
              placeholder="nombre@correo.com"
              autoComplete="off"
            />
            <PhoneInput
              label={content.register.phoneLabel}
              icon={<Smartphone size={34} />}
              prefix={phonePrefix}
              onPrefixChange={updateRegisterPhonePrefix}
              value={form.phone}
              error={formErrors.phone}
              onChange={(value) => updateRegisterField('phone', value)}
              placeholder="Ej.: 91 522 077"
              autoComplete="off"
            />
            <button className="primary-action full" type="submit" disabled={isBusy} aria-busy={isBusy}>
              {isBusy ? 'Validando...' : content.register.nextButton}
              <ArrowRight size={34} />
            </button>
            <button
              className="returning-link"
              type="button"
              onClick={() => {
                setReturningPhone('')
                setReturningPhonePrefix(PHONE_PREFIX_OPTIONS[0].code)
                setReturningError('')
                setScreen('returning')
              }}
            >
              {content.register.returningButton}
            </button>
          </form>
        </section>
      )}

      {screen === 'returning' && (
        <section className="screen form-screen returning-screen">
          <div className="form-copy">
            <h1>{content.returning.title}</h1>
            <p>{content.returning.subtitle}</p>
          </div>
          <form className="register-form returning-form" onSubmit={handleReturningSubmit} noValidate autoComplete="off">
            <PhoneInput
              label={content.register.phoneLabel}
              icon={<Smartphone size={34} />}
              prefix={returningPhonePrefix}
              onPrefixChange={(value) => {
                setReturningPhonePrefix(value)
                setReturningError('')
              }}
              value={returningPhone}
              error={returningError}
              onChange={(value) => {
                setReturningPhone(value.replace(/[^\d\s()-]/g, '').slice(0, 24))
                setReturningError('')
              }}
              placeholder="Ej.: 91 522 077"
              autoComplete="off"
            />
            <button className="primary-action full" type="submit" disabled={isBusy} aria-busy={isBusy}>
              {isBusy ? 'Buscando...' : content.returning.continueButton}
              <ArrowRight size={34} />
            </button>
            <button className="returning-link" type="button" onClick={() => setScreen('register')}>
              {content.returning.backButton}
            </button>
          </form>
        </section>
      )}

      {screen === 'profile' && (
        <section className="screen profile-screen">
          <div className="compact-title">
            <span className="flow-step">{content.profile.stepLabel}</span>
            <h1>{content.profile.title}</h1>
            <p>{content.profile.subtitle}</p>
          </div>
          <div className="profile-grid">
            {profileOptions.map(([title, subtitle, icon]) => (
              <button
                className={`profile-option ${selectedProfile === title ? 'selected' : ''}`}
                key={title}
                type="button"
                onClick={() => setSelectedProfile(title)}
              >
                <span className="check-dot">
                  <ProfileIcon type={icon} />
                </span>
                <strong>{title}</strong>
                <small>{subtitle}</small>
              </button>
            ))}
          </div>
          <button
            className="primary-action bottom-action"
            type="button"
            disabled={!selectedProfile || isBusy}
            onClick={startCountdown}
            aria-busy={isBusy}
          >
            {isBusy ? 'Preparando...' : content.profile.readyButton}
            <ArrowRight size={34} />
          </button>
        </section>
      )}

      {screen === 'instructions' && (
        <section className="screen instructions-screen">
          <div className="instruction-panel">
            <MotionGuide />
            <h1>{content.instructions.title}</h1>
            <p>{content.instructions.subtitle}</p>
            <strong className="instruction-physical-cta">{content.instructions.readyButton}</strong>
            <PhysicalButtonLoop />
          </div>
        </section>
      )}

      {screen === 'countdown' && (
        <section className="screen countdown-screen">
          {countdown === 'YA' ? (
            <h1 className="play-now">{content.countdown.playNow}</h1>
          ) : (
            <>
              <p className="eyebrow">{content.countdown.eyebrow}</p>
              <h1>{content.countdown.title}</h1>
              <div className="countdown-orb">
                <span>{countdown}</span>
              </div>
              <div className="countdown-steps" aria-hidden="true">
                <span className={countdown === 3 ? 'active' : ''}>3</span>
                <span className={countdown === 2 ? 'active' : ''}>2</span>
                <span className={countdown === 1 ? 'active' : ''}>1</span>
              </div>
            </>
          )}
        </section>
      )}

      {screen === 'playing' && (
        <section className="screen playing-screen">
          <GameTimer
            startedAt={startedAt}
            onExpired={() => finishGameRef.current?.(false, GAME_DURATION_MS)}
          />
          {(adminOpen || IS_VISUAL_PREVIEW) && (
            <>
              <button className="staff-win" type="button" onClick={handleSimulateVictory}>
                Simular victoria
              </button>
              <button className="staff-lose" type="button" onClick={handleSimulateDefeat}>
                Simular derrota
              </button>
            </>
          )}
        </section>
      )}

      {screen === 'result' && result && (
        <section className={`screen result-screen ${result.won ? 'won' : 'lost'}`}>
          {result.won ? (
            <>
              <p className="eyebrow">{content.resultWon.eyebrow}</p>
              <h1>{content.resultWon.title}</h1>
              <div className="result-card">
                <span className="result-icon-badge" aria-hidden="true">
                  <Medal size={42} />
                </span>
                <span className="result-rank-label">
                  {result.rankLoading
                    ? 'Calculando posición...'
                    : result.rankError
                      ? 'Posición pendiente'
                      : content.resultWon.rankLabel}
                </span>
                <em>{result.rankLoading ? '...' : `¡${result.rank ?? '-'}!`}</em>
                <span className="result-divider" aria-hidden="true" />
                <strong>{result.participant.name}</strong>
                <span className="result-time">{content.resultWon.timeLabel}: {formatTime(result.elapsedMs)}</span>
              </div>
            </>
          ) : (
            <>
              <p className="eyebrow">{content.resultLost.eyebrow}</p>
              <h1>{content.resultLost.title}</h1>
              <div className="result-card lost-result-card">
                <span className="result-icon-badge" aria-hidden="true">
                  <TimerOff size={42} />
                </span>
                <span className="result-rank-label">{content.resultLost.label}</span>
                <em>¡Uy!</em>
                <span className="result-divider" aria-hidden="true" />
                <strong>{result.participant.name}</strong>
                <span className="result-time">{content.resultLost.timeLabel}: {formatTime(result.elapsedMs)}</span>
              </div>
            </>
          )}
        </section>
      )}

      {screen === 'resetting' && (
        <section className="screen resetting-screen">
          <h1>{content.resetting.title}</h1>
        </section>
      )}

      {screen === 'ranking' && (
        <section className="screen ranking-screen">
          <button className="ranking-back" type="button" onClick={() => (window.location.hash = '')}>
            {content.ranking.backButton}
          </button>
          <h1 className="ranking-title">{content.ranking.title}</h1>
          <RankingTable ranking={ranking} emptyTitle={content.ranking.emptyTitle} />
        </section>
      )}

      {screen === 'cms' && (
        <CmsScreen
          content={content}
          onContentChange={updateContentField}
          onProfileChange={updateProfileContent}
          onReset={resetCmsContent}
        />
      )}

      {adminOpen && (
        <div
          className="admin-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="staff-panel-title"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAdminOpen(false)
          }}
        >
          <section className="admin-panel" onPointerDown={(event) => event.stopPropagation()}>
            <div className="admin-header">
              <Settings size={28} />
              <div>
                <p className="eyebrow">Control interno</p>
                <strong id="staff-panel-title">Panel Staff</strong>
              </div>
              <button type="button" onClick={() => setAdminOpen(false)}>
                Cerrar
              </button>
            </div>
            <div className="admin-grid">
              <div className="admin-section">
                <strong>Juego</strong>
                <button
                  type="button"
                  className={staffGameEnabled ? 'danger-button' : ''}
                  onClick={handleToggleGameEnabled}
                  disabled={isBusy}
                >
                  {staffGameEnabled ? 'Deshabilitar juego' : 'Habilitar juego'}
                </button>
              </div>
              <div className="admin-section">
                <strong>Mantenimiento</strong>
                <button
                  type="button"
                  onClick={handleStartHomeCalibration}
                  disabled={isBusy || calibrationBusy || screen !== 'idle'}
                >
                  Configurar punto cero de los NEMA
                </button>
                <small>Colocá la plataforma en la base y confirmá con el botón físico.</small>
              </div>
              <div className="admin-section admin-section-wide">
                <strong>Feria activa</strong>
                <select
                  value={staffActiveSessionId}
                  onChange={(event) => handleActiveSessionChange(event.target.value)}
                  disabled={isBusy || staffSessions.length === 0}
                >
                  {staffSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.nombre ?? session.id}
                    </option>
                  ))}
                </select>
                <form className="admin-inline-form" onSubmit={handleCreateSession}>
                  <input
                    type="text"
                    placeholder="Nueva feria"
                    value={newSessionName}
                    onChange={(event) => setNewSessionName(event.target.value)}
                  />
                  <button type="submit" disabled={isBusy || newSessionName.trim().length < 2}>
                    Crear
                  </button>
                </form>
              </div>
              <div className="admin-actions admin-section-wide">
                <button type="button" onClick={handleSimulateVictory} disabled={screen !== 'playing'}>
                  Marcar victoria
                </button>
                <button type="button" onClick={handleSimulatePhysicalStart} disabled={isBusy}>
                  Simular botón físico
                </button>
                <button type="button" onClick={() => (window.location.hash = '#/ranking')}>
                  Ver ranking
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdminOpen(false)
                    window.location.hash = '#/cms'
                  }}
                >
                  CMS textos
                </button>
                <button type="button" onClick={exportCsv}>
                  <Download size={18} />
                  Exportar CSV
                </button>
                {!isFirebaseConfigured && (
                  <button type="button" className="danger-button" onClick={resetLocalData}>
                    Borrar datos locales
                  </button>
                )}
              </div>
            </div>
            <small className="admin-footer">
              {dataMessage || 'Tocá 5 veces rápido en cualquier lugar para abrir este panel.'}
            </small>
          </section>
        </div>
      )}

      {adminHealth.blocked && (
        <div className="global-blocker" role="alertdialog" aria-modal="true">
          <div className="global-blocker-card">
            <Settings size={58} />
            <p className="eyebrow">{adminHealth.code}</p>
            <h1>{content.blocker.title}</h1>
            <p>{adminHealth.message}</p>
            {adminHealth.blockedComponents.length > 0 && (
              <strong>Revisar: {adminHealth.blockedComponents.join(', ')}</strong>
            )}
            <small>{content.blocker.footer}</small>
            <button type="button" onClick={() => setAdminOpen(true)}>
              {content.blocker.button}
            </button>
          </div>
        </div>
      )}

      {calibrationModalOpen && (
        <div className="global-blocker" role="dialog" aria-modal="true" aria-labelledby="calibration-title">
          <div className="global-blocker-card">
            <Settings size={58} />
            <p className="eyebrow">Mantenimiento</p>
            <h1 id="calibration-title">Configurar punto inicial</h1>

            {['requesting', 'requested'].includes(calibrationStatus) && (
              <>
                <p>Enviando la solicitud a la ESP32 y esperando que la máquina quede bloqueada.</p>
                <strong>No aprietes todavía el botón físico.</strong>
              </>
            )}

            {calibrationStatus === 'waiting_for_button' && (
              <>
                <p>
                  Mové manualmente la plataforma hasta dejarla alineada en su posición inicial.
                </p>
                <strong>Ahora apretá una vez el botón físico del juego.</strong>
                <small>Los LED celestes, violetas y blancos indican que la ESP está esperando.</small>
              </>
            )}

            {calibrationStatus === 'completed' && (
              <>
                <p>Los contadores de ambos NEMA quedaron definidos en la posición 0.</p>
                <strong>Punto inicial guardado correctamente.</strong>
                <small>
                  Motor 1: {calibrationDetails?.motor_1_position ?? 0} · Motor 2:{' '}
                  {calibrationDetails?.motor_2_position ?? 0}
                </small>
              </>
            )}

            {calibrationStatus === 'cancelled' && (
              <p>La calibración fue cancelada. No se modificó el punto cero.</p>
            )}

            {calibrationStatus === 'timeout' && (
              <p>Se agotó el tiempo sin recibir la confirmación del botón físico.</p>
            )}

            {calibrationStatus === 'rejected_busy' && (
              <p>La ESP rechazó la calibración porque la máquina no estaba detenida.</p>
            )}

            {calibrationStatus === 'error' && (
              <p>{calibrationError || 'Ocurrió un error durante la calibración.'}</p>
            )}

            {!['completed', 'cancelled', 'timeout', 'rejected_busy', 'error'].includes(calibrationStatus) ? (
              <button type="button" onClick={handleCancelHomeCalibration} disabled={calibrationBusy}>
                {calibrationBusy ? 'Cancelando...' : 'Cancelar'}
              </button>
            ) : (
              <button type="button" onClick={handleCloseHomeCalibration}>
                Cerrar
              </button>
            )}
          </div>
        </div>
      )}

      {errorMessage && <div className="toast">{errorMessage}</div>}
    </main>
  )
}

function GameTimer({ startedAt, onExpired }) {
  const [visualElapsedMs, setVisualElapsedMs] = useState(0)
  const onExpiredRef = useRef(onExpired)
  const expiredRef = useRef(false)

  useEffect(() => {
    onExpiredRef.current = onExpired
  }, [onExpired])

  useEffect(() => {
    if (!startedAt) return undefined

    expiredRef.current = false

    const updateTimer = () => {
      const nextElapsed = Math.min(msUntil(startedAt), GAME_DURATION_MS)
      setVisualElapsedMs(nextElapsed)

      if (nextElapsed >= GAME_DURATION_MS && !expiredRef.current) {
        expiredRef.current = true
        onExpiredRef.current?.()
      }
    }

    updateTimer()
    const interval = window.setInterval(updateTimer, TIMER_RENDER_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [startedAt])

  const remainingMs = Math.max(0, GAME_DURATION_MS - visualElapsedMs)
  const pressureLevel =
    remainingMs <= 10_000
      ? 'critical-mode'
      : remainingMs <= 15_000
        ? 'urgent-mode'
        : remainingMs <= 30_000
          ? 'warning-mode'
          : ''
  const progress = Math.min(100, (remainingMs / GAME_DURATION_MS) * 100)

  return (
    <div className={`timer-stage ${pressureLevel}`}>
      <div className="timer-wrap" style={{ '--timer-progress': progress / 100 }}>
        <svg className="timer-ring" viewBox="0 0 360 360" aria-hidden="true">
          <defs>
            <linearGradient
              id="timerGradient"
              x1="68"
              y1="292"
              x2="292"
              y2="68"
              gradientUnits="userSpaceOnUse"
            >
              <stop className="timer-stop-a" offset="0%" />
              <stop className="timer-stop-b" offset="52%" />
              <stop className="timer-stop-c" offset="100%" />
            </linearGradient>
          </defs>
          <circle className="timer-ring-track" cx="180" cy="180" r="140" />
          <circle
            className="timer-ring-progress"
            cx="180"
            cy="180"
            r="140"
            pathLength="100"
          />
        </svg>
        <div className="timer">{formatTime(remainingMs)}</div>
      </div>
    </div>
  )
}

function LabelInput({
  label,
  value,
  onChange,
  error,
  icon,
  type = 'text',
  autoFocus = false,
  placeholder = '',
}) {
  const inputId = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const errorId = `${inputId}-error`
  const isEmailField = type === 'email'

  return (
    <label className={`label-input ${error ? 'has-error' : ''}`} htmlFor={inputId}>
      <span>{label}</span>
      <i>{icon}</i>
      <input
        id={inputId}
        autoFocus={autoFocus}
        type={isEmailField ? 'text' : type}
        placeholder={placeholder || label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={keepFocusedFieldVisible}
        autoComplete="new-password"
        inputMode={isEmailField ? 'email' : undefined}
        autoCapitalize={isEmailField ? 'none' : 'words'}
        spellCheck={type !== 'email'}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? errorId : undefined}
      />
      <small id={errorId} className={error ? '' : 'field-hint-empty'} aria-live="polite">
        {error || '\u00a0'}
      </small>
    </label>
  )
}

function PhoneInput({
  label,
  value,
  onChange,
  error,
  icon,
  prefix,
  onPrefixChange,
  autoFocus = false,
  placeholder = '',
}) {
  const inputId = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${prefix.replace(/\D/g, '')}`
  const errorId = `${inputId}-error`
  const selectedCountry = PHONE_PREFIX_OPTIONS.find((option) => option.code === prefix)

  return (
    <label className={`label-input phone-input ${error ? 'has-error' : ''}`} htmlFor={inputId}>
      <span>{label}</span>
      <i>{icon}</i>
      <div className="phone-control">
        <select
          aria-label={`País del celular${selectedCountry ? `: ${selectedCountry.country}` : ''}`}
          value={prefix}
          onChange={(event) => onPrefixChange(event.target.value)}
        >
          {PHONE_PREFIX_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.flag} {option.country}
            </option>
          ))}
        </select>
        <input
          id={inputId}
          autoFocus={autoFocus}
          type="tel"
          placeholder={placeholder || label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={keepFocusedFieldVisible}
          autoComplete="off"
          inputMode="tel"
          enterKeyHint="next"
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <small id={errorId} className={error ? '' : 'field-hint-empty'} aria-live="polite">
        {error || '\u00a0'}
      </small>
    </label>
  )
}

function keepFocusedFieldVisible(event) {
  window.setTimeout(() => {
    event.currentTarget.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }, 120)
}

function ProfileIcon({ type }) {
  const content = {
    cattle: (
      <>
        <path d="M5 14h15c3 0 5 2 5 5v4h-4l-2-4H10l-2 4H5v-9Z" />
        <path d="M21 15l3-5h4l-1 5" />
        <path d="M24 11l3-3" />
        <path d="M8 14 6 10H4" />
        <path d="M11 23v4M19 23v4" />
        <path d="M24 18h2" />
      </>
    ),
    dairy: (
      <>
        <path d="M12 5h8" />
        <path d="M13 5v6l-3 5v11c0 2 2 3 6 3s6-1 6-3V16l-3-5V5" />
        <path d="M10 18h12" />
        <path d="M13 24h6" />
        <path d="M24 11h3v13" />
        <path d="M24 24h5" />
      </>
    ),
    sheep: (
      <>
        <path d="M7 20c0-5 4-8 9-8h6l4 4v6h-5l-2-4h-8l-2 4H7v-2Z" />
        <path d="M22 12l3-4h3" />
        <path d="M11 22v5M20 22v5" />
        <path d="M25 16h2" />
      </>
    ),
    farm: (
      <>
        <path d="M5 28h22" />
        <path d="M7 28V15l9-7 9 7v13" />
        <path d="M12 28v-8h8v8" />
        <path d="M11 14h10" />
        <path d="M16 8V4" />
      </>
    ),
    crop: (
      <>
        <path d="M16 29V8" />
        <path d="M16 18c-5 0-9-4-9-9 5 0 9 4 9 9Z" />
        <path d="M16 15c5 0 9-4 9-9-5 0-9 4-9 9Z" />
        <path d="M16 25c-5 0-9-4-9-9 5 0 9 4 9 9Z" />
        <path d="M16 23c5 0 9-4 9-9-5 0-9 4-9 9Z" />
      </>
    ),
    fruit: (
      <>
        <path d="M16 11c0-4 3-7 7-7-1 5-3 7-7 7Z" />
        <path d="M16 12c-2-3-5-4-8-3" />
        <path d="M9 18c0-4 3-7 7-7s7 3 7 7c0 6-4 11-7 11s-7-5-7-11Z" />
        <path d="M16 11V7" />
      </>
    ),
    bee: (
      <>
        <path d="M10 17c0-4 3-7 6-7s6 3 6 7-3 10-6 10-6-6-6-10Z" />
        <path d="M10 16h12M11 21h10" />
        <path d="M13 10 8 6H5v4l5 5" />
        <path d="M19 10l5-4h3v4l-5 5" />
        <path d="M24 24c2-2 4-2 6 0" />
        <path d="M24 28c2-2 4-2 6 0" />
      </>
    ),
    forest: (
      <>
        <path d="M11 28V17" />
        <path d="M21 28V14" />
        <path d="M11 17 5 23h12l-6-6Z" />
        <path d="M11 10 6 16h10l-5-6Z" />
        <path d="M21 14 15 21h12l-6-7Z" />
        <path d="M21 6 16 13h10l-5-7Z" />
      </>
    ),
  }

  return (
    <svg className={`profile-svg profile-${type}`} viewBox="0 0 32 32" role="presentation" aria-hidden="true">
      {content[type] ?? content.cattle}
    </svg>
  )
}

function MotionGuide() {
  return (
    <div className="motion-guide" aria-hidden="true">
      <svg viewBox="0 0 520 220" role="img">
        <path className="guide-route" d="M120 142 C178 64, 292 54, 386 112" />
        <circle className="guide-start" cx="120" cy="142" r="21" />
        <g className="guide-target">
          <circle cx="386" cy="112" r="34" />
          <path d="M374 100l24 24M398 100l-24 24" />
        </g>
        <circle className="motion-ball" cx="0" cy="0" r="16" />
      </svg>
    </div>
  )
}

function PhysicalButtonLoop() {
  return (
    <div className="physical-button-loop" aria-hidden="true">
      <span className="physical-button-base">
        <span className="physical-button-top" />
      </span>
      <span className="button-ripple ripple-one" />
      <span className="button-ripple ripple-two" />
    </div>
  )
}

function CmsScreen({ content, onContentChange, onProfileChange, onReset }) {
  const groupedFields = CMS_FIELDS.reduce((acc, [section, path, label]) => {
    acc[section] = acc[section] ?? []
    acc[section].push([path, label])
    return acc
  }, {})

  return (
    <section className="screen cms-screen">
      <div className="cms-header">
        <div>
          <p className="eyebrow">Staff</p>
          <h1>CMS local</h1>
          <p>Los cambios se guardan solo en esta tablet. No se escriben en Firebase.</p>
        </div>
        <div className="cms-actions">
          <button type="button" onClick={() => (window.location.hash = '')}>
            Volver al inicio
          </button>
          <button type="button" className="danger-button" onClick={onReset}>
            Restaurar textos
          </button>
        </div>
      </div>

      <div className="cms-grid">
        {Object.entries(groupedFields).map(([section, fields]) => (
          <div className="cms-card" key={section}>
            <h2>{section}</h2>
            {fields.map(([path, label]) => (
              <label className="cms-field" key={path}>
                <span>{label}</span>
                <textarea
                  rows={getContentValue(content, path).length > 48 ? 3 : 1}
                  value={getContentValue(content, path)}
                  onChange={(event) => onContentChange(path, event.target.value)}
                />
              </label>
            ))}
          </div>
        ))}

        <div className="cms-card cms-card-wide">
          <h2>Opciones de perfil productor</h2>
          <div className="cms-profile-grid">
            {content.profile.options.map(([title, subtitle], index) => (
              <div className="cms-profile-row" key={`profile-${index}`}>
                <label className="cms-field">
                  <span>Perfil {index + 1}</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(event) => onProfileChange(index, 0, event.target.value)}
                  />
                </label>
                <label className="cms-field">
                  <span>Descripción</span>
                  <input
                    type="text"
                    value={subtitle}
                    onChange={(event) => onProfileChange(index, 1, event.target.value)}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function RankingTable({ ranking, emptyTitle }) {
  const visibleRanking = ranking.slice(0, 7)
  const previewEntry = ranking[7]

  if (ranking.length === 0) {
    return (
      <div className="ranking-empty">
        <Medal size={72} />
        <h2>{emptyTitle}</h2>
      </div>
    )
  }

  return (
    <div className="ranking-table">
      {visibleRanking.map((entry) => (
        <div className={`ranking-row ranking-row-${entry.rank}`} key={entry.id}>
          <span className="rank-number">{entry.rank}</span>
          <div className="ranking-data ranking-name">
            <strong>{entry.name}</strong>
          </div>
          <div className="ranking-data ranking-time">
            <em>{formatTime(entry.bestTimeMs)}</em>
          </div>
          <div className="ranking-data ranking-category">
            <small>{entry.profile}</small>
          </div>
        </div>
      ))}
      {previewEntry && (
        <div className="ranking-row ranking-row-preview" key={`preview-${previewEntry.id}`} aria-hidden="true">
          <span className="rank-number">{previewEntry.rank}</span>
          <div className="ranking-data ranking-name">
            <strong>{previewEntry.name}</strong>
          </div>
          <div className="ranking-data ranking-time">
            <em>{formatTime(previewEntry.bestTimeMs)}</em>
          </div>
          <div className="ranking-data ranking-category">
            <small>{previewEntry.profile}</small>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
