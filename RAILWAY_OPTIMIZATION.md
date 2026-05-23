# Railway Optimization Runbook

This runbook is for post-push optimization once Railway auth and project linkage are available.

## Current Blocker

From local CLI status:
- OAuth token refresh failed.
- No linked Railway project in this workspace.

Required manual step:
1. Run `railway login` in terminal and complete auth flow.
2. Run `railway link` and select the target project/service.

## Post-Link Optimization Sequence

1. Verify environment and service:
   - `railway status`
   - `railway variables`

2. Ensure required variables are set:
   - `DATABASE_URL`
   - `NODE_ENV=production`

3. Confirm deployment command:
   - Start command should be `npm start`

4. Deploy latest code:
   - `railway up`

5. Validate health endpoint:
   - Open `https://<your-service-domain>/health`
   - Expect JSON status with rooms/users/uptime

6. Validate websocket behavior quickly:
   - Open two clients
   - Join same room
   - Confirm join approval, drawing, token movement

7. Run external stress pass against Railway URL:
   - `STRESS_URL=https://<your-service-domain> USERS=20 node stress-suite.js`

## Recommended Runtime Targets

- Keep app single-process for Socket.IO room consistency unless adding shared adapter.
- Use PostgreSQL mode in production (`DATABASE_URL` present).
- Keep non-destructive migrations only (`CREATE TABLE IF NOT EXISTS`).

## Quick Rollback

1. Re-deploy prior commit from GitHub integration or CLI.
2. Do not run destructive DB commands.

## Notes

- Current project already includes:
  - `GET /health` endpoint
  - stress scripts
  - room-scoped socket broadcast fixes
  - host moderation and room lock controls

## Execution Result (2026-05-23)

Completed in this workspace:

1. `railway login` completed.
2. `railway link` completed to:
   - project: `incredible-rejoicing`
   - service: `TacBoard`
   - environment: `production`
3. `railway up` completed successfully.
4. Production health check passed at:
   - `https://tacboard-production.up.railway.app/health`
5. Production stress pass executed with:
   - `STRESS_URL=https://tacboard-production.up.railway.app`
   - `USERS=10`
   - `SCALE_ITERATIONS=25`
   - `SOAK_DURATION_MS=45000`
   - result: `pass: true`
6. Post-stress health check returned to idle (`rooms: 0`, `users: 0`).
