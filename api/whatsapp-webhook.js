const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'agroventas_wpp_verify_2026'

export default function handler(request, response) {
  if (request.method === 'GET') {
    const mode = request.query['hub.mode']
    const token = request.query['hub.verify_token']
    const challenge = request.query['hub.challenge']

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      response.status(200).send(challenge)
      return
    }

    response.status(403).send('Forbidden')
    return
  }

  if (request.method === 'POST') {
    response.status(200).json({ received: true })
    return
  }

  response.setHeader('Allow', ['GET', 'POST'])
  response.status(405).send('Method Not Allowed')
}
