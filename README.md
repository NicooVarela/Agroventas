# Agroventas Stand

App React para tablet Android horizontal de 10 pulgadas. El flujo principal es:

1. Inicio / espera.
2. Registro de nombre, correo y celular.
3. Reingreso rapido por celular para participantes ya registrados, salteando el perfil.
4. Seleccion de perfil productor.
5. Instruccion breve.
6. Cuenta regresiva.
7. Timer de 60 segundos.
8. Resultado por victoria o tiempo terminado.
9. Reinicio automatico para el siguiente jugador.

## Ejecutar

```bash
npm install
npm run dev -- --host 0.0.0.0
```

La app queda en `http://localhost:5173/`.

## Firebase

Si no hay variables `VITE_FIREBASE_*`, la app funciona en modo local con `localStorage`.

Para conectar Firebase:

1. Crear un proyecto Firebase.
2. Crear Realtime Database.
3. Copiar `.env.example` a `.env`.
4. Completar las variables del proyecto.

La app usa Realtime Database como fuente unica de datos, siguiendo la documentacion del proyecto:

- `sessions/{session_id}`
- `users/{celular}`
- `game_results/{result_id}`
- `notifications/{notif_id}`
- `admin`

El celular normalizado es el identificador unico del usuario.
Los prefijos telefonicos se editan en `src/phonePrefixes.js`. La normalizacion elimina el cero inicial local para todos los paises configurados.

Configurar la sesion activa con:

```txt
VITE_FIREBASE_SESSION_ID=session_001
```

Crear la sesion inicial en Realtime Database:

```json
{
  "sessions": {
    "session_001": {
      "nombre": "Demo ORT - Junio 2025",
      "fecha_inicio": 1781049600000,
      "fecha_fin": null,
      "estado": "activa"
    }
  }
}
```

La senal tecnica de una partida puede quedar registrada en el canal de la sesion activa:

```txt
sessions/{session_id}/live_games/{game_id}
```

El formato de victoria directa para una integracion que conozca el `game_id` es:

```json
{
  "status": "won",
  "updated_at": 1781049600000
}
```

La victoria detectada por el sensor superior llega desde la ESP32 por:

```txt
admin/game_control/finish_signal
```

La web escucha ese canal durante la partida y lo transforma en un resultado ganador para la partida activa. La senal anterior se ignora al comenzar una partida nueva.

La ESP32 fisica no necesita conocer el `game_id`: envia `admin/game_control/finish_signal`. La tablet escucha ambos formatos, corta el timer y guarda el resultado completado en `game_results`.

Cada partida viva registra presencia de tablet:

```txt
sessions/{session_id}/live_games/{game_id}/connection_state
sessions/{session_id}/live_games/{game_id}/tablet_connected
sessions/{session_id}/live_games/{game_id}/heartbeat_at
sessions/{session_id}/live_games/{game_id}/disconnected_at
```

Al iniciar una partida, la app registra `onDisconnect()` en Firebase. Si se corta la luz, se cierra la pestaña o se cae el WiFi, Firebase marca automaticamente:

```txt
connection_state = "disconnected"
tablet_connected = false
disconnected_at = timestamp de servidor
```

Mientras la partida esta activa, la app actualiza `heartbeat_at` cada 5 segundos. Al finalizar normalmente, cancela el `onDisconnect`.

## Admin

La app lee `admin` antes de iniciar cada partida. Si algun control global o componente esta en `false`, no crea la partida.

La ESP32 publica solamente datos crudos en `admin/component_status`. La web es la unica responsable de calcular `admin/components`, `admin/game_control/can_start` y `admin/errors/last_error`.

Estructura:

```json
{
  "admin": {
    "settings": {
      "allow_new_games": true,
      "active_session_id": "session_001",
      "require_component_check": true,
      "interrupted_timeout_ms": 90000
    },
    "components": {
      "sensors": true,
      "controller": true,
      "screen": true,
      "realtime_database": true,
      "power": true
    },
    "game_control": {
      "can_start": true,
      "status": "ready",
      "last_check_at": 1781049600000
    },
    "interrupted_game": {
      "active": false,
      "status": "none",
      "game_id": null,
      "detected_at": null,
      "reason": null
    },
    "errors": {
      "last_error": null
    }
  }
}
```

Para bloquear todas las partidas:

```txt
admin/settings/allow_new_games = false
```

`allow_new_games` es el interruptor general del juego. Si esta en `false`, nadie puede iniciar nuevas partidas.

El panel staff permite cambiar este valor con el boton `Habilitar juego` / `Deshabilitar juego`.

```txt
admin/game_control/can_start = false
```

`can_start` es un bloqueo operativo/manual. Sirve para pausar el inicio por una decision del staff o por una automatizacion puntual, sin apagar la configuracion general del evento.

