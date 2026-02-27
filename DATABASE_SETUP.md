# Database Setup for Railway

To enable persistent storage of board presets and recordings on Railway:

## Steps:

1. **Add PostgreSQL to your Railway project:**
   - Go to your Railway project dashboard
   - Click "New" → "Database" → "Add PostgreSQL"
   - Railway will automatically create a `DATABASE_URL` environment variable

2. **Redeploy your application:**
   - The app will automatically detect the `DATABASE_URL` and use PostgreSQL
   - Tables will be created automatically on first run
   - You'll see "PostgreSQL database configured" in the logs

3. **Verify it's working:**
   - Check deploy logs for: `[+] PostgreSQL database configured`
   - Check logs for: `[+] Database tables initialized`
   - Create a board preset - it should now survive redeployments!

## Local Development:

Without `DATABASE_URL`, the app falls back to JSON files for storage:
- `board-presets.json`
- `board-recordings.json`

This allows local development without needing PostgreSQL installed locally.

## How It Works:

- **Production (Railway with DATABASE_URL):** PostgreSQL database (persistent)
- **Production (Railway without DATABASE_URL):** JSON files (ephemeral - lost on redeploy)
- **Local:** JSON files (persistent on your machine)
