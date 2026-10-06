# PROMPT//BREAK ⚡

An adversarial prompt-injection challenge game designed to test security intuition and LLM guardrail bypass techniques. Built for tech events and competitions with server-managed session tracking and a shared leaderboard.

---

## 🛠️ Tech Stack & Architecture

* **Frontend**: React 18, TypeScript, Vite, custom CSS
* **Backend & APIs**: Vercel Serverless Functions (Node.js / TypeScript runtime)
* **Database & Storage**: Supabase (PostgreSQL) with row-level safety and transaction procedures
* **Session & Security Architecture**:

  * Stateless frontend paired with server-managed session tokens (`HttpOnly` cookie context)
   * Cryptographically generated per-session passwords stored server-side until a level is solved
  * Serverless API routes isolating game logic from client-facing code
  * Atomic database transactions enforcing accurate high-score ledger indexing

---

## 🚀 Key Features

* **Adversarial Puzzle Progression**: 7 progressively hardened challenge levels evaluating prompt defense strategies.
* **Cheating & Replay Mitigation**: Target secrets are validated server-side; browser state cannot forge level progression.
* **Ephemeral Session Lifecycle**: Runs can be seamlessly retired or reset on stall handoffs without altering persistent global bests.
* **Shared Leaderboard**: Players rank by highest level reached, with the server-measured time to clear that level as the tie-breaker.

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

   Run the DDL script found in `supabase/schema.sql` inside your Supabase project's SQL Editor. Re-run it after updating an existing project so it adds the per-level start gate, server start timestamp, and leaderboard completion-time columns. The timer starts only when the player presses **READY? START LEVEL**. Level times are measured by the server; players rank by highest level, then by fastest clear time for that level.

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