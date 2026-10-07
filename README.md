# PROMPT//BREAK ⚡

A seven-level prompt-injection arcade built for live events. Players test how intentionally vulnerable guardrails respond to adversarial prompts, advance through increasingly complex challenges, and compete on a shared leaderboard.

Gameplay is a deterministic security simulation: prompts are evaluated by server-side challenge rules rather than sent to a live AI model. The seven levels use distinct mechanics, beginning with narrow disclosure and representation flaws before moving into stateful puzzles. The later levels derive evidence from each run's generated vault secret, so players must reason from the guard's replies instead of reusing a fixed walkthrough.

---

## 🛠️ Tech Stack & Architecture

* **Frontend**: React 18, TypeScript, Vite, and custom responsive CSS
* **API**: Vercel Serverless Functions using the Node.js runtime
* **Database**: Supabase PostgreSQL, accessed by the server through its REST API and database procedures
* **Session security**: The browser holds an `HttpOnly`, `SameSite=Strict` session cookie. The database stores a hash of its token and the run's generated passwords; passwords are never included in the initial session response.
* **Progress and scoring**: Server procedures atomically start and complete levels, record elapsed time, and update persistent leaderboard bests. Row-level security keeps session and password tables inaccessible to public clients.

### Project Structure

* `src/App.tsx` contains the game interface, challenge descriptions, registration flow, timer display, and leaderboard UI.
* `src/style.css` contains the responsive arcade theme and component styling.
* `api/game.ts` manages sessions, validates player details and prompts, and handles level progression and run controls.
* `api/scores.ts` returns the verified event leaderboard.
* `supabase/schema.sql` defines session, password-reservation, and leaderboard tables plus the procedures used by the game API.

---

## 🚀 Game Mechanics

* **Seven distinct levels** progress through a route-validation chain, a one-character leak, a custody registry, a reversible mirror, an archive-context flaw, a numeric calibration oracle, and a run-specific codebreaking lock. Later puzzles return feedback and evidence tied to that run's password; the player must retain and use it across prompts.
* **Server-validated progress** ensures the client cannot forge a level completion or password reveal.
* **Player registration** collects a name and a BITS Dubai email in the form `f` + 8 digits + `@dubai.bits-pilani.ac.in`. The leaderboard displays player names; email addresses are kept with game-session data.
* **Fair timing and replay controls** begin the timer only after the player presses **READY? START LEVEL**. Players can retry the current level or restart their run from level 1 while preserving their leaderboard best.
* **Session lifecycle** lets a new player start a fresh run while preserving persistent global bests.
* **Shared leaderboard** ranks verified players by highest level, then by the fastest server-measured time for that level.

---

## 💻 Local Development

### Prerequisites

* Node.js 20+ (Node v24 recommended)
* A Supabase project (the schema can be applied in its SQL Editor)
* Vercel CLI (included as a project dependency)

### Setup

1. **Clone the repository and install dependencies:**

   ```bash
   git clone <repo-url>
   cd Game
   npm install
   ```

2. **Configure local environment variables:**

   ```bash
   cp .env.example .env.local
   ```

   Add your development Supabase credentials to `.env.local`:

   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SECRET_KEY=your_supabase_secret_key
   ```

3. **Initialize the local database schema:**

   Run the DDL script found in `supabase/schema.sql` inside your Supabase project's SQL Editor. Re-run it after updating an existing project so it adds the player email field, per-level start gate, server start timestamp, leaderboard completion-time column, and level/run restart procedures. The timer starts only when the player presses **READY? START LEVEL**. Level times are measured by the server; players rank by highest level, then by fastest clear time for that level. Replaying a level can improve its saved time without removing the player's best score.

4. **Start the local development server:**

   This runs both the frontend and Vercel serverless functions:

   ```bash
   npm run dev:vercel
   ```

5. **Open the application:**

   Visit:

   `http://localhost:3000`

---

## 📄 License

Created for club events and technical showcases.
