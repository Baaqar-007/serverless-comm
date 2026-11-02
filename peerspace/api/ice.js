export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://peerspace-xi.vercel.app');

  const { TURN_USER, TURN_PASS } = process.env;

  // Skip any URL whose env var is missing. An entry with `urls: undefined`
  // makes `new RTCPeerConnection()` throw in the browser, which would break
  // every call instead of just falling back to STUN.
  const turnUrls = [
    process.env.TURN_URL_UDP,
    process.env.TURN_URL_TCP,
    process.env.TURN_URL_443,
    process.env.TURN_URL_TLS,
  ].filter(Boolean);

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (TURN_USER && TURN_PASS && turnUrls.length > 0) {
    for (const urls of turnUrls) {
      iceServers.push({ urls, username: TURN_USER, credential: TURN_PASS });
    }
  } else {
    // Visible in the Vercel function logs, so a misconfigured env is noticed.
    console.warn('[ice] TURN not fully configured; serving STUN only');
  }

  res.json({ iceServers });
}
