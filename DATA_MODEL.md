# Tac Board Data Model and Schemas

This file summarizes the runtime model and persistence schema used by Tac Board.

## Runtime Room Model

Each room has isolated board state:

```js
{
  users: { [socketId]: { id, username, color } },
  hostId: string | null,
  bannedUsers: { [normalizedUsername]: { username, addedAt, by } },
  locked: boolean,
  strokes: Stroke[],
  tokens: { [tokenId]: Token },
  arrows: Arrow[],
  nextTokenId: number,
  nextArrowId: number,
  colorIndex: number,
  rec: {
    active: boolean,
    start: number,
    snapshot: BoardSnapshot | null,
    timeline: TimelineEntry[]
  },
  rep: {
    active: boolean,
    interval: NodeJS.Timeout | null,
    preSnap: BoardSnapshot | null,
    currentRecId: number | null,
    isPlaying: boolean,
    playbackPosition: number,
    lastTick: number
  },
  play: {
    active: boolean,
    playbookId: number | null,
    stepIndex: number,
    timeoutIds: NodeJS.Timeout[]
  }
}
```

## Core Entity Shapes

### User
```js
{ id, username, color, isHost? }
```

### Token
```js
{ id, x, y, color, label, shape, createdBy }
```

### Stroke
```js
{ id, socketId, tool, points: [{x,y}], color, width, timestamp }
```

### Arrow
```js
{ id, socketId, tool, x1, y1, x2, y2, color, width, style }
```

### Board Snapshot
```js
{
  strokes: Stroke[],
  arrows: Arrow[],
  tokens: { [tokenId]: Token }
}
```

### Recording
```js
{
  id,
  name,
  timestamp,
  duration,
  eventCount,
  snapshot: BoardSnapshot,
  timeline: [{ t, event, data }]
}
```

### Preset
```js
{
  id,
  name,
  timestamp,
  strokes: Stroke[],
  arrows: Arrow[],
  tokens: { [tokenId]: Token }
}
```

### Playbook
```js
{
  id,
  name,
  timestamp,
  steps: [
    {
      name,
      duration,
      tokens: { [tokenId]: Token }
    }
  ]
}
```

## File Persistence (no DATABASE_URL)

- `board-recordings.json`
  - `{ recordings: Recording[], nextId: number }`
- `board-presets.json`
  - `{ presets: Preset[], nextId: number }`
- `board-playbooks.json`
  - `{ playbooks: Playbook[], nextId: number }`

## PostgreSQL Tables (when DATABASE_URL exists)

- `recordings`
  - `id SERIAL PRIMARY KEY`
  - `name TEXT NOT NULL`
  - `timestamp BIGINT NOT NULL`
  - `duration INTEGER NOT NULL`
  - `event_count INTEGER NOT NULL`
  - `data JSONB NOT NULL`
  - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

- `presets`
  - `id SERIAL PRIMARY KEY`
  - `name TEXT NOT NULL`
  - `timestamp BIGINT NOT NULL`
  - `data JSONB NOT NULL`
  - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

- `playbooks`
  - `id SERIAL PRIMARY KEY`
  - `name TEXT NOT NULL`
  - `timestamp BIGINT NOT NULL`
  - `step_count INTEGER NOT NULL`
  - `data JSONB NOT NULL`
  - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

## Non-Destructive Migration Rule

Server initialization uses additive migrations only (`CREATE TABLE IF NOT EXISTS`). Existing data is never dropped or rewritten as part of startup.
