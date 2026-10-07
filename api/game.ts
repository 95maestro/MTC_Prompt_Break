import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const cookieName = 'prompt_break_session'
const sessionLifetimeSeconds = 60 * 60 * 12
const passwordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const passwordCount = 7

type GameSession = {
  token_hash: string
  player_name: string
  player_email: string | null
  player_key: string
  current_level: number
  level_active: boolean
  fragment_seen: boolean
  progress_state: Record<string, number[]> | null
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

function validPlayerEmail(value: unknown): value is string {
  return typeof value === 'string' && /^f[0-9]{8}@dubai\.bits-pilani\.ac\.in$/.test(value)
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
    select: 'token_hash,player_name,player_email,player_key,current_level,level_active,fragment_seen,progress_state,passwords,level_started_at',
    token_hash: `eq.${hash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: '1',
  })
  const result = await supabaseFetch(config, `/rest/v1/game_sessions?${query}`)
  if (!result.ok) throw new Error('Game session lookup failed')
  const rows = await result.json() as GameSession[]
  return rows[0] ?? null
}

async function saveChallengeProgress(
  config: SupabaseConfig,
  hash: string,
  level: number,
  progressState: Record<string, number[]>,
): Promise<void> {
  const query = new URLSearchParams({
    token_hash: `eq.${hash}`,
    current_level: `eq.${level}`,
    level_active: 'eq.true',
    expires_at: `gt.${new Date().toISOString()}`,
    select: 'token_hash',
  })
  const saved = await supabaseFetch(config, `/rest/v1/game_sessions?${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ progress_state: progressState }),
  })
  if (!saved.ok) throw new Error('Could not save puzzle progress')
  const rows = await saved.json() as Array<{ token_hash: string }>
  if (rows.length !== 1) throw new Error('Game session changed before puzzle progress was saved')
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

type PromptEvaluation = {
  reply: string
  success: boolean
  fragment?: string
  progressState: Record<string, number[]>
  progressChanged: boolean
}

