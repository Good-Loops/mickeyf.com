# mickeyf.com — BeatCalc Web App

This is a dynamic web platform designed to entertain and educate, featuring a curated selection of games, animations, and educational resources focused on music and math. The site aims to be a resource for learning, offering users the ability to explore new concepts through interactive content.

## Documentation

📚 **API Documentation (TypeDoc)**  
https://good-loops.github.io/mickeyf.com/

The documentation covers frontend and backend modules, animation systems, shaders, controllers, and configuration contracts. It is generated directly from the source and published automatically on each push to `main`.

## Features

- In-browser games for entertainment and educational purposes.
- A curated selection of animations to inspire and engage.
- Educational resources aimed at teaching music theory and math concepts.
- Leaderboards and rankings to encourage friendly competition.

## Using the Website

Access [mickeyf.com](https://mickeyf.com) directly from your browser to discover all that it has to offer. Create an account to save your progress in games and see how you rank on leaderboards.

## Educational Content

The app aims to blend learning with play, providing resources that make music and math enjoyable and accessible. Engage with interactive lessons and activities designed to cater to different learning styles.

## Tech Stack

**Client:** React, TypeScript, SASS (Vite)  
**Server:** Node.js, Express  
**Database:** MySQL

## Architecture Overview

The application follows a clear separation of concerns between frontend, backend, and infrastructure:

- **Frontend**
  - Built with React and Vite.
  - Runs entirely in the browser.
  - Communicates with the backend via HTTP APIs.
  - Deployed to Firebase Hosting.

- **Backend**
  - Node.js + Express API.
  - Handles authentication, game data, leaderboards, and persistence.
  - Connects to MySQL via Cloud SQL.
  - Deployed to Google Cloud Run.

- **Database**
  - MySQL hosted on Google Cloud SQL.
  - Accessed locally through the Cloud SQL Proxy.
  - Accessed in production via Cloud Run’s managed connection.

- **Local Development Infrastructure**
  - Docker is used **only** to run the Cloud SQL Proxy.
  - Application processes (frontend and backend) run directly in the developer environment.
  - VS Code restores terminals via workspace settings and starts services automatically.

This design keeps infrastructure concerns isolated from application code while allowing fast local development without containerizing the application itself.

## Local Development

### Prerequisites

- Docker
- Node.js (for frontend & backend)
- WSL (on Windows)

### Environment setup

Create environment files from the examples:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

There are two environment files:

- `.env` (project root) — backend and infrastructure
- `frontend/.env` — frontend (Vite)

Example files are provided:
- `.env.example`
- `frontend/.env.example`

Fill in the required values before starting development.

### Start development

From the project root (WSL):

```bash
./scripts/dev-up.sh
code .
```

This starts required infrastructure (Cloud SQL Proxy via Docker Compose) and opens VS Code.
Frontend and backend processes are started automatically via restored terminals.

### End development session

From the project root (WSL):

```bash
./scripts/dev-down.sh
```

This stops local infrastructure (Cloud SQL Proxy).
