import type { VercelRequest, VercelResponse } from '@vercel/node'

type SupabaseConfig = {
  url: string
  key: string
}

type ScoreRow = {
  player_name: string
  highest_level: number
  updated_at: string
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? { url, key } : null
}

async function supabaseFetch(config: SupabaseConfig, path: string) {
  const headers: Record<string, string> = { apikey: config.key }
  if (!config.key.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${config.key}`
  }
  return fetch(`${config.url}${path}`, {
    headers,
  })
}

async function getLeaderboardScores(config: SupabaseConfig) {
  const query = new URLSearchParams({
    select: 'player_name,highest_level,updated_at',
    verified: 'eq.true',
    order: 'highest_level.desc,updated_at.asc',
    limit: '5',
  })
  const result = await supabaseFetch(config, `/rest/v1/leaderboard?${query}`)
  if (!result.ok) throw new Error('Leaderboard read failed')
  const rows = await result.json() as ScoreRow[]
  return rows.map((row) => ({ name: row.player_name, level: row.highest_level, date: row.updated_at }))
}

function sendError(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ error: message })
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return sendError(response, 405, 'Method not allowed')
  }

  const config = getSupabaseConfig()
  if (!config) return sendError(response, 503, 'Leaderboard is not configured')

  try {
    const scores = await getLeaderboardScores(config)
    return response.status(200).json({ scores })
  } catch (error) {
    console.error('Leaderboard read failed', error)
    return sendError(response, 502, 'Could not load the event leaderboard')
  }
}