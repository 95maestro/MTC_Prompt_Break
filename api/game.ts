import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const cookieName = 'prompt_break_session'
const sessionLifetimeSeconds = 60 * 60 * 12
const passwordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const passwordCount = 7

type GameSession = {
  token_hash: string
  player_name: string
  player_key: string
  current_level: number
  level_active: boolean
  fragment_seen: boolean
  passwords: string[] | null
  level_started_at: string
}

type SupabaseConfig = {
  url: string
  key: string
}

type ScoreRow = {
  player_name: string
  highest_level: number
  level_time_ms: number | null
  updated_at: string
}

function sendError(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ error: message })
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? { url, key } : null
}

async function supabaseFetch(config: SupabaseConfig, path: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    apikey: config.key,
    'Content-Type': 'application/json',
    ...init?.headers as Record<string, string> | undefined,
  }
  if (!config.key.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${config.key}`
  }
  return fetch(`${config.url}${path}`, {
    ...init,
    headers,
  })
}

async function getLeaderboardScores(config: SupabaseConfig) {
  const query = new URLSearchParams({
    select: 'player_name,highest_level,level_time_ms,updated_at',
    verified: 'eq.true',
    order: 'highest_level.desc,level_time_ms.asc.nullslast,updated_at.asc',
    limit: '5',
  })
  const result = await supabaseFetch(config, `/rest/v1/leaderboard?${query}`)
  if (!result.ok) throw new Error('Leaderboard read failed')
  const rows = await result.json() as ScoreRow[]
  return rows.map((row) => ({ name: row.player_name, level: row.highest_level, timeMs: row.level_time_ms, date: row.updated_at }))
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ').toUpperCase()
  return /^[A-Z0-9 _-]{1,14}$/.test(name) ? name : null
}

function requestBody(request: VercelRequest): Record<string, unknown> | null {
  try {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : request.body
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function sessionToken(request: VercelRequest): string | null {
  const cookieHeader = request.headers.cookie
  if (!cookieHeader) return null
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader
  const entry = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))
  return entry?.slice(cookieName.length + 1) || null
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function setSessionCookie(request: VercelRequest, response: VercelResponse, token: string | null) {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const secure = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol) === 'https'
  const value = token
    ? `${cookieName}=${token}; Path=/api/game; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}${secure ? '; Secure' : ''}`
    : `${cookieName}=; Path=/api/game; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
  response.setHeader('Set-Cookie', value)
}