La feria activa se guarda en:

```txt
admin/settings/active_session_id
```

El panel staff permite crear ferias nuevas en `sessions/{session_id}` y elegir cual queda activa. Ranking, partidas vivas y resultados usan esa feria activa.

Para marcar un componente roto:

```txt
admin/components/sensors = false
```

Si la luz se corta o la tablet se reinicia con una partida en `running`, al iniciar la siguiente partida la app marca la anterior como:

```txt
sessions/{session_id}/live_games/{game_id}/status = "interrupted"
admin/interrupted_game/active = true
```

Si Firebase detecta desconexion por `onDisconnect`, la siguiente revision tambien la registra como:

```txt
admin/interrupted_game/reason = "tablet_disconnected"
```

Si aparece un bloqueo de Admin o hardware mientras la app esta abierta:

1. Se corta el timer y cualquier cuenta regresiva.
2. Si habia una partida activa, se marca como `interrupted`.
3. La app limpia el registro/jugador/estado local.
4. Queda una ventana bloqueante hasta que Firebase vuelva a estar en estado correcto.
5. Cuando se soluciona el error, vuelve a la pantalla de inicio.

## Codigos de error

Los mensajes visibles usan codigos para poder buscarlos en un manual operativo.

```txt
FB-001  No se pudo cargar el ranking.
FB-002  No se pudo guardar el resultado.
FB-003  No se pudo validar el celular.
FB-004  No se pudo iniciar la partida.
FB-005  No se pudo buscar el registro.
FB-006  No se pudo exportar el CSV.
FB-007  No se pudo marcar la partida como interrumpida.
FB-008  No se pudo cargar el panel staff.
FB-009  No se pudo cambiar el estado del juego.
FB-010  No se pudo cambiar la feria activa.
FB-011  No se pudo crear la feria.
ADM-001 El inicio de partidas esta desactivado desde Admin.
ADM-002 El bloqueo operativo global esta activo desde Admin.
ADM-003 Hay componentes con error.
ADM-005 Falta nombre para crear la feria.
```

Si Firebase devuelve un codigo propio, la app lo agrega al final del mensaje.

Reglas sugeridas para Realtime Database:

```json
{
  "rules": {
    "sessions": {
      ".read": true,
      ".write": true
    },
    "users": {
      ".read": true,
      "$celular": {
        ".write": true,
        ".validate": "newData.hasChildren(['nombre', 'email', 'celular', 'perfil_productor'])"
      }
    },
    "game_results": {
      ".read": true,
      ".indexOn": ["session_id"],
      "$result_id": {
        ".write": true,
        ".validate": "newData.hasChildren(['celular', 'session_id', 'tiempo_ms', 'completado_at'])"
      }
    },
    "notifications": {
      ".read": false,
      "$notif_id": {
        ".write": true,
        ".validate": "newData.hasChildren(['celular_destino', 'motivo', 'estado'])"
      }
    },
    "admin": {
      ".read": true,
      ".write": true
    }
  }
}
```

## Ranking

El ranking separado esta en:

```txt
http://localhost:5173/#/ranking
```

Solo entran al ranking los resultados completados. Gana el menor tiempo dentro de la sesion activa. Si alguien vuelve a jugar, se guarda un nuevo registro en `game_results` y se conserva el historial completo.

## WhatsApp ranking

Cuando se guarda una victoria, la app llama a:

```txt
/api/process-ranking-notifications
```

La funcion recalcula el ranking de la sesion activa y detecta participantes que estaban dentro del top 7 y bajaron de puesto por el nuevo resultado.

Por seguridad, el envio real esta apagado por defecto:

```txt
WHATSAPP_DRY_RUN=true
```

En modo dry run no se manda WhatsApp. Solo se registran simulaciones en Firebase:

```txt
admin/whatsapp/notifications/{session_id}
admin/whatsapp/runs/{session_id}
admin/whatsapp/participant_state/{session_id}
```

Limites anti-spam configurables:

```txt
WHATSAPP_COOLDOWN_MS=600000   # minimo 10 minutos entre avisos por usuario
WHATSAPP_DAILY_LIMIT=3        # maximo diario por usuario
WHATSAPP_RUN_LIMIT=3          # maximo por ejecucion
```

Para probar manualmente el calculo sin esperar una partida:

```txt
/api/test-whatsapp-notification
```

Cuando Meta apruebe la plantilla, completar `WHATSAPP_TEMPLATE_LANGUAGE` y cambiar `WHATSAPP_DRY_RUN=false` solo despues de probar los logs.

## Staff

Tocar 5 veces el logo abre el panel de staff. Desde ahi se puede:

- Simular victoria.
- Ver ranking.
- Exportar CSV.
- Borrar datos locales, solo si Firebase no esta configurado.
