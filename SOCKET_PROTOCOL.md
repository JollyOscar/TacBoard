# Tac Board Socket Protocol Reference

This document describes Socket.IO events used by the realtime board.

## Connection and Room Flow

### Client -> Server
- `join`
  - Payload: `{ username, room }`
  - Notes: username and room are sanitized server-side.
- `room-join-response`
  - Payload: `{ requestId, allow }`
  - Notes: host-only action; approves/denies a pending join request.

### Server -> Client
- `init-state`
  - Payload: `{ strokes, tokens, arrows, users, you, room, hostUsername, roomLocked, recActive, repActive, repDuration, repPosition, repPaused }`
- `join-pending-approval`
  - Payload: `{ room, host }`
- `join-approved`
  - Payload: `{ room }`
- `join-denied`
  - Payload: `{ room, reason }`
- `room-join-request`
  - Payload: `{ requestId, room, username }`
- `room-join-request-expired`
  - Payload: `{ requestId, username, room, reason }`
- `user-joined`
  - Payload: user object
- `user-left`
  - Payload: user object
- `user-list`
  - Payload: user array with `isHost`
- `room-removed`
  - Payload: `{ room, reason }`

## Host Administration

### Client -> Server
- `host-kick-user`
  - Payload: `{ userId }`
- `host-ban-user`
  - Payload: `{ userId }`
- `room-lock-set`
  - Payload: `{ locked }`

### Server -> Client
- `room-lock-state`
  - Payload: `{ locked, by }`

## Realtime Board Events

### Client -> Server
- `draw-move`
  - Payload: `{ tool, width, points }`
- `board-ping`
  - Payload: `{ x, y, color }`
- `stroke-done`
  - Payload: stroke object
- `stroke-remove`
  - Payload: `{ ids }`
- `arrow-done`
  - Payload: arrow object
- `arrow-remove`
  - Payload: `{ ids }`
- `cursor-move`
  - Payload: `{ x, y }`
- `token-add`
  - Payload: token draft object
- `token-move`
  - Payload: `{ id, x, y }`
- `token-remove`
  - Payload: `{ id }`
- `token-relabel`
  - Payload: `{ id, label }`
- `clear-board`
- `clear-drawings`

### Server -> Client
- `draw-move`
- `board-ping`
- `stroke-done`
- `stroke-remove`
- `arrow-done`
- `arrow-confirmed`
- `arrow-remove`
- `cursor-move`
- `cursor-remove`
- `token-add`
- `token-move`
- `token-remove`
- `token-relabel`
- `clear-board`
- `tokens-cleared`

## Recording and Replay

### Client -> Server
- `recording-start`
- `recording-stop`
- `get-recordings`
- `rename-recording` with `{ recId, newName }`
- `delete-recording` with `{ recId }`
- `replay-start` with `{ recId }`
- `replay-stop`
- `replay-pause`
- `replay-resume`
- `replay-seek` with `{ position }`

### Server -> Client
- `recording-started`
- `recording-saved`
- `recordings-list`
- `replay-started`
- `replay-init`
- `replay-sync-state`
- `replay-paused`
- `replay-resumed`
- `replay-stopped`
- `replay-done`
- `replay-restore`

## Presets

### Client -> Server
- `save-preset` with `{ name }`
- `load-preset` with `{ presetId }`
- `rename-preset` with `{ presetId, newName }`
- `delete-preset` with `{ presetId }`
- `get-presets`
- `import-board` with `{ strokes, arrows, tokens }`

### Server -> Client
- `preset-saved`
- `preset-loaded`
- `presets-list`

## Playbooks

### Client -> Server
- `save-playbook` with `{ name, steps }`
- `rename-playbook` with `{ playbookId, newName }`
- `delete-playbook` with `{ playbookId }`
- `get-playbooks`
- `playbook-start` with `{ playbookId }`
- `playbook-stop`

### Server -> Client
- `playbook-saved`
- `playbooks-list`
- `playbook-started`
- `playbook-step`
- `playbook-stopped`
- `playbook-finished`

## Validation Notes

- Server applies type checks and sanitization on high-risk payloads.
- Room lock (`room.locked`) blocks non-host board mutations.
- Join moderation and host controls are room-scoped.
- List refresh broadcasts for recordings/presets/playbooks are scoped to the actor room.
