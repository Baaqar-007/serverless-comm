const Hyperswarm = require('hyperswarm');
const Hypercore = require('hypercore');
const b4a = require('b4a');
const crypto = require('crypto');

// Get storage path from command line (e.g., node index.js ./peer1)
const storagePath = process.argv[2];

if (!storagePath) {
    console.error('[USAGE ERROR] Please provide a storage path.');
    console.error('Example: node index.js ./peer-data-1');
    process.exit(1);
}

const core = new Hypercore(storagePath);
const swarm = new Hyperswarm();

async function start() {
    console.log(`[INIT] Starting P2P Notepad in: ${storagePath}`);

    try {
        await core.ready();
        console.log('[CORE] Public Key:', b4a.toString(core.key, 'hex'));
    } catch (err) {
        console.error('[FATAL ERROR] Hypercore failed:', err.message);
        process.exit(1);
    }

    // Fixed topic for discovery
    const topic = crypto.createHash('sha256').update('secret-notepad-v1').digest();
    swarm.join(topic, { client: true, server: true });

    swarm.on('connection', (socket, info) => {
        const peerId = b4a.toString(info.publicKey, 'hex').slice(0, 6);
        console.log(`[NETWORK] Connected to peer: ${peerId}`);
        
        // Replicate the log over the network socket
        core.replicate(socket);

        socket.on('error', (err) => {
            console.error(`[NETWORK ERROR] Peer ${peerId} disconnected:`, err.message);
        });
    });

    // Listen for data from peers
    core.on('append', async () => {
        try {
            const seq = core.length - 1;
            const data = await core.get(seq);
            console.log(`\n[SYNC] New Note (Seq ${seq}): ${data.toString()}`);
            process.stdout.write('> ');
        } catch (err) {
            console.error('[SYNC ERROR] Failed to fetch update:', err);
        }
    });

    // Handle User Input
    process.stdin.on('data', async (data) => {
        const msg = data.toString().trim();
        if (!msg) return;

        try {
            await core.append(msg);
            console.log(`[LOCAL] Appended: "${msg}"`);
            process.stdout.write('> ');
        } catch (err) {
            console.error('[WRITE ERROR] Could not save note:', err);
        }
    });

    console.log('[READY] Waiting for peers... Type a note and hit Enter.');
    process.stdout.write('> ');
}

start();