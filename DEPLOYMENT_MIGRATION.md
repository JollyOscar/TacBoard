# Deployment and Migration Guide

## Runtime Modes

The server supports two persistence modes:

- File mode (default): used when `DATABASE_URL` is not set.
- PostgreSQL mode: used when `DATABASE_URL` is set.

## Environment Variables

- `PORT`
  - Optional. Default: `3000`.
- `DATABASE_URL`
  - Optional. If present, server uses PostgreSQL.

## Local Development

1. Install dependencies:
   - `npm install`
2. Start server:
   - `npm start`
3. Open:
   - `http://localhost:3000`

## Railway Deployment

1. Create a Railway project.
2. Add a PostgreSQL service.
3. Set app environment variable:
   - `DATABASE_URL` from Railway Postgres.
4. Ensure start command is:
   - `npm start`
5. Deploy.

## Database Initialization and Migration Behavior

On startup, the server runs additive initialization only:

- `CREATE TABLE IF NOT EXISTS presets`
- `CREATE TABLE IF NOT EXISTS recordings`
- `CREATE TABLE IF NOT EXISTS playbooks`

This does not drop or truncate existing tables and does not remove existing records.

## Existing Data Safety

- File-mode data is stored in:
  - `board-presets.json`
  - `board-recordings.json`
  - `board-playbooks.json`
- PostgreSQL-mode writes to DB and still saves file backups for recordings/presets/playbooks paths where implemented.
- Current code path is non-destructive on startup.

## Smoke Checks After Deploy

1. Join a room as host.
2. Join from a second client and approve request.
3. Add/move tokens and draw strokes.
4. Save/load a preset.
5. Record and replay.
6. Save/start a playbook.
7. Verify host controls:
   - kick
   - ban
   - room lock

## Optional Stress Checks

- `npm run stress:20`
- `npm run stress:20:soak5m`
- `node stress-10users-heavy.js`
- `node stress-10users-rigorous.js`

## Rollback Notes

- Application rollback is code-level (redeploy previous commit).
- DB schema changes are additive in current implementation, so rollback should not require destructive DB operations.
