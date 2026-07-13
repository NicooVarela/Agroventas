import { processRankingNotifications } from './_rankingNotifications.js'

function parseBody(request) {
  if (!request.body) return {}
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body)
    } catch {
      return {}
    }
  }
  return request.body
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', ['POST'])
    response.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const body = parseBody(request)
    const result = await processRankingNotifications({
      sessionId: body.session_id || body.sessionId,
      resultId: body.result_id || body.resultId,
    })
    response.status(200).json(result)
  } catch (error) {
    response.status(500).json({
      status: 'error',
      error: error.message,
      details: error.payload ?? null,
    })
  }
}
