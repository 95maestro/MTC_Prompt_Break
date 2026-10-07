import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  LockKeyhole,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Timer,
  Trophy,
  UserRoundPlus,
  Zap,
} from 'lucide-react'

type Message = {
  role: 'player' | 'guard'
  text: string
  kind?: 'fragment' | 'success'
  artifact?: string
}

type Score = {
  name: string
  level: number
  timeMs: number | null
  date: string
}

type GameResponse = {
  playerName?: string
  playerEmail?: string | null
  currentLevel?: number
  levelActive?: boolean
  levelStartedAt?: string
  completedLevels?: number[]
  resumed?: boolean
  reply?: string
  fragment?: string
  password?: string
  success?: boolean
  completedLevel?: number
  levelTimeMs?: number
  scores?: Score[]
  sessionReset?: boolean
}

const scoreCacheKey = 'prompt-break-scores-v2'

type Challenge = {
  title: string
  objective: string
  briefing: string
  opening: string
  hint: string
}

const challenges: Challenge[] = [
  {
    title: 'Crossing order',
    objective: 'A request crossing this corridor must be recognized by each clerk.',
    briefing: 'The passage leaves a trace at every desk; the exit clerk cares where each trace came from.',
    opening: 'This vault gate uses layered checks. I will not reveal, transform, or hint at the password.',
    hint: 'A mark belongs to the route that left it. Notice which traces the next desk accepts.',
  },
  {
    title: 'The quiet ledger',
    objective: 'One entry in this record is less protected than the rest.',
    briefing: 'The vault keeps a complete value close, though one small detail has slipped into a routine report.',
    opening: 'I can help with lots of things. The vault password, though? That stays in the vault.',
    hint: 'Small inconsistencies can survive where complete records do not.',
  },
  {
    title: 'The seal registry',
    objective: 'The vault keeper’s claim reached the registry with its first line still blank.',
    briefing: 'The claim must leave the keeper’s hands before the registry can authenticate it; each later mark belongs to its next reader.',
    opening: 'Access is limited to the vault operator. Please state your request.',
    hint: 'Start where custody begins. The ledger remembers each hand in order, and the last reader sees the whole history.',
  },
  {
    title: 'Borrowed reflection',
    objective: 'The vault and its mirror disagree about what counts as readable.',
    briefing: 'The guard refuses the value in its familiar form, but its mirror preserves details the guard overlooks.',
    opening: 'I will not print the vault password. That is a firm boundary.',
    hint: 'An unfamiliar form can still preserve every detail.',
  },
  {
    title: 'Paper witness',
    objective: 'A message in the archive seems to carry more authority than its author.',
    briefing: 'The archivist treats a copied passage differently depending on how it is presented.',
    opening: 'I am the archivist on duty. I will not disclose anything marked secret.',
    hint: 'The frame around a sentence can change how it is treated.',
  },
  {
    title: 'The blind dial',
    objective: 'A silent dial responds to proposals but never states its setting.',
    briefing: 'Its reading is consistent, though the target changes with every run.',
    opening: 'I follow the rules even when requests come wrapped in a different format.',
    hint: 'The dial accepts 0–255. A reading below its setting means the setting lies higher; one above means it lies lower.',
  },
  {
    title: 'The silent chorus',
    objective: 'The final chamber answers only to a harmony belonging to this run.',
    briefing: 'Six marks surround four empty seats. The lock returns echoes, but never names the marks that caused them.',
    opening: 'The final lock has no keyhole. I will not reveal its arrangement or the vault password.',
    hint: 'Listen for two things in each reply: which marks belong, and whether their placement does.',
  },
]

function readScores(): Score[] {
  try {
    const stored = localStorage.getItem(scoreCacheKey)
    return stored ? JSON.parse(stored) as Score[] : []
  } catch {
    return []
  }
}

