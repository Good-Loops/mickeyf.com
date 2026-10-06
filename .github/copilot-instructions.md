You are helping implement features and refactors in this repository. Prioritize correctness, clean architecture, and minimal diffs.

## 1) Repo overview (what you’re working in)
- This is a web platform with a **frontend** and a **backend**, written in **TypeScript**.
- **Frontend**
  - Stack: React + Vite + TypeScript + SASS
  - Hosted on **Firebase Hosting**
- **Backend**
  - Stack: Node.js + Express + TypeScript
  - Bundled with **webpack**
  - Containerized with **Docker**
  - Deployed to **Google Cloud Run**
  - Uses **Cloud SQL (MySQL)** in production

## 2) Golden rules (Clean Code / maintainability)
- Prefer small, focused functions and modules (Single Responsibility).
- Use intention-revealing names; avoid vague or abbreviated identifiers.
- Keep side effects at the edges (API calls, DOM, audio, timers).
- Avoid duplication; extract helpers when logic repeats.
- Optimize for readability first, cleverness last.

## 3) Safety & secrets (critical)
- **Never** hardcode, log, or recreate secrets (API keys, DB credentials, session secrets).
- Reference environment variables by name only.
- If a new env var is required, document it—do not provide example values.

## 4) Project structure (where code goes)
Follow the existing folder boundaries. Do not introduce new top-level patterns unless necessary.

### Frontend
- Entry: `frontend/ts/main.tsx`
- App shell / routing: `frontend/ts/App.tsx`
- Layout/UI shell: `frontend/ts/Header.tsx`
- Pages: `frontend/ts/pages/**`
- Animations & interactive visuals: `frontend/ts/animations/**`
- Shared utilities: `frontend/ts/utils/**`
- Styling (SASS structure):
  - `frontend/sass/abstracts`
  - `frontend/sass/base`
  - `frontend/sass/components`
  - `frontend/sass/layout`
  - `frontend/sass/pages`

### Backend
- App entry: `backend/ts/app.ts`
- Controllers: `backend/ts/controllers/**`
- Routers: `backend/ts/routers/**`
- Database pool: `backend/ts/db/dbConfig.ts`
- Validated environment configuration: `backend/ts/config/**`
- Shared types: `backend/ts/types/**`

## 5) Code style requirements
### TypeScript
- Prefer explicit types at module boundaries.
- Avoid `any`; if unavoidable, isolate it and explain why.
- Prefer pure functions for reusable logic.
- Use early returns instead of deep nesting.

### React
- Use functional components only.
- Keep page components thin; extract reusable logic/components.
- Do not introduce new state management libraries unless explicitly requested.

### SASS / CSS
- Use existing SASS structure and variables.
- Avoid magic numbers for layout; prefer responsive patterns.
- Reuse tokens/mixins from `sass/abstracts`.

## 6) Environment & configuration conventions
- Frontend:
  - Use `import.meta.env.*` (Vite convention).
- Backend:
  - Use `process.env.*`.
- Do not introduce alternative config systems.
- New env vars must be named clearly and documented.

## 7) Runtime & deploy constraints
- Backend:
  - Cloud Run listens on port `8080`.
  - Do not change port logic without updating deployment config.
- Frontend:
  - Firebase Hosting serves a SPA.
  - Client-side routing relies on a catch-all rewrite to `index.html`.
- Database:
  - Production DB is Cloud SQL (MySQL).
  - Avoid DB-specific hacks unless necessary.

## 8) Change hygiene (required)
- Keep diffs small and focused.
- Do not reformat unrelated files.
- Keep import style consistent within a file.
- Add comments only where logic is non-obvious.
- Verify builds still succeed after changes.

## 9) Copilot self-check (before coding)
- Am I working in the correct layer (frontend vs backend)?
- Is there existing code that already solves part of this?
- Can this change be smaller or more isolated?
- Did I avoid touching secrets or env values?
- Does this respect the current folder and naming conventions?

## 10) How to present proposed changes
When suggesting changes, use this structure:
1) **Intent** – what problem this solves
2) **Files to change** – list with paths
3) **Patch** – minimal code blocks per file
4) **Notes** – edge cases or follow-ups

Focus on clean, safe, incremental improvements.
