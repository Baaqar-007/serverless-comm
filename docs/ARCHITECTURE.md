# PeerSpace — Architecture

A map of how PeerSpace works, for contributors.

## Overview

PeerSpace is a browser-to-browser meeting room (video, chat, shared document, file
transfer, live transcript). Browsers talk **directly** over WebRTC. A small signaling
server only helps them find each other.

| Piece | Where | Job |
|---|---|---|
| Static site (`peerspace/`) | Vercel | Serves the HTML/JS/CSS |
| `/api/ice` (`peerspace/api/ice.js`) | Vercel serverless | Returns STUN/TURN configuration (TURN credentials come from environment variables) |
| Signaling server (`server/server.js`) | Render | Socket.io: manages rooms and relays handshake messages. Carries no media or user content |

Once peers are connected, video, chat, document edits, files and transcripts flow
directly between browsers (or through a TURN relay when a direct path is impossible).

## Topology

Full mesh, up to 4 peers per room (limit enforced in `server/server.js`).
Each peer holds one connection to every other peer.

## Connection lifecycle

1. The page loads `room.html?r=<ROOM>&n=<NAME>`; a random peer ID is generated per page load.
2. `signaling.js` connects to the server and joins the room.
3. The server returns the list of peers already present.
4. The newcomer announces its name to each peer; they acknowledge.
5. The peer with the lexically **lower** ID sends the offer. This deterministic
   tie-break prevents both sides offering at once ("glare").
6. The offerer creates five DataChannels; the answerer receives them.
7. When all five are open, the session goes live.

ICE candidates are buffered in two places: before the connection object exists
(`room.js`) and before the remote description is set (`connection.js`).

### DataChannels (`config.js`)

| Label | Delivery | Carries |
|---|---|---|
| `ps:doc` | ordered | Document edits (Quill Deltas) |
| `ps:chat` | ordered | Chat messages |
| `ps:file` | ordered | File chunks |
| `ps:ctrl` | unordered, no retransmits | Pings, media-state |
| `ps:transcript` | ordered | Finished transcript chunks |

## Modules (`peerspace/js/`)

| File | Responsibility |
|---|---|
| `config.js` | Constants, ICE configuration helper |
| `signaling.js` | Socket.io client wrapper |
| `connection.js` | One `RTCPeerConnection` and its DataChannels per remote peer |
| `room.js` | Orchestrator and UI rendering |
| `chat.js` | Chat over `ps:chat` |
| `doc-sync.js` | Document edit sync over `ps:doc` |
| `file-transfer.js` | Chunked file transfer |
| `transcription.js` | Mic → AudioWorklet → voice-activity detection → speech-to-text worker |
| `transcript-store.js` | In-memory transcript |
| `workers/` | Audio processor, transcription worker, summariser worker |

## Transcription

Each peer transcribes **its own microphone** locally (in-browser model) and
broadcasts the resulting text, so everyone sees one merged transcript. A separate
worker produces a post-meeting summary.

## Sensitive areas

The connection handshake / ICE handling (`connection.js` and the related parts of
`room.js`) and the transcription pipeline were tuned over many real-device tests
across networks. Please keep changes there small, isolated, and manually tested
(different networks, 3–4 peers, reconnect scenarios) before proposing them.

## Local development

```bash
cd server && npm install && npm start     # signaling server on :3000
cd peerspace && npx serve .               # static frontend
```

Camera/microphone access requires a secure context: `localhost` works; other
devices need HTTPS (for example a deployment preview).
