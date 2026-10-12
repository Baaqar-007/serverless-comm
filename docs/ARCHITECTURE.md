# PeerSpace — Architecture

> Written as a map of how the project works *today*, not how it should work.
> Keep it updated when behaviour changes. Items marked **(unverified)** are
> things read from the code but not yet confirmed in a browser.

## 1. The big picture

PeerSpace is a browser-to-browser meeting room (video, chat, shared doc,
file transfer, live transcript). Browsers talk **directly** over WebRTC.
Two small pieces of server infrastructure exist only to help them find each other:

| Piece | Where | Job |
|---|---|---|
| Static site (`peerspace/`) | Vercel (auto-deploys `main`) | Serves the HTML/JS/CSS |
| `/api/ice` (`peerspace/api/ice.js`) | Vercel serverless | Returns STUN + TURN config (TURN creds come from env vars) |
| Signaling server (`server/server.js`) | Render (free tier) | Socket.io "switchboard": rooms + relays handshake messages. Carries **no** media or user content |

Once two browsers are connected, video, chat, doc edits, files and transcripts
never touch a server (except TURN relay, which only forwards encrypted bytes).

```
 Browser A ──┐                         ┌── Browser B
             │   1. join-room / signal │
             └──────► Render (Socket.io) ◄──────┘
             │
             └────────── 2. WebRTC (direct, or via TURN) ──────────┘
```

## 2. Topology: full mesh, max 4

Every peer connects to every other peer: 4 people = 3 connections each.
`ROOM_MAX = 4` is enforced server-side (`server.js`). That is the only place the limit lives.

## 3. Connection lifecycle (the part that took weeks to get right)

1. Page loads `room.html?r=<ROOM>&n=<NAME>`. A random `MY_ID` (UUID) is generated per page load.
2. `signaling.js` connects to the Socket.io server and emits `join-room(roomId, peerId)`.
3. Server replies `peer-list` (who is already there) and tells others `peer-joined`.
4. The newcomer sends an `announce` (name) to each existing peer; they reply `announce:ack`.
5. **Who offers?** The peer whose `MY_ID` is lexically **lower** creates the offer.
   This deterministic tie-break prevents "glare" (both sides offering at once).
6. The offerer creates **5 DataChannels**; the answerer receives them via `ondatachannel`.
7. When all 5 are open → `channels-ready` → chat/doc/file/transcript managers are wired and the session goes live.

### DataChannels (`config.js → PS.DC`)

| Label | Options | Carries |
|---|---|---|
| `ps:doc` | ordered | Quill Deltas (document edits) |
| `ps:chat` | ordered | Chat messages |
| `ps:file` | ordered | File chunks (64 KB each) |
| `ps:ctrl` | **unordered, maxRetransmits 0** | Pings (every 2 s), media-state, etc. Loss is acceptable |
| `ps:transcript` | ordered | Finished transcript chunks |

### ICE candidate buffering (two layers — both are needed)

- `room.js` `_pendingIceBuf`: candidates that arrive **before the `Connection` object exists** (it is built asynchronously after an `await getIceConfig()`).
- `connection.js` queue: candidates that arrive **before `setRemoteDescription` completes**.

### Failure handling

- `connection.js` reacts to ICE `disconnected` (delayed recovery check) and `failed` (ICE restart attempt).
- `room.js` also listens to `conn-state` and may remove the peer when the state is `failed`/`closed`.
- **(unverified)** These two paths may race, making the ICE-restart path effectively unreachable. Real-world reconnect works, so *do not remove either until logging shows which path actually recovers connections.*

## 4. Signaling server (`server/server.js`)

- Events: `join-room`, `signal` (relay; directed with `to`, otherwise broadcast to room), `disconnect` → `peer-left`.
- Rooms are an in-memory `Map`: restarting the server forgets all rooms (clients are expected to reconnect and re-join).
- CORS is `*`. Any client can join any room by knowing its code (no auth).
- On Render's free tier the service sleeps after inactivity and takes a while to wake; Uptime Robot pings it to avoid that.

## 5. Feature modules (`peerspace/js/`)

| File | Responsibility |
|---|---|
| `config.js` | Constants, `getIceConfig()`, ID helpers, `selectModels()` (currently unused by the transcription code, which hardcodes its model) |
| `signaling.js` | Socket.io client wrapper (server URL is hardcoded here) |
| `connection.js` | One `RTCPeerConnection` + its DataChannels per remote peer |
| `room.js` | Orchestrator **and** the whole `UI` object (~1100 lines). Peer records, handshake, media, teardown, rendering |
| `chat.js` | Chat over `ps:chat` |
| `doc-sync.js` | Broadcasts Quill Deltas over `ps:doc` (no CRDT/OT; no initial-state sync) |
| `file-transfer.js` | Chunked transfer; whole file read into memory; fixed 8 ms pause per 64 KB chunk (no backpressure) |
| `transcription.js` | Mic → AudioWorklet → energy VAD → segments → Moonshine worker |
| `transcript-store.js` | In-memory transcript list |
| `workers/audio-processor.js` | AudioWorklet: slices mic into frames |
| `workers/transcription.worker.js` | Runs Moonshine (Transformers.js) |
| `workers/summarizer.worker.js` | Runs distilbart summariser + crude action-item regexes |

## 6. Transcription pipeline (tuned — treat carefully)

Each peer transcribes **only their own mic**, then broadcasts the text, so every
participant sees one merged feed.

Key tuned constants (`transcription.js`): `SPEECH_THRESHOLD = 0.004`,
`SILENCE_CLOSE_MS = 1200`, `MIN_SEGMENT_MS = 400`, resample target `16000` Hz.
`room.js` requests the mic with **echoCancellation / noiseSuppression /
autoGainControl all `false`** on purpose (raw signal for the recogniser).
Side effect: the *same stream* is sent to peers, so call audio is not echo-cancelled.

## 7. Third-party loads

CDN scripts: Socket.io client, Quill, Transformers.js (in workers), Google Fonts.
STUN: Google. TURN: from env vars. (No SRI hashes. The workers' Transformers.js
import should be version-pinned.)

## 8. Protected zones (change only on a dedicated branch + manual test)

1. `connection.js` and the handshake / ICE-buffering / teardown logic in `room.js`
2. `transcription.js`, both transcription-related workers, `audio-processor.js`, and the mic constraints in `room.js`

## 9. Known issues backlog (not yet fixed)

Open items (see the polish plan):

- Share link includes your name, so the friend who opens it joins as you
- Name is URL-decoded twice (`decodeURIComponent` on an already-decoded value), so a `%` in a name can crash the room
- Doc: no initial sync for late joiners, can double-send after everyone leaves and someone rejoins, diverges under concurrent edits
- Summariser starts on `beforeunload` (closing the tab)
- `ice.js` can emit `urls: undefined` if an env var is missing
- Dead UI: stage strip, byte/ICE/cycle stats, typing indicator (UI phase)

Fixed: the missing `js/model-config.js` script tag, dead config constants, and
stale README/lobby text (`chore/cleanup`).
