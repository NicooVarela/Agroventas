import { processRankingNotifications } from './_rankingNotifications.js'

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('Allow', ['GET', 'POST'])
    response.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const result = await processRankingNotifications({
      sessionId: request.query.session_id || request.query.sessionId,
      resultId: request.query.result_id || request.query.resultId,
    })
    response.status(200).json({
      ...result,
      note: 'Ruta de prueba. Respeta WHATSAPP_DRY_RUN y los limites anti-spam.',
    })
  } catch (error) {
    response.status(500).json({
      status: 'error',
      error: error.message,
      details: error.payload ?? null,
    })
  }
}
