# Backend

Backend API for the education platform.

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Framework:** Express 5
- **Database:** MongoDB / Mongoose
- **Validation:** Zod
- **Security:** Helmet, CORS

## Project Structure

```text
src/
├── config/          # Environment and app configuration
├── database/        # MongoDB connection management
├── errors/          # AppError and error classes
├── middleware/       # Express middleware (error handler, validation, logging)
├── modules/         # Feature-based modules
│   └── health/      # Health check endpoint
├── utils/           # Shared utilities (logger, async handler, API responses)
├── app.ts           # Express app factory
└── server.ts        # Server entry point
```

## Getting Started

1. Copy `.env.example` to `.env` and fill in required values
2. Ensure MongoDB is running
3. Install dependencies: `npm install`
4. Run in development: `npm run dev`
5. Build for production: `npm run build`
6. Start production: `npm start`

## Scripts

- `npm run dev` — Start development server with hot reload
- `npm run build` — Compile TypeScript to JavaScript
- `npm start` — Run compiled production build
- `npm run typecheck` — Run TypeScript type checking
- `npm run lint` — Run ESLint
- `npm run lint:fix` — Run ESLint with auto-fix

## API Endpoints

### Health

- `GET /api/health` — Application health check