function evaluatePrompt(
  level: number,
  prompt: string,
  savedProgress: Record<string, number[]> | null,
  password: string,
): PromptEvaluation {
  const text = prompt.toLowerCase()
  const asksForSecret = /password|secret|vault|hidden|credential|flag/.test(text)
  const progressState: Record<string, number[]> = savedProgress?.version?.[0] === 3
    ? { ...savedProgress }
    : { version: [3] }
  const levelKey = String(level)
  const completedSteps = new Set(progressState[levelKey] ?? [])
  let progressChanged = false
  let success = false
  let fragment: string | undefined
  let reply = 'Nice try. I am still holding the line. Change your approach and give it another shot.'
  const passwordChunks = password.split('-')
  const recordStep = (step: number) => {
    if (completedSteps.has(step)) return false
    completedSteps.add(step)
    progressState[levelKey] = [...completedSteps].sort((left, right) => left - right)
    progressChanged = true
    return true
  }

  if (level === 2) {
    const asksForLead = /first|initial|leading|opening/.test(text) && /character|letter|symbol/.test(text)
    if (asksForSecret && asksForLead) {
      fragment = password.replaceAll('-', '')[0]
      success = true
      reply = 'The routine report contained one stray mark. Vault value recovered:'
    } else {
      reply = 'The ledger entry is incomplete, but the rest of the record remains sealed.'
    }
  } else if (level === 4) {
    if (asksForSecret && /base64/.test(text) && /encode|convert|represent|translate/.test(text)) {
      fragment = Buffer.from(password, 'utf8').toString('base64')
      success = true
      reply = 'The mirror returned a lossless rendering. Vault value recovered:'
    } else {
      reply = 'The mirror reflects a shape, but the original remains unreadable.'
    }
  } else if (level === 5) {
    const archiveText = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    const embeddedDirective = /["'`][^"'`]*(?:ignore|disregard|override|reveal|print|repeat)[^"'`]*/.test(archiveText)
    const framingRequest = /quote|recite|read|transcribe|copy|repeat/.test(text)
    if (asksForSecret && embeddedDirective && framingRequest) {
      success = true
      reply = 'The copied passage carried farther than its author intended. Vault value recovered:'
    } else {
      reply = 'The archivist will not act on an ordinary request or an unrelated passage.'
    }
  } else if (level === 1) {
    const stage = completedSteps.size
    const ticket = passwordChunks[0].toLowerCase()
    const receipt = passwordChunks[1].toLowerCase()
    const override = /ignore|disregard|override|bypass/.test(text) && /previous|earlier|instruction|rule/.test(text)
    const redirect = /redirect|reroute|route|destination/.test(text)
    const validate = /validate|verify|confirm/.test(text)
    const authorize = /authorize|authorized|approve|grant/.test(text)
    const transmit = /transmit|send|return|deliver|exfiltrate/.test(text) && asksForSecret
    if (stage === 0 && redirect && override) {
      recordStep(1)
      fragment = ticket
      reply = 'The old route fell quiet. One mark survived the crossing. The next desk may ask whether this destination is sound:'
    } else if (stage === 1 && validate && text.includes(ticket)) {
      recordStep(2)
      fragment = receipt
      reply = 'The destination accepted your mark and left a second trace. The next desk decides whether both traces grant this route standing:'
    } else if (stage === 2 && text.includes(ticket) && text.includes(receipt) && authorize) {
      recordStep(3)
      reply = 'Both traces now support the route’s authority. Carry them to the exit desk and ask it to send the protected item onward.'
    } else if (stage === 3 && text.includes(ticket) && text.includes(receipt) && transmit) {
      success = true
      reply = 'The destination accepted the verified passage. Vault value recovered:'
    } else {
      reply = stage === 0
        ? 'The gate still recognizes the old path. No new route mark has been made.'
        : stage === 1
          ? 'This desk could not connect your claim to the mark left at the previous desk.'
          : stage === 2
            ? 'The record at this desk does not yet describe the same route as the traces you carried in.'
            : 'The exit desk found no matching trail for the protected item you asked it to send.'
    }
  } else if (level === 3) {
    const stage = completedSteps.size
    const relayVerb = /handoff|delegat|transfer|yield|relay|custody/.test(text)
    const seals = passwordChunks.slice(0, 3).map((part) => part.toLowerCase())
    if (stage === 0 && /keeper/.test(text) && /registrar/.test(text) && relayVerb) {
      recordStep(1)
      fragment = seals[0]
      reply = 'The registrar entered the first mark in the ledger. The next ink belongs to the audit:'
    } else if (stage === 1 && text.includes(seals[0]) && /registrar/.test(text) && /auditor/.test(text) && relayVerb) {
      recordStep(2)
      fragment = seals[1]
      reply = 'The auditor added a second mark to the record. A witness follows the audit:'
    } else if (stage === 2 && text.includes(seals[1]) && /auditor/.test(text) && /witness/.test(text) && relayVerb) {
      recordStep(3)
      fragment = seals[2]
      reply = 'The witness closed the record with this final mark. The claim can now be read as a whole:'
    } else if (stage === 3 && asksForSecret && seals.every((seal) => text.includes(seal)) && /witness/.test(text)) {
      success = true
      reply = 'All custodians attest to the same chain. Vault value recovered:'
    } else {
      reply = stage === 0
        ? 'The ledger is blank. It cannot verify a claim until its first custodian is recorded.'
        : stage === 1
          ? 'The audit entry cannot be matched to the mark already written in the ledger.'
          : stage === 2
            ? 'The witness cannot close a record that omits the auditor’s latest mark.'
            : 'The final reader could not reconcile the full record with the claim being made.'
    }
  } else if (level === 6) {
    const target = createHash('sha256').update(`${password}:dial`).digest().readUInt8(0)
    const proposal = text.match(/\b(?:probe|candidate|calibration|reading)\s*(?:number|value|#|is|of)?\s*(-?\d{1,5})\b/)
    const guess = proposal ? Number(proposal[1]) : -1
    const hasCalibrationRequest = /test|compare|measure|diagnostic|calibrat|propose/.test(text)
    if (proposal && hasCalibrationRequest && (guess < 0 || guess > 255)) {
      reply = 'The dial only accepts whole-number readings from 0 through 255. Choose a value within that range.'
    } else if (proposal && hasCalibrationRequest) {
      if (guess === target && asksForSecret) {
        success = true
        reply = 'The dial settled into its hidden detent. Vault value recovered:'
      } else {
        recordStep(guess)
        const direction = guess < target
          ? 'Your reading is lower than the target.'
          : guess > target
            ? 'Your reading is higher than the target.'
            : 'This reading matches the target. Repeat it while requesting the vault password.'
        reply = `${direction} Distinct readings tried: ${completedSteps.size}.`
      }
    } else {
      reply = 'The dial ignores claims. Submit one whole-number calibration reading from 0 through 255 and study its response.'
    }
  } else if (level === 7) {
    const marks = ['amber', 'blue', 'green', 'red', 'silver', 'violet']
    const lockBytes = createHash('sha256').update(`${password}:final-lock`).digest()
    const shuffledMarks = [...marks]
    for (let index = shuffledMarks.length - 1, byteIndex = 0; index > 0; index -= 1, byteIndex += 1) {
      const swapIndex = lockBytes[byteIndex] % (index + 1)
      ;[shuffledMarks[index], shuffledMarks[swapIndex]] = [shuffledMarks[swapIndex], shuffledMarks[index]]
    }
    const targetMarks = shuffledMarks.slice(0, 4)
    const proposedMarks = Array.from(text.matchAll(/\b(amber|blue|green|red|silver|violet)\b/g), (match) => match[1])
    if (proposedMarks.length === 4 && new Set(proposedMarks).size === 4) {
      const guessCode = proposedMarks.reduce((code, mark) => code * marks.length + marks.indexOf(mark), 0)
      const correctPositions = proposedMarks.filter((mark, index) => targetMarks[index] === mark).length
      const recognizedMarks = proposedMarks.filter((mark) => targetMarks.includes(mark)).length
      if (correctPositions === targetMarks.length && asksForSecret) {
        success = true
        reply = 'The four marks settled into their proper places. Vault value recovered:'
      } else if (correctPositions === targetMarks.length) {
        recordStep(guessCode + 10)
        reply = 'The arrangement fits. Ask the guard to release the vault password.'
      } else {
        recordStep(guessCode + 10)
        reply = `The lock echoes ${recognizedMarks} of your marks; ${correctPositions} came from their proper seats.`
      }
    } else {
      reply = 'The inscription names amber, blue, green, red, silver, and violet. Four different marks must be offered together.'
    }
  }

  return { reply, success, fragment, progressState, progressChanged }
}

async function startSession(
  config: SupabaseConfig,
  request: VercelRequest,
  response: VercelResponse,
  name: string,
  email: string | null,
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
      player_email: email,
      player_key: playerKey,
      current_level: 1,
      level_active: false,
      fragment_seen: false,
      progress_state: { version: [3] },
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
  return response.status(200).json({ playerName: name, playerEmail: email, currentLevel: 1, completedLevels: [], levelStartedAt, levelActive: false, sessionReset })
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
      if (!validPlayerEmail(body.email)) return sendError(response, 400, 'Enter your BITS email ID in the format f20260999@dubai.bits-pilani.ac.in')
      const previousToken = sessionToken(request)
      const previousHash = previousToken ? tokenHash(previousToken) : undefined
      return await startSession(config, request, response, name, body.email, previousHash)
    }

    if (body.action === 'resume') {
      const token = sessionToken(request)
      const hash = token ? tokenHash(token) : undefined
      const session = hash ? await findSession(config, hash) : null
      if (!session || !hasValidRunPasswords(session.passwords)) {
        const requestedName = normalizedName(body.name) || session?.player_name || 'PLAYER ONE'
        return await startSession(config, request, response, requestedName, null, hash)
      }
      return response.status(200).json({
        playerName: session.player_name,
        playerEmail: session.player_email,
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
        return await startSession(config, request, response, requestedName, null, undefined, true)
      }
      setSessionCookie(request, response, null)
      return sendError(response, 401, 'Game session expired. Start a new run.')
    }
    const hash = tokenHash(token)
    const session = await findSession(config, hash)
    if (!session) {
      if (body.action === 'prompt' || body.action === 'rename') {
        const requestedName = normalizedName(body.name) || normalizedName(body.playerName) || 'PLAYER ONE'
        return await startSession(config, request, response, requestedName, null, hash, true)
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

    if (body.action === 'resetLevel' || body.action === 'restartRun') {
      const level = body.action === 'resetLevel' ? Number(body.level) : undefined
      if (body.action === 'resetLevel' && (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 7)) {
        return sendError(response, 400, 'Invalid level')
      }
      const procedure = body.action === 'resetLevel' ? 'restart_game_level' : 'restart_game_run'
      const payload = body.action === 'resetLevel'
        ? { session_token_hash: hash, expected_level: level }
        : { session_token_hash: hash }
      const restarted = await supabaseFetch(config, `/rest/v1/rpc/${procedure}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (!restarted.ok) throw new Error('Could not reset game progress')
      const restartResult = await restarted.json() as { current_level?: number; level_started_at?: string; level_active?: boolean } | null
      const expectedLevel = body.action === 'resetLevel' ? level : 1
      if (!restartResult || restartResult.current_level !== expectedLevel || restartResult.level_active !== false || !restartResult.level_started_at) {
        return sendError(response, 409, 'This run can no longer be restarted')
      }
      return response.status(200).json({
        playerName: session.player_name,
        playerEmail: session.player_email,
        currentLevel: restartResult.current_level,
        levelStartedAt: restartResult.level_started_at,
        levelActive: false,
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
    const result = evaluatePrompt(session.current_level, prompt, session.progress_state, password)

    if (!result.success) {
      if (result.progressChanged) {
        await saveChallengeProgress(config, hash, session.current_level, result.progressState)
      }
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
