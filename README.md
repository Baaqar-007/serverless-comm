# PeerSpace

**Serverless P2P collaboration — video, chat, documents, files, and live transcription. No accounts. No data retention. Nothing stored.**

🌐 **[peerspace-xi.vercel.app](https://peerspace-xi.vercel.app)**

---

## What it is

PeerSpace is a browser-based collaboration room where all session data — video, audio, chat, shared documents, file transfers, and transcripts — flows directly between peers over WebRTC. The only server involved is a lightweight Socket.io signaling relay used to bootstrap the connection. Once peers are connected, the relay is out of the loop entirely.

No accounts. No logins. No stored sessions. When the room closes, nothing persists.

---

## Features

### Communication
- **Video & audio** — up to 4 simultaneous peers, dynamic grid layout
- **Live chat** — with typing indicators, all P2P
- **Mute / camera toggle** — state broadcast to all peers instantly

### Collaboration
- **Shared document (Canvas)** — real-time collaborative rich-text editor powered by Quill, with Delta-based sync over DataChannel
- **File transfer (Matter)** — direct P2P file transfer, chunked at 64KB, with progress tracking. Files never touch a server

### Transcription & Summarisation
- **Live transcription** — powered by [Moonshine](https://github.com/usefulsensors/moonshine), a purpose-built on-device ASR model. Audio is processed entirely in the browser via ONNX Runtime (WebGPU accelerated where available, WASM fallback). Nothing is sent to any external service
- **Post-meeting summary** — on demand, generates meeting minutes, action items, and extracted references using a local summarisation model. Exportable to Word
- **Speaker-labelled transcript** — each peer's transcript chunks are broadcast over the dedicated `ps:transcript` DataChannel so all peers share the same live feed

### Privacy
- All session data is peer-to-peer after the initial handshake
- Transcription and summarisation run entirely on-device
- No analytics, no telemetry, no third-party scripts
- TURN relay credentials are stored in server environment variables — never shipped in client source

---

## Architecture

### Connection Sequence (UML)

![Sequence Diagram](images/WebRTC%20Peer-to-Peer%20Sync-2026-05-12-180018.png)

### Client Component Structure (UML)

![Component Diagram](images/WebRTC%20Peer-to-Peer%20Sync-2026-05-12-181309.png)


**DataChannels:**

| Label | Purpose |
|---|---|
| `ps:doc` | Quill Delta document sync |
| `ps:chat` | Chat messages + typing indicators |
| `ps:file` | Chunked binary file transfer |
| `ps:ctrl` | Ping/pong RTT stats, media state |
| `ps:transcript` | Live transcript chunks |

---

## Stack

**Frontend** — Vanilla JS, no framework, no bundler. Runs directly from static files.

**WebRTC** — Native browser `RTCPeerConnection`. ICE config (including TURN) fetched at connection time from `/api/ice` — credentials live in Vercel environment variables.

**Transcription** — [Moonshine base](https://huggingface.co/onnx-community/moonshine-base-ONNX) via `@huggingface/transformers` v3. VAD-gated segmentation with a 5s forced flush for continuous speech. OfflineAudioContext handles resampling to 16kHz.

**Summarisation** — `Xenova/distilbart-cnn-6-6` via `@xenova/transformers` v2, running in a dedicated Web Worker.

**Signaling server** — Node.js + Socket.io, deployed on [Render](https://render.com).

**Hosting** — [Vercel](https://vercel.com) (static + serverless `/api/ice` function).

---

## Running locally

No build step required.

```bash
git clone https://github.com/Baaqar-007/serverless-comm
cd serverless-comm/peerspace
```

Serve with any static file server — the browser requires a secure context (HTTPS or localhost) for `getUserMedia` and AudioWorklet:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Open `http://localhost:8080` in two tabs. Enter different names, generate a room code in one tab, paste it into the other.

**Note:** The signaling server at `peerspace-k66e.onrender.com` is on Render's free tier and spins down after 15 minutes of inactivity. First connection of the day may take 30–50 seconds while it cold-starts.

---

## Deployment

### Frontend (Vercel)

```bash
vercel deploy
```

Set the following environment variables in Vercel dashboard → Settings → Environment Variables:

```
TURN_USER      your-metered-username
TURN_PASS      your-metered-credential
TURN_URL_UDP   turn:global.relay.metered.ca:80
TURN_URL_TCP   turn:global.relay.metered.ca:80?transport=tcp
TURN_URL_443   turn:global.relay.metered.ca:443
TURN_URL_TLS   turns:global.relay.metered.ca:443?transport=tcp
```

### Signaling server

The server lives in `/server`. Deploy to any Node host. Render, Railway, and Fly.io all work. Update `SERVER_URL` in `signaling.js` to match.

---

## Browser support

| Browser | Video/Audio | Transcription |
|---|---|---|
| Chrome 113+ | ✅ | ✅ WebGPU accelerated |
| Chrome < 113 | ✅ | ✅ WASM fallback |
| Edge | ✅ | ✅ |
| Firefox | ✅ | ✅ WASM fallback |
| Safari | ✅ | ⚠️ WASM only, slower |

Chrome is recommended for best transcription performance.

---

## Known limitations

- Max 4 peers per room
- Transcription is English-only (Moonshine base)
- First transcription result appears ~15–20s after joining (model download on first use, cached after)
- Summarisation model (~130MB) downloads on first "Summarise Now" click
- The signaling server on Render free tier has a cold-start delay

---

## Roadmap

- [ ] Phase 2: hardware-adaptive model selection (whisper-tiny → moonshine-base → moonshine-small based on device capability)
- [ ] Persistent room history (opt-in, local only via IndexedDB)
- [ ] Screen sharing
- [ ] Mobile layout

---

## License

MIT