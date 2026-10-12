# PeerSpace — Manual Test Checklist

Run on the **Vercel preview URL** of the branch, never on `main`.
Nothing merges to `main` until the relevant rows pass.

## Before you start

- [ ] Vercel env vars (TURN_*) are enabled for the **Preview** environment (otherwise previews silently fall back to STUN-only)
- [ ] Preview deployment is reachable from other devices (Deployment Protection off or a shareable link used)
- [ ] Browser DevTools console open on at least one device (look for red errors and 404s)

## Setup matrix

| Setup | Why it matters |
|---|---|
| A. Two tabs, same laptop | Fast sanity check only — proves nothing about networks |
| B. Laptop (Wi-Fi) + phone (**mobile data**) | Different networks → forces TURN / NAT traversal |
| C. 3–4 peers | Mesh handshake, glare tie-break, bandwidth |

## Core checks (run on B at minimum; C before any merge touching connection code)

**Join / handshake**
- [ ] Both peers see each other's video + audio within ~10 s
- [ ] Status shows "P2P Live (n peers)"
- [ ] Room-full: a 5th peer is rejected cleanly
- [ ] Names with `%`, `&`, spaces and emoji do not break joining

**Reconnect (high-value — took weeks to build)**
- [ ] Refresh one peer's tab: it rejoins and the others recover
- [ ] Toggle one device's Wi-Fi off/on for ~5 s: call recovers without manual refresh
- [ ] Switch a phone from Wi-Fi to mobile data mid-call
- [ ] Last peer leaves, then someone rejoins the same room: everything still works

**Chat / files / doc**
- [ ] Chat both directions
- [ ] Send a 1 MB and a ~50 MB file; downloads match (compare size)
- [ ] Doc edits appear on the other side; **new joiner sees the current text** (known failing today)
- [ ] After everyone leaves and rejoins, one keystroke produces **one** character on the other side (known double-send bug)

**Transcription (tuned — compare against baseline)**
- [ ] Model loads (progress visible), first transcript appears
- [ ] Speak a few sentences: text accuracy comparable to before the change
- [ ] Mute: no transcription while muted
- [ ] Remote speech is **not** transcribed twice (headphones off / speakers on)
- [ ] "End Meeting" produces a summary; closing the tab does **not** start a download

**Lobby / UX**
- [ ] "Copy link" → open in another browser → joins the same room under a *different* name
- [ ] Cold start: first visit after server idle shows a clear "waking server" state (once implemented)

## Recording a result

When a branch passes, note it in the PR description: date, devices, networks, rows run.
If anything in the Reconnect or Transcription groups regresses, the change does not merge.
