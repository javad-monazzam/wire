'use strict';

/**
 * Per-client traffic, read live from WireGuard. Nothing is stored.
 *
 * `wg show all dump` returns one line per peer with 9 tab-separated columns:
 *   interface  publicKey  presharedKey  endpoint  allowedIps
 *   lastHandshake  rx  tx  keepalive
 * Interface header lines have 5 columns, so anything shorter is skipped.
 *
 * The panel stores the *client name*, not the public key, so names come from
 * the `### Client <name>` headers in wg0.conf via peers.readPeers().
 *
 * Note: these counters live in the kernel. They reset on reboot, on
 * `wg-quick down/up`, and whenever a peer is removed from the running
 * interface (which is what peers.disable() does).
 */

const { execFile } = require('child_process');
const peers = require('./peers');

const ONLINE_WINDOW_SEC = 180;

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim()));
            resolve(stdout);
        });
    });
}

/** publicKey -> live stats, straight from the kernel */
async function dump() {
    const out = {};
    let stdout;

    try {
        stdout = await run('wg', ['show', 'all', 'dump']);
    } catch (e) {
        return out;   // no interface up
    }

    const now = Math.floor(Date.now() / 1000);

    for (const line of stdout.split('\n')) {
        const p = line.trim().split('\t');
        if (p.length < 9) continue;   // interface header line

        const lastHandshake = parseInt(p[5], 10) || 0;
        const rx = parseInt(p[6], 10) || 0;
        const tx = parseInt(p[7], 10) || 0;

        out[p[1]] = {
            interface: p[0],
            endpoint: p[3] !== '(none)' ? p[3] : null,
            allowedIps: p[4],
            lastHandshake,
            rx,
            tx,
            total: rx + tx,
            isOnline: lastHandshake > 0 && now - lastHandshake < ONLINE_WINDOW_SEC,
        };
    }
    return out;
}

/** Same data, keyed by client name instead of public key */
async function all() {
    const [confPeers, stats] = await Promise.all([peers.readPeers(), dump()]);
    const result = {};

    for (const peer of confPeers) {
        if (!peer.publicKey) continue;

        const s = stats[peer.publicKey];

        result[peer.name] = s
            ? {
                  rx: s.rx,
                  tx: s.tx,
                  total: s.total,
                  lastHandshake: s.lastHandshake,
                  endpoint: s.endpoint,
                  isOnline: s.isOnline,
                  connected: true,
              }
            : {
                  // in wg0.conf but not on the running interface (disabled, or wg is down)
                  rx: 0,
                  tx: 0,
                  total: 0,
                  lastHandshake: 0,
                  endpoint: null,
                  isOnline: false,
                  connected: false,
              };
    }
    return result;
}

/** One client by name */
async function one(name) {
    const map = await all();
    if (!map[name]) {
        const err = new Error('client not found');
        err.code = 404;
        throw err;
    }
    return { name, ...map[name] };
}

module.exports = { all, one, dump };