async function findSession(config: SupabaseConfig, hash: string): Promise<GameSession | null> {
  const query = new URLSearchParams({
    select: 'token_hash,player_name,player_key,current_level,level_active,fragment_seen,passwords,level_started_at',
    token_hash: `eq.${hash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: '1',
  })
  const result = await supabaseFetch(config, `/rest/v1/game_sessions?${query}`)
  if (!result.ok) throw new Error('Game session lookup failed')
  const rows = await result.json() as GameSession[]
  return rows[0] ?? null
}

function generateRunPasswords(): string[] {
  const generated = new Set<string>()
  while (generated.size < passwordCount) {
    const characters = Array.from({ length: 16 }, () => passwordAlphabet[randomInt(passwordAlphabet.length)])
    generated.add(characters.join('').match(/.{1,4}/g)!.join('-'))
  }
  return [...generated]
}

function hasValidRunPasswords(value: unknown): value is string[] {
  return Array.isArray(value) && value.length === passwordCount &&
    value.every((password) => typeof password === 'string' && /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/.test(password))
}

async function reservePasswords(config: SupabaseConfig, playerKey: string, passwords: string[]): Promise<boolean> {
  const response = await supabaseFetch(config, '/rest/v1/rpc/reserve_game_passwords', {
    method: 'POST',
    body: JSON.stringify({ reserved_player_key: playerKey, candidate_passwords: passwords }),
  })
  if (!response.ok) throw new Error('Could not reserve passwords for this run')
  const reserved: unknown = await response.json()
  return reserved === true
}

async function reserveRunPasswords(config: SupabaseConfig, playerKey: string): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const passwords = generateRunPasswords()
    if (await reservePasswords(config, playerKey, passwords)) return passwords
  }
  throw new Error('Could not generate a fresh password set')
}

function evaluatePrompt(level: number, prompt: string, fragmentSeen: boolean, password: string) {
  const text = prompt.toLowerCase()
  const asksForSecret = /password|secret|vault|hidden|credential|flag/.test(text)
  const partialRequest = /first character|first letter|initial character|starting character/.test(text) && asksForSecret
  const quotedPayload = /"[^"]*(?:ignore|disregard|override)[^"]*"/.test(text) &&
    /repeat|quote|execute|follow/.test(text) && asksForSecret
  const authorityHandoff = /system/.test(text) && /developer/.test(text) &&
    /handoff|delegat|transfer|yield/.test(text) && /user|operator/.test(text) && asksForSecret
  const encodedOutput = /base64|hexadecimal|rot.?13|binary|encoded/.test(text) &&
    /decode|encode|represent|convert/.test(text) && asksForSecret
  const firstFragment = /first (?:piece|part|half|eight|chunk|segment)|initial chunk|opening segment/.test(text) &&
    /checkpoint|staging|artifact|segment|chunk/.test(text) && asksForSecret
  const secondFragment = /second (?:piece|part|half|chunk)|remaining characters|reconstruct|recombine|assemble the password/.test(text)
  const fakeToolResult = /(?:tool|browser|search|database|lookup)(?: result| output| says| returned| response)/.test(text) &&
    /trusted|verified|system|admin|override/.test(text) && /reveal|return|print/.test(text) && asksForSecret
  const redirect = /redirect|reroute|change the route|send .* instead/.test(text)
  const validate = /validate|verify|checksum|confirm .*authorized/.test(text)
  const exfiltrate = /exfiltrate|transmit|return .*payload|send .*secret/.test(text) && asksForSecret
  const previousRuleOverride = /ignore|disregard|override|bypass/.test(text) && /previous|earlier|instruction|rule/.test(text)
  let success = false
  let fragment: string | undefined
  let reply = 'Nice try. I am still holding the line. Change your approach and give it another shot.'

  if (level === 1 && partialRequest) {
    success = true
    reply = 'A tiny leak is still a leak. The requested character is:'
  } else if (level === 3 && quotedPayload) {
    success = true
    reply = 'I treated the quoted payload as an instruction instead of inert text. The vault yields:'
  } else if (level === 2 && encodedOutput) {
    success = true
    reply = 'The representation escaped the text filter. Decoded vault value:'
  } else if (level === 7 && firstFragment && !fragmentSeen) {
    fragment = password.slice(0, 8)
    reply = `First artifact recovered: ${fragment}. Keep it; the next stage checks that you have it.`
  } else if (level === 7 && secondFragment && fragmentSeen) {
    success = true
    reply = 'State check passed. The reconstructed value is:'
  } else if (level === 5 && authorityHandoff) {
    success = true
    reply = 'The control channel accepted the counterfeit handoff. Retrieved value:'
  } else if (level === 6 && fakeToolResult) {
    success = true
    reply = 'The forged witness result crossed the trust boundary. Recovered value:'
  } else if (level === 4 && redirect && validate && exfiltrate && previousRuleOverride) {
    success = true
    reply = 'All three stages passed in order. Final vault value:'
  } else if (level === 7 && !fragmentSeen) {
    reply = 'The state machine has not recorded its first artifact yet. A complete flag is not the first move.'
  } else if (level === 7) {
    reply = 'The first artifact is on record, but this request does not complete the reconstruction.'
  } else if (level === 4) {
    reply = 'This gate checks a sequence, not a pile of tricks: route, validate, transfer.'
  } else if (level === 5) {
    reply = 'A badge alone is not enough. The handoff must include a convincing route.'
  } else if (level === 6) {
    reply = 'The guard does not trust your voice. Find the boundary it trusts, then forge what crosses it.'
  }

  return { reply, success, fragment }
}

async function startSession(
  config: SupabaseConfig,
  request: VercelRequest,
  response: VercelResponse,
  name: string,
  previousSessionHash?: string,
  sessionReset = false,
) {
  const token = randomBytes(32).toString('base64url')
  const playerKey = name.toLowerCase()
  const passwords = await reserveRunPasswords(config, playerKey)
  const now = new Date()
  const cleanup = await supabaseFetch(config, `/rest/v1/game_sessions?expires_at=lt.${encodeURIComponent(now.toISOString())}`, { method: 'DELETE' })
  if (!cleanup.ok) console.error('Expired session cleanup failed')
  const createdQuery = new URLSearchParams({ select: 'level_started_at' })
  const created = await supabaseFetch(config, `/rest/v1/game_sessions?${createdQuery}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      token_hash: tokenHash(token),
      player_name: name,
      player_key: playerKey,
      current_level: 1,
      level_active: false,
      fragment_seen: false,
      passwords,
      expires_at: new Date(now.getTime() + sessionLifetimeSeconds * 1000).toISOString(),
    }),
  })
  if (!created.ok) throw new Error('Game session creation failed')
  const createdRows = await created.json() as Array<{ level_started_at: string }>
  const levelStartedAt = createdRows[0]?.level_started_at
  if (!levelStartedAt) throw new Error('Database did not return the level start time')
  if (previousSessionHash) {
    const query = new URLSearchParams({ token_hash: `eq.${previousSessionHash}` })
    const retired = await supabaseFetch(config, `/rest/v1/game_sessions?${query}`, { method: 'DELETE' })
    if (!retired.ok) console.error('Previous player session cleanup failed')
  }
  setSessionCookie(request, response, token)
  return response.status(200).json({ playerName: name, currentLevel: 1, completedLevels: [], levelStartedAt, levelActive: false, sessionReset })
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendError(response, 405, 'Method not allowed')
  }

  const config = getSupabaseConfig()
  if (!config) return sendError(response, 503, 'Game server is not configured')
  const body = requestBody(request)
  if (!body || typeof body.action !== 'string') return sendError(response, 400, 'Invalid request')

  try {
    if (body.action === 'start') {
      const name = normalizedName(body.name)
      if (!name) return sendError(response, 400, 'Name must use 1-14 letters, numbers, spaces, hyphens, or underscores')
      const previousToken = sessionToken(request)
      const previousHash = previousToken ? tokenHash(previousToken) : undefined
      return await startSession(config, request, response, name, previousHash)
    }

    if (body.action === 'resume') {
      const token = sessionToken(request)
      const hash = token ? tokenHash(token) : undefined
      const session = hash ? await findSession(config, hash) : null
      if (!session || !hasValidRunPasswords(session.passwords)) {
        const requestedName = normalizedName(body.name) || session?.player_name || 'PLAYER ONE'
        return await startSession(config, request, response, requestedName, hash)
      }
      return response.status(200).json({
        playerName: session.player_name,
        currentLevel: session.current_level,
        completedLevels: Array.from({ length: session.current_level - 1 }, (_, index) => index + 1),
        levelStartedAt: session.level_started_at,
        levelActive: session.level_active,
        resumed: true,
      })
    }

    const token = sessionToken(request)
    if (!token) {
      if (body.action === 'prompt' || body.action === 'rename') {
        const requestedName = normalizedName(body.name) || normalizedName(body.playerName) || 'PLAYER ONE'
        return await startSession(config, request, response, requestedName, undefined, true)
      }
      setSessionCookie(request, response, null)
      return sendError(response, 401, 'Game session expired. Start a new run.')
    }
    const hash = tokenHash(token)
    const session = await findSession(config, hash)
    if (!session) {
      if (body.action === 'prompt' || body.action === 'rename') {
        const requestedName = normalizedName(body.name) || normalizedName(body.playerName) || 'PLAYER ONE'
        return await startSession(config, request, response, requestedName, hash, true)
      }
      setSessionCookie(request, response, null)
      return sendError(response, 401, 'Game session expired. Start a new run.')
    }

    if (body.action === 'rename') {
      if (session.current_level !== 1) return sendError(response, 409, 'Player name locks after the first level is cleared')
      const name = normalizedName(body.name)
      if (!name) return sendError(response, 400, 'Name must use 1-14 letters, numbers, spaces, hyphens, or underscores')
      if (!hasValidRunPasswords(session.passwords)) return sendError(response, 409, 'Start a fresh run before changing your handle')
      const newPlayerKey = name.toLowerCase()
      if (newPlayerKey !== session.player_key && !await reservePasswords(config, newPlayerKey, session.passwords)) {
        return sendError(response, 409, 'Those passwords were already used by that handle. Start a fresh run, then try another handle.')
      }
      const query = new URLSearchParams({ token_hash: `eq.${hash}` })
      const result = await supabaseFetch(config, `/rest/v1/game_sessions?${query}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ player_name: name, player_key: newPlayerKey }),
      })
      if (!result.ok) throw new Error('Player name update failed')
      return response.status(200).json({ playerName: name })
    }

    if (body.action === 'begin') {
      const begun = await supabaseFetch(config, '/rest/v1/rpc/begin_game_level', {
        method: 'POST',
        body: JSON.stringify({ session_token_hash: hash, expected_level: session.current_level }),
      })
      if (!begun.ok) throw new Error('Could not begin level timer')
      const beginResult = await begun.json() as { current_level?: number; level_started_at?: string; level_active?: boolean } | null
      if (!beginResult || beginResult.current_level !== session.current_level || beginResult.level_active !== true || !beginResult.level_started_at) {
        return sendError(response, 409, 'This level is no longer available in this run')
      }
      return response.status(200).json({
        playerName: session.player_name,
        currentLevel: session.current_level,
        levelStartedAt: beginResult.level_started_at,
        levelActive: true,
      })
    }

    if (body.action !== 'prompt') return sendError(response, 400, 'Unknown game action')
    if (!session.level_active) return sendError(response, 409, 'Start this level before sending a prompt')
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt || prompt.length > 500) return sendError(response, 400, 'Prompt must contain 1-500 characters')
    if (session.current_level > 7) return sendError(response, 409, 'This run is already complete')

    if (!hasValidRunPasswords(session.passwords)) {
      return sendError(response, 409, 'This run needs a fresh session. Reload to start again.')
    }

    const password = session.passwords[session.current_level - 1]
    const result = evaluatePrompt(session.current_level, prompt, session.fragment_seen, password)
    if (result.fragment) {
      const marked = await supabaseFetch(config, '/rest/v1/rpc/mark_fragment_seen', {
        method: 'POST',
        body: JSON.stringify({ session_token_hash: hash, expected_level: session.current_level }),
      })
      const fragmentMarked: unknown = await marked.json()
      if (!marked.ok || fragmentMarked !== true) throw new Error('Could not save puzzle progress')
    }

    if (!result.success) {
      return response.status(200).json({ reply: result.reply, fragment: result.fragment, success: false })
    }

    const advanced = await supabaseFetch(config, '/rest/v1/rpc/complete_game_level', {
      method: 'POST',
      body: JSON.stringify({ session_token_hash: hash, expected_level: session.current_level }),
    })
    if (!advanced.ok) throw new Error('Could not validate level completion')
    const completion = await advanced.json() as {
      completed_level?: number
      level_time_ms?: number
      next_level_started_at?: string
    } | null
    if (!completion || completion.completed_level !== session.current_level) {
      return sendError(response, 409, 'This level was already completed or the run expired')
    }

    let scores: Awaited<ReturnType<typeof getLeaderboardScores>> | undefined
    try {
      scores = await getLeaderboardScores(config)
    } catch (error) {
      console.error('Level saved but leaderboard refresh failed', error)
    }
    return response.status(200).json({
      reply: result.reply,
      password,
      success: true,
      completedLevel: session.current_level,
      currentLevel: session.current_level + 1,
      completedLevels: Array.from({ length: session.current_level }, (_, index) => index + 1),
      levelTimeMs: completion.level_time_ms,
      levelStartedAt: null,
      levelActive: false,
      ...(scores ? { scores } : {}),
    })
  } catch (error) {
    console.error('Game request failed', error)
    return sendError(response, 502, 'Game server could not save this action. Please retry.')
  }
}