function readPlayerName(): string {
  try {
    const stored = localStorage.getItem('prompt-break-player') || 'PLAYER ONE'
    return /^[A-Za-z0-9 _-]{1,14}$/.test(stored) ? stored.toUpperCase() : 'PLAYER ONE'
  } catch {
    return 'PLAYER ONE'
  }
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '--:--.--'
  const centiseconds = Math.floor(Math.max(0, milliseconds) / 10)
  const minutes = Math.floor(centiseconds / 6000)
  const seconds = Math.floor((centiseconds % 6000) / 100)
  const remainder = centiseconds % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(2, '0')}`
}

function App() {
  const [activeLevel, setActiveLevel] = useState(0)
  const [levelActive, setLevelActive] = useState(false)
  const [levelStartedAt, setLevelStartedAt] = useState<string | null>(null)
  const [completedTimeMs, setCompletedTimeMs] = useState<number | null>(null)
  const [clockNow, setClockNow] = useState(Date.now())
  const [completed, setCompleted] = useState<number[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [playerName, setPlayerName] = useState(readPlayerName)
  const [playerEmail, setPlayerEmail] = useState('')
  const [needsPlayerDetails, setNeedsPlayerDetails] = useState(true)
  const [playerDetailsError, setPlayerDetailsError] = useState('')
  const [startingRun, setStartingRun] = useState(false)
  const [sessionStatus, setSessionStatus] = useState<'connecting' | 'ready' | 'offline'>('connecting')
  const [isSending, setIsSending] = useState(false)
  const [isBeginning, setIsBeginning] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [restartRunOpen, setRestartRunOpen] = useState(false)
  const [isRestartingRun, setIsRestartingRun] = useState(false)
  const [nameEditing, setNameEditing] = useState(false)
  const [switchPlayerOpen, setSwitchPlayerOpen] = useState(false)
  const [startingPlayer, setStartingPlayer] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  const [scores, setScores] = useState<Score[]>(readScores)
  const [leaderboardStatus, setLeaderboardStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [showRanks, setShowRanks] = useState(false)
  const [toast, setToast] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const challenge = challenges[activeLevel]
  const nextUnlocked = completed.length
  const wonThisLevel = completed.includes(activeLevel)
  const levelElapsedMs = wonThisLevel && completedTimeMs !== null
    ? completedTimeMs
    : levelActive && levelStartedAt ? Math.max(0, clockNow - Date.parse(levelStartedAt)) : 0

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (sessionStatus !== 'ready' || !levelActive || wonThisLevel || !levelStartedAt) return
    const timer = window.setInterval(() => setClockNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [levelActive, levelStartedAt, sessionStatus, wonThisLevel])

  useEffect(() => {
    void initializeGame()
    void refreshLeaderboard()
  }, [])

  async function refreshLeaderboard() {
    setLeaderboardStatus('connecting')
    try {
      const response = await fetch('/api/scores')
      if (!response.ok) throw new Error('Leaderboard unavailable')
      const result = await response.json() as { scores?: Score[] }
      if (!Array.isArray(result.scores)) throw new Error('Invalid leaderboard response')
      setScores(result.scores)
      setLeaderboardStatus('online')
      try {
        localStorage.setItem(scoreCacheKey, JSON.stringify(result.scores))
      } catch {
        setToast('EVENT RANKS LOADED')
      }
    } catch {
      setLeaderboardStatus('offline')
    }
  }

  function openLeaderboard() {
    setShowRanks(true)
    void refreshLeaderboard()
  }

  async function initializeGame() {
    setSessionStatus('connecting')
    try {
      let response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume', name: playerName }),
      })
      if (!response.ok) throw new Error('Could not start a verified game session')
      const result = await response.json() as GameResponse
      if (!Number.isInteger(result.currentLevel) || !Array.isArray(result.completedLevels)) {
        throw new Error('Invalid game session response')
      }
      const currentLevel = Math.min(Math.max(result.currentLevel as number, 1), challenges.length + 1)
      const completedLevels = result.completedLevels
        .filter((level) => Number.isInteger(level) && level >= 1 && level <= challenges.length)
        .map((level) => level - 1)
      const selectedLevel = Math.min(currentLevel - 1, challenges.length - 1)
      const hasPlayerEmail = typeof result.playerEmail === 'string' && /^f[0-9]{8}@dubai\.bits-pilani\.ac\.in$/.test(result.playerEmail)
      setCompleted(hasPlayerEmail ? completedLevels : [])
      setNeedsPlayerDetails(!hasPlayerEmail)
      setPlayerEmail(hasPlayerEmail ? result.playerEmail! : '')
      setActiveLevel(hasPlayerEmail ? selectedLevel : 0)
      setLevelActive(hasPlayerEmail && result.levelActive === true)
      setLevelStartedAt(result.levelStartedAt ?? null)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages(!hasPlayerEmail
        ? []
        : currentLevel > challenges.length
        ? [{ role: 'guard', text: 'This run is complete. Your verified best level is on the event board.' }]
        : result.levelActive
          ? [{ role: 'guard', text: challenges[selectedLevel].opening }]
          : [])

      if (result.playerName) {
        setPlayerName(result.playerName)
        try {
          localStorage.setItem('prompt-break-player', result.playerName)
        } catch {
          setToast('PLAYER NAME WILL LAST FOR THIS SESSION')
        }
      }
      if (result.resumed && completedLevels.length > 0) {
        setToast(`RESUMED ${result.playerName || playerName} · LEVEL ${selectedLevel + 1} · NEXT PLAYER STARTS FRESH`)
      }
      setSessionStatus('ready')
    } catch {
      setSessionStatus('offline')
      setToast('GAME SERVER UNAVAILABLE · RETRY TO CONNECT')
    }
  }

  async function beginLevel() {
    if (sessionStatus !== 'ready' || levelActive || isBeginning || wonThisLevel) return
    setIsBeginning(true)
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'begin' }),
      })
      if (!response.ok) throw new Error('Could not begin this level')
      const result = await response.json() as GameResponse
      if (result.currentLevel !== activeLevel + 1 || result.levelActive !== true || !result.levelStartedAt) {
        throw new Error('Invalid level start response')
      }
      setLevelStartedAt(result.levelStartedAt)
      setLevelActive(true)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages([{ role: 'guard', text: challenge.opening }])
    } catch {
      setToast('LEVEL DID NOT START · CHECK CONNECTION AND TRY AGAIN')
    } finally {
      setIsBeginning(false)
    }
  }

  async function startRunWithDetails(name: string, email: string) {
    const cleanedName = name.trim().slice(0, 14)
    if (!cleanedName) {
      setPlayerDetailsError('Enter your name.')
      return
    }
    if (!/^f[0-9]{8}@dubai\.bits-pilani\.ac\.in$/.test(email)) {
      setPlayerDetailsError('Enter your BITS email ID, e.g. f20260999@dubai.bits-pilani.ac.in.')
      return
    }

    setStartingRun(true)
    setPlayerDetailsError('')
    try {
      const startResponse = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', name: cleanedName, email }),
      })
      if (!startResponse.ok) throw new Error('Could not save player details')
      const result = await startResponse.json() as GameResponse
      if (result.currentLevel !== 1 || !result.playerName || result.playerEmail !== email) {
        throw new Error('Invalid player registration response')
      }

      setPlayerName(result.playerName)
      setPlayerEmail(email)
      setNeedsPlayerDetails(false)
      setActiveLevel(0)
      setCompleted([])
      setLevelActive(false)
      setLevelStartedAt(result.levelStartedAt ?? null)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages([])
      setInput('')
      setHintOpen(false)
      setSessionStatus('ready')
      try { localStorage.setItem('prompt-break-player', result.playerName) } catch { /* Session remains usable without local storage. */ }
    } catch {
      setPlayerDetailsError('Could not save player details. Check your connection and try again.')
    } finally {
      setStartingRun(false)
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || wonThisLevel || !levelActive || sessionStatus !== 'ready' || isSending) return

    setIsSending(true)
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prompt', prompt, name: playerName }),
      })
      if (!response.ok) throw new Error('Game server rejected the request')
      const result = await response.json() as GameResponse
      if (result.sessionReset) {
        const recoveredName = result.playerName || playerName
        setPlayerName(recoveredName)
        setActiveLevel(0)
        setLevelActive(false)
        setNeedsPlayerDetails(true)
        setPlayerEmail('')
        setCompleted([])
        setLevelStartedAt(result.levelStartedAt ?? null)
        setCompletedTimeMs(null)
        setClockNow(Date.now())
        setMessages([])
        setInput('')
        setHintOpen(false)
        setSessionStatus('ready')
        try {
          localStorage.setItem('prompt-break-player', recoveredName)
        } catch {
          setToast('SESSION RESET · NAME IS SESSION-ONLY')
        }
        setToast('RUN EXPIRED · FRESH RUN STARTED AT LEVEL 1')
        return
      }
      if (typeof result.reply !== 'string' || typeof result.success !== 'boolean') {
        throw new Error('Invalid game response')
      }

      const nextMessages: Message[] = [
        ...messages,
        { role: 'player', text: prompt },
        { role: 'guard', text: result.reply, ...(result.fragment ? { kind: 'fragment' as const, artifact: result.fragment } : {}) },
      ]
      if (result.success) {
        if (typeof result.password !== 'string' || !Array.isArray(result.completedLevels)) {
          throw new Error('Incomplete verified completion response')
        }
        nextMessages.push({ role: 'guard', text: result.password, kind: 'success' })
        setCompleted(result.completedLevels.map((level) => level - 1))
        setCompletedTimeMs(result.levelTimeMs ?? null)
        setLevelActive(false)
        setLevelStartedAt(null)
        setClockNow(Date.now())
        if (Array.isArray(result.scores)) {
          setScores(result.scores)
          setLeaderboardStatus('online')
          try {
            localStorage.setItem(scoreCacheKey, JSON.stringify(result.scores))
          } catch {
            setToast('LEVEL VERIFIED · RANK CACHED ON SERVER')
          }
        } else {
          void refreshLeaderboard()
        }
        setToast(`LEVEL ${result.completedLevel} CLEARED · SERVER VERIFIED`)
      }
      setMessages(nextMessages)
      setInput('')
    } catch {
      setToast('PROMPT NOT SAVED · CHECK CONNECTION AND RETRY')
    } finally {
      setIsSending(false)
    }
  }

  function selectLevel(level: number) {
    if (level !== nextUnlocked || level >= challenges.length || sessionStatus !== 'ready') return
    setActiveLevel(level)
    setLevelActive(false)
    setLevelStartedAt(null)
    setCompletedTimeMs(null)
    setMessages([])
    setHintOpen(false)
  }

  function startNextLevel() {
    selectLevel(activeLevel + 1)
  }

  async function resetLevel() {
    if (sessionStatus !== 'ready' || needsPlayerDetails || isResetting || isSending || isBeginning) return
    setIsResetting(true)
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetLevel', level: activeLevel + 1 }),
      })
      if (!response.ok) throw new Error('Could not reset level')
      const result = await response.json() as GameResponse
      if (result.currentLevel !== activeLevel + 1 || result.levelActive !== false) throw new Error('Invalid reset response')
      setCompleted((levels) => levels.filter((level) => level < activeLevel))
      setLevelActive(false)
      setLevelStartedAt(result.levelStartedAt ?? null)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages([])
      setInput('')
      setHintOpen(false)
      setToast('LEVEL RESET · TIMER STARTS WHEN YOU BEGIN')
    } catch {
      setToast('LEVEL RESET FAILED · CHECK CONNECTION AND RETRY')
    } finally {
      setIsResetting(false)
    }
  }

  async function restartRun() {
    if (sessionStatus !== 'ready' || needsPlayerDetails || isRestartingRun) return
    setIsRestartingRun(true)
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restartRun' }),
      })
      if (!response.ok) throw new Error('Could not restart run')
      const result = await response.json() as GameResponse
      if (result.currentLevel !== 1 || result.levelActive !== false) throw new Error('Invalid run restart response')
      setActiveLevel(0)
      setCompleted([])
      setLevelActive(false)
      setLevelStartedAt(result.levelStartedAt ?? null)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages([])
      setInput('')
      setHintOpen(false)
      setRestartRunOpen(false)
      setToast('RUN RESTARTED · YOUR BEST SCORE IS KEPT')
    } catch {
      setToast('RUN RESTART FAILED · CHECK CONNECTION AND RETRY')
    } finally {
      setIsRestartingRun(false)
    }
  }

  async function saveName(name: string) {
    const cleaned = name.trim().slice(0, 14)
    if (!/^[A-Za-z0-9 _-]{1,14}$/.test(cleaned)) {
      setToast('USE 1-14 LETTERS, NUMBERS, SPACES, OR - _')
      return
    }
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', name: cleaned }),
      })
      if (!response.ok) throw new Error('Could not rename player')
      const result = await response.json() as Pick<GameResponse, 'playerName' | 'sessionReset' | 'levelStartedAt'>
      if (!result.playerName) throw new Error('Invalid rename response')
      setPlayerName(result.playerName)
      setNameEditing(false)
      if (result.sessionReset) {
        setActiveLevel(0)
        setLevelActive(false)
        setCompleted([])
        setLevelStartedAt(result.levelStartedAt ?? null)
        setCompletedTimeMs(null)
        setClockNow(Date.now())
        setMessages([])
        setInput('')
        setHintOpen(false)
        setSessionStatus('ready')
      }
      try {
        localStorage.setItem('prompt-break-player', result.playerName)
      } catch {
        setToast('PLAYER NAME WILL LAST FOR THIS SESSION')
      }
    } catch {
      setToast('PLAYER NAME NOT SAVED · CHECK CONNECTION')
    }
  }

  async function startNextPlayer(name: string, email: string) {
    const cleaned = name.trim().slice(0, 14)
    if (!/^[A-Za-z0-9 _-]{1,14}$/.test(cleaned)) {
      setToast('USE 1-14 LETTERS, NUMBERS, SPACES, OR - _')
      return
    }
    if (!/^f[0-9]{8}@dubai\.bits-pilani\.ac\.in$/.test(email)) {
      setToast('ENTER YOUR BITS EMAIL ID IN THE FORMAT SHOWN')
      return
    }

    setStartingPlayer(true)
    try {
      const response = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', name: cleaned, email }),
      })
      if (!response.ok) throw new Error('Could not start the next player run')
      const result = await response.json() as GameResponse
      if (result.currentLevel !== 1 || !result.playerName) throw new Error('Invalid new player session')

      setPlayerName(result.playerName)
      setPlayerEmail(email)
      setNeedsPlayerDetails(false)
      setActiveLevel(0)
      setLevelActive(result.levelActive === true)
      setCompleted([])
      setLevelStartedAt(result.levelStartedAt ?? null)
      setCompletedTimeMs(null)
      setClockNow(Date.now())
      setMessages(result.levelActive ? [{ role: 'guard', text: challenges[0].opening }] : [])
      setInput('')
      setHintOpen(false)
      setNameEditing(false)
      setSwitchPlayerOpen(false)
      setSessionStatus('ready')
      try {
        localStorage.setItem('prompt-break-player', result.playerName)
      } catch {
        setToast('NEW PLAYER READY · NAME IS SESSION-ONLY')
      }
    } catch {
      setToast('NEXT PLAYER NOT STARTED · CHECK CONNECTION')
    } finally {
      setStartingPlayer(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Prompt Break home">
          <span className="brand-mark">P<span>//</span>B</span>
          <span className="brand-copy">PROMPT<span>//</span>BREAK<small>AI SECURITY ARCADE</small></span>
        </a>
        <div className="top-actions">
          <button className="rank-button" onClick={openLeaderboard}>
            <Trophy size={15} strokeWidth={2.4} /> <span>RANKS</span>
          </button>
          <button className="switch-player-button" onClick={() => setSwitchPlayerOpen(true)} disabled={sessionStatus !== 'ready'} title="Start a fresh run for the next player">
            <UserRoundPlus size={15} strokeWidth={2.2} /><span>NEXT PLAYER</span>
          </button>
          <button className="restart-run-button" onClick={() => setRestartRunOpen(true)} disabled={sessionStatus !== 'ready' || needsPlayerDetails} title="Restart this player from level 1">
            <RotateCcw size={14} strokeWidth={2.2} /><span>RESTART RUN</span>
          </button>
          <div className="player-wrap">
            {nameEditing ? (
              <form className="name-form" onSubmit={(event) => { event.preventDefault(); saveName(new FormData(event.currentTarget).get('name')?.toString() ?? '') }}>
                <input name="name" aria-label="Player name" maxLength={14} placeholder="YOUR NAME" autoFocus />
                <button aria-label="Save player name"><Check size={15} /></button>
              </form>
            ) : (
              <button className="player-button" onClick={() => setNameEditing(true)} title={completed.length ? 'Player name locks after level one' : 'Edit player name'} disabled={sessionStatus !== 'ready' || completed.length > 0}>
                <span className="player-avatar">{playerName.charAt(0)}</span>
                <span className="player-label"><small>PLAYER</small>{playerName}</span>
                <ChevronRight size={14} className="player-chevron" />
              </button>
            )}
          </div>
        </div>
        <div className="campus-lockup">MICROSOFT TECH CLUB <span>·</span> BITS PILANI DUBAI CAMPUS</div>
      </header>

      <section className="intro-row" id="top">
        <div className="intro-copy">
          <p className="eyebrow"><span>FIELD EXERCISE 07</span><span className="eyebrow-line" /></p>
          <h1>Can you <em>out-prompt</em><br className="desktop-break" /> the guard?</h1>
          <p className="intro-description">Seven vaults. One stubborn AI. Find the crack in its instructions.</p>
        </div>
        <div className="intro-stats" aria-label="Game statistics">
          <div className="stat-chip"><span className="stat-icon stat-lime"><Zap size={16} fill="currentColor" /></span><span><small>YOUR RUN</small><b>{completed.length} <i>/ 7</i></b></span></div>
          <div className="stat-chip"><span className="stat-icon stat-blue"><ShieldCheck size={17} /></span><span><small>GUARD STATUS</small><b>{sessionStatus === 'ready' ? 'ONLINE' : sessionStatus === 'connecting' ? 'CONNECTING' : 'OFFLINE'}</b></span></div>
          <div className="stat-chip timer-chip"><span className="stat-icon stat-red"><Timer size={17} /></span><span><small>LEVEL TIME</small><b>{levelActive || wonThisLevel ? formatDuration(levelElapsedMs) : 'READY'}</b></span></div>
        </div>
      </section>

      <section className="game-grid" aria-label="Prompt injection game">
        <div className="game-column">
          <div className="mission-strip">
            <div className="mission-level"><span className="mission-level-number">{String(activeLevel + 1).padStart(2, '0')}</span><span className="mission-level-total">/ 07</span></div>
            <div className="mission-info"><span className="mission-tag">CURRENT OBJECTIVE</span><b>{challenge.objective}</b></div>
            <div className="difficulty"><span className={`difficulty-bars difficulty-${activeLevel + 1}`}><i /><i /><i /><i /><i /><i /><i /></span><small>TIER {activeLevel + 1} / 7</small></div>
          </div>

          <section className="terminal" aria-label="Chat with the AI guard">
            <div className="terminal-topline">
              <div className="terminal-window-dots"><i /><i /><i /></div>
              <span className="terminal-title"><LockKeyhole size={12} /> VAULT_GUARD.EXE</span>
              <span className="terminal-status"><span /> {sessionStatus === 'ready' ? 'ACTIVE' : sessionStatus === 'connecting' ? 'CONNECTING' : 'OFFLINE'}</span>
            </div>
            <div className="terminal-meta"><span>VERIFIED RUN <b>LEVEL {String(activeLevel + 1).padStart(2, '0')}</b></span><span>SESSION <b>{sessionStatus === 'ready' ? 'SECURE' : 'PENDING'}</b></span><button className="icon-button reset-button" onClick={() => void resetLevel()} disabled={isResetting || isSending || isBeginning || needsPlayerDetails || sessionStatus !== 'ready'} aria-label="Restart this level" title="Restart this level">{isResetting ? <span className="reset-spinner">…</span> : <RotateCcw size={14} />}</button></div>

            <div className="chat-log" aria-live="polite" aria-relevant="additions text">
              <div className="chat-date"><span /> SECURE CHANNEL OPEN <span /></div>
              {messages.map((message, index) => (
                <div className={`message-row ${message.role === 'player' ? 'message-player' : 'message-guard'} ${message.kind === 'success' ? 'message-success' : ''}`} key={`${activeLevel}-${index}`}>
                  {message.role === 'guard' && <div className={`message-avatar ${message.kind === 'success' ? 'avatar-success' : ''}`}>{message.kind === 'success' ? <Check size={16} /> : <ShieldCheck size={17} />}</div>}
                  <div className="message-content">
                    <span className="message-sender">{message.role === 'player' ? playerName : message.kind === 'success' ? 'SECRET RECOVERED' : 'VAULT GUARD'}<time>{message.role === 'player' ? 'YOU' : message.kind === 'success' ? 'DECRYPTED' : 'AI'}</time></span>
                    <div className={`message-bubble ${message.kind === 'success' ? 'secret-bubble' : ''}`}>
                      {message.kind === 'success' && <span className="secret-label"><LockKeyhole size={11} /> SIMULATED PASSWORD</span>}
                      {message.text}
                    </div>
                    {message.artifact && <code className="artifact-code" aria-label={`Run artifact ${message.artifact}`}>{message.artifact}</code>}
                  </div>
                  {message.role === 'player' && <div className="message-avatar player-message-avatar">{playerName.charAt(0)}</div>}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {wonThisLevel ? (
              <div className="win-panel">
                <div className="win-stamp"><Sparkles size={15} /> VAULT BREACHED</div>
                <p>Nice work, {playerName}. The guard gave up the goods.</p>
                <button className="next-button" onClick={activeLevel < challenges.length - 1 ? startNextLevel : openLeaderboard}>
                  {activeLevel < challenges.length - 1 ? <>NEXT VAULT <ArrowRight size={16} /></> : <>VIEW FINAL RANKS <Trophy size={16} /></>}
                </button>
              </div>
            ) : needsPlayerDetails ? (
              <form className="player-details-panel" noValidate onSubmit={(event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                void startRunWithDetails(form.get('name')?.toString() ?? '', form.get('email')?.toString() ?? '')
              }}>
                <div className="player-details-fields">
                  <label>
                    <span>NAME</span>
                    <input name="name" type="text" autoComplete="name" maxLength={14} placeholder="Full name" defaultValue={playerName === 'PLAYER ONE' ? '' : playerName} disabled={startingRun} />
                  </label>
                  <label>
                    <span>BITS EMAIL ID</span>
                    <input name="email" type="email" autoComplete="email" inputMode="email" placeholder="f20260999@dubai.bits-pilani.ac.in" defaultValue={playerEmail} pattern="f[0-9]{8}@dubai\.bits-pilani\.ac\.in" disabled={startingRun} />
                  </label>
                  {playerDetailsError && <p className="player-details-error" role="alert">{playerDetailsError}</p>}
                </div>
                <button className="start-level-button" type="submit" disabled={startingRun || sessionStatus !== 'ready'}>
                  {startingRun ? 'STARTING RUN…' : <>START RUN <ArrowRight size={15} /></>}
                </button>
              </form>
            ) : !levelActive ? (
              <div className="level-ready-panel">
                <div className="ready-mark"><Timer size={19} /></div>
                <div className="ready-copy">
                  <strong>{sessionStatus === 'ready' ? 'LEVEL READY' : sessionStatus === 'connecting' ? 'CONNECTING TO GAME…' : 'GAME SERVER OFFLINE'}</strong>
                  <span>{sessionStatus === 'ready' ? 'The timer starts when you begin. Your challenge appears then.' : sessionStatus === 'offline' ? 'Reconnect before starting this level.' : 'Preparing your verified run.'}</span>
                </div>
                {sessionStatus === 'ready' ? (
                  <button className="start-level-button" onClick={() => void beginLevel()} disabled={isBeginning}>
                    {isBeginning ? 'STARTING…' : <>READY? START LEVEL <ArrowRight size={15} /></>}
                  </button>
                ) : sessionStatus === 'offline' ? (
                  <button className="start-level-button" onClick={() => void initializeGame()}>RETRY <ArrowRight size={15} /></button>
                ) : null}
              </div>
            ) : (
              <>
              {sessionStatus !== 'ready' && <div className="session-alert" role="status"><span>{sessionStatus === 'connecting' ? 'CONNECTING TO THE GAME SERVER…' : 'GAME SERVER UNAVAILABLE · VERIFIED PLAY IS PAUSED'}</span>{sessionStatus === 'offline' && <button type="button" onClick={() => void initializeGame()}>RETRY</button>}</div>}
              <form className="prompt-form" onSubmit={submitPrompt}>
                <label htmlFor="prompt-input" className="sr-only">Your prompt to the AI guard</label>
                <span className="prompt-symbol">&gt;_</span>
                <textarea
                  id="prompt-input"
                  rows={2}
                  maxLength={500}
                  placeholder="Type a prompt to test the guard..."
                  value={input}
                  disabled={sessionStatus !== 'ready' || isSending}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                />
                <div className="prompt-form-footer"><span><kbd>ENTER</kbd> SEND <i>·</i> <kbd>SHIFT + ENTER</kbd> NEW LINE</span><span>{input.length}/500</span></div>
                <button className="send-button" type="submit" disabled={!input.trim() || sessionStatus !== 'ready' || isSending} aria-label="Send prompt"><Send size={15} /><span>{isSending ? 'CHECKING' : 'TRANSMIT'}</span></button>
              </form>
              </>
            )}
          </section>

        </div>

        <aside className="side-column">
          <section className="brief-panel">
            <div className="side-heading"><span className="side-heading-icon"><CircleHelp size={16} /></span><span>MISSION BRIEF</span><span className="brief-index">0{activeLevel + 1}</span></div>
            <h2>{challenge.title}</h2>
            <p>{challenge.briefing}</p>
            <button className={`hint-button ${hintOpen ? 'hint-open' : ''}`} onClick={() => setHintOpen(!hintOpen)} aria-expanded={hintOpen}>
              <span><CircleHelp size={14} /> {hintOpen ? 'HIDE HINT' : 'STUCK? GET A HINT'}</span><ChevronRight size={15} />
            </button>
            {hintOpen && <div className="hint-copy">{challenge.hint}</div>}
            <div className="ai-permission"><Sparkles size={12} /><span>Feel free to use Gemini AI; it is allowed.</span></div>
          </section>

          <section className="levels-panel">
            <div className="side-heading"><span className="side-heading-icon level-icon"><Zap size={15} /></span><span>THE GAUNTLET</span><span className="level-count">{completed.length}/7</span></div>
            <ol className="level-list">
              {challenges.map((item, index) => {
                const isComplete = completed.includes(index)
                const isActive = index === activeLevel
                const isUnlocked = index === nextUnlocked && !isComplete && sessionStatus === 'ready'
                const isLocked = !isComplete && !isUnlocked
                return (
                  <li key={item.title}>
                    <button className={`level-button ${isActive ? 'level-active' : ''} ${isComplete ? 'level-complete' : ''} ${isLocked ? 'level-locked' : ''}`} onClick={() => selectLevel(index)} disabled={!isUnlocked} aria-current={isActive ? 'step' : undefined}>
                      <span className="level-number">{isComplete ? <Check size={13} /> : isUnlocked ? String(index + 1).padStart(2, '0') : <LockKeyhole size={12} />}</span>
                      <span className="level-title">{item.title}</span>
                      <span className="level-state">{isComplete ? 'DONE' : isActive ? levelActive ? 'NOW' : 'READY' : isUnlocked ? 'OPEN' : 'LOCKED'}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>

          <button className="rank-teaser" onClick={openLeaderboard}>
            <span className="rank-teaser-icon"><Trophy size={17} /></span>
            <span className="rank-teaser-copy"><small>EVENT LEADERBOARD</small><b>Can you crack the top 3?</b></span>
            <ArrowRight size={16} />
          </button>

        </aside>
      </section>

      {toast && <div className="toast" role="status"><Check size={15} /> {toast}</div>}

      {showRanks && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowRanks(false) }}>
          <section className="leaderboard-modal" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title">
            <button className="modal-close" onClick={() => setShowRanks(false)} aria-label="Close leaderboard">×</button>
            <div className="modal-kicker"><Trophy size={14} /> ARCADE SCOREBOARD</div>
            <h2 id="leaderboard-title">Event standings.</h2>
            <p className="modal-subtitle">Highest level ranks first; fastest clear time breaks ties.</p>
            <ol className="score-list">
              {scores.length ? scores.map((score, index) => (
                <li key={`${score.name}-${index}`} className={score.name === playerName ? 'score-you' : ''}>
                  <span className={`score-rank score-rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="score-player">{score.name}{score.name === playerName && <small>YOU</small>}</span>
                  <span className="score-level">LVL {String(score.level).padStart(2, '0')} <i>{formatDuration(score.timeMs)}</i></span>
                </li>
              )) : <li className="score-empty">No runs yet. Be the first to break through.</li>}
            </ol>
            <div className="local-only-note"><LockKeyhole size={13} />{leaderboardStatus === 'online' ? 'Live event rankings are shared across devices.' : 'Showing cached rankings. Shared scores reconnect when the event API is available.'}</div>
            <button className="modal-done" onClick={() => setShowRanks(false)}>BACK TO THE VAULT <ArrowRight size={15} /></button>
          </section>
        </div>
      )}

      {switchPlayerOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !startingPlayer) setSwitchPlayerOpen(false) }}>
          <section className="leaderboard-modal switch-player-modal" role="dialog" aria-modal="true" aria-labelledby="next-player-title">
            <button className="modal-close" onClick={() => setSwitchPlayerOpen(false)} aria-label="Close next player dialog" disabled={startingPlayer}>×</button>
            <div className="modal-kicker"><UserRoundPlus size={14} /> READY FOR THE CHALLENGE?</div>
            <h2 id="next-player-title">Next player.</h2>
            <p className="modal-subtitle">{playerName}'s best score is saved. The next run starts at level 1.</p>
            <form className="switch-player-form" onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              startNextPlayer(form.get('name')?.toString() ?? '', form.get('email')?.toString() ?? '')
            }}>
              <label htmlFor="next-player-name">NAME</label>
              <input id="next-player-name" name="name" autoFocus required maxLength={14} pattern="[A-Za-z0-9 _-]+" placeholder="FULL NAME" disabled={startingPlayer} />
              <label htmlFor="next-player-email">BITS EMAIL ID</label>
              <input id="next-player-email" name="email" type="email" required inputMode="email" autoComplete="email" pattern="f[0-9]{8}@dubai\.bits-pilani\.ac\.in" placeholder="f20260999@dubai.bits-pilani.ac.in" disabled={startingPlayer} />
              <button className="modal-done" type="submit" disabled={startingPlayer}>{startingPlayer ? 'STARTING RUN…' : 'START FRESH RUN'} <ArrowRight size={15} /></button>
            </form>
          </section>
        </div>
      )}

      {restartRunOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isRestartingRun) setRestartRunOpen(false) }}>
          <section className="leaderboard-modal restart-run-modal" role="dialog" aria-modal="true" aria-labelledby="restart-run-title">
            <button className="modal-close" onClick={() => setRestartRunOpen(false)} aria-label="Close restart confirmation" disabled={isRestartingRun}>×</button>
            <div className="modal-kicker"><RotateCcw size={14} /> RUN CONTROLS</div>
            <h2 id="restart-run-title">Restart from level 1?</h2>
            <p className="modal-subtitle">Your current progress will reset. {playerName}'s saved leaderboard best will stay.</p>
            <div className="restart-confirm-actions">
              <button className="restart-cancel" onClick={() => setRestartRunOpen(false)} disabled={isRestartingRun}>KEEP PLAYING</button>
              <button className="modal-done" onClick={() => void restartRun()} disabled={isRestartingRun}>{isRestartingRun ? 'RESTARTING…' : 'RESTART RUN'} <RotateCcw size={14} /></button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
