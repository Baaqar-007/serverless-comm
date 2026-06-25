export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://peerspace-xi.vercel.app');
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: process.env.TURN_URL_UDP,
        username: process.env.TURN_USER,
        credential: process.env.TURN_PASS,
      },
      {
        urls: process.env.TURN_URL_TCP,
        username: process.env.TURN_USER,
        credential: process.env.TURN_PASS,
      },
      {
        urls: process.env.TURN_URL_443,
        username: process.env.TURN_USER,
        credential: process.env.TURN_PASS,
      },
      {
        urls: process.env.TURN_URL_TLS,
        username: process.env.TURN_USER,
        credential: process.env.TURN_PASS,
      },
    ]
  });
}