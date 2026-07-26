'use strict';

/**
 * Enable / disable WireGuard peers.
 *
 * wg0.conf is NEVER modified. Disabling a peer removes it from the *running*
 * interface only (`wg set <nic> peer <key> remove`), exactly like the
 * WGDashboard panel does, and records the client name in a sidecar file.
 *
 * Why not comment the block out in wg0.conf:
 *   - main.js findIp() matches lines starting with "AllowedIPs", so a
 *     commented line is invisible to it and its IP looks free.
 *   - wireguard-install.sh greps the raw file, so it still sees that IP as
 *     taken and re-prompts. stdin is already closed at that point, so the
 *     octet ends up empty and you get "AllowedIPs = 156.6.86./32".
 * Leaving the file untouched keeps both of them in agreement.
 *
 * Because wg0.conf still lists the peer, `wg-quick up` after a reboot would
 * bring disabled clients back. applyDisabled() runs on require() and strips
 * them again.
 */

const { execFile } = require('child_process');
const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const PARAMS_FILE = '/etc/wireguard/params';
const STATE_FILE = '/etc/wireguard/disabled.json';

// Serialise writes so two requests can't clobber the state file.
let queue = Promise.resolve();

function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) {
                err.message = `${cmd} ${args.join(' ')}: ${(stderr || err.message).trim()}`;
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

async function getParams() {
    const out = {};
    try {
        const text = await fsp.readFile(PARAMS_FILE, 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*([A-Za-z0-9_]+)=(.*)$/);
            if (m) out[m[1]] = m[2].trim();
        }
    } catch (e) {
        /* caller applies defaults */
    }
    return out;
}

async function getInterface() {
    const p = await getParams();
    return p.SERVER_WG_NIC || 'wg0';
}

function confPath(nic) {
    return `/etc/wireguard/${nic}.conf`;
}

// ---------------------------------------------------------------------------
// Read peers out of wg0.conf (read-only, never written)
// ---------------------------------------------------------------------------

/**
 * Parse every `### Client x` block.
 * @returns {Promise<Array<{name,publicKey,presharedKey,allowedIPs}>>}
 */
async function readPeers() {
    const nic = await getInterface();
    const lines = (await fsp.readFile(confPath(nic), 'utf8')).split('\n');
    const out = [];
    let current = null;

    for (const raw of lines) {
        const line = raw.trim();
        const header = line.match(/^### Client (\S+)$/);

        if (header) {
            current = { name: header[1], publicKey: '', presharedKey: '', allowedIPs: '' };
            out.push(current);
            continue;
        }
        if (!current) continue;

        let m;
        if ((m = line.match(/^PublicKey\s*=\s*(.+)$/i))) current.publicKey = m[1].trim();
        else if ((m = line.match(/^PresharedKey\s*=\s*(.+)$/i))) current.presharedKey = m[1].trim();
        else if ((m = line.match(/^AllowedIPs\s*=\s*(.+)$/i))) current.allowedIPs = m[1].replace(/\s/g, '');
    }
    return out;
}

async function findPeer(name) {
    const peer = (await readPeers()).find(p => p.name === name);
    if (!peer) {
        const err = new Error('client not found');
        err.code = 404;
        throw err;
    }
    if (!peer.publicKey) {
        const err = new Error('client has no PublicKey in wg0.conf');
        err.code = 500;
        throw err;
    }
    return peer;
}

// ---------------------------------------------------------------------------
// Sidecar state: which clients are switched off
// ---------------------------------------------------------------------------

async function readState() {
    try {
        const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];   // missing or corrupt: treat as "nothing disabled"
    }
}

async function writeState(names) {
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify([...new Set(names)].sort(), null, 2), { mode: 0o600 });
    await fsp.rename(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Talking to the live interface
// ---------------------------------------------------------------------------

async function isUp(nic) {
    try {
        await run('wg', ['show', nic]);
        return true;
    } catch (e) {
        return false;
    }
}

/** Public keys currently loaded in the running interface. */
async function livePeerKeys(nic) {
    try {
        const out = await run('wg', ['show', nic, 'peers']);
        return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) {
        return new Set();
    }
}

async function removeFromInterface(nic, publicKey) {
    await run('wg', ['set', nic, 'peer', publicKey, 'remove']);
}

async function addToInterface(nic, peer) {
    if (peer.presharedKey) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wgpsk-'));
        const pskFile = path.join(dir, 'psk');
        try {
            await fsp.writeFile(pskFile, peer.presharedKey, { mode: 0o600 });
            await run('wg', ['set', nic, 'peer', peer.publicKey,
                             'preshared-key', pskFile,
                             'allowed-ips', peer.allowedIPs]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } else {
        await run('wg', ['set', nic, 'peer', peer.publicKey,
                         'allowed-ips', peer.allowedIPs]);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function setEnabled(name, enabled) {
    if (!NAME_RE.test(name)) {
        const err = new Error('invalid client name');
        err.code = 400;
        throw err;
    }

    return withLock(async () => {
        const nic = await getInterface();
        const peer = await findPeer(name);
        const state = await readState();
        const wasDisabled = state.includes(name);

        if (enabled === !wasDisabled) {
            return { name, enabled, changed: false, applied: await isUp(nic) };
        }

        let applied = false;
        if (await isUp(nic)) {
            if (enabled) await addToInterface(nic, peer);
            else await removeFromInterface(nic, peer.publicKey);
            applied = true;
        }

        await writeState(enabled ? state.filter(n => n !== name) : state.concat(name));

        return { name, enabled, changed: true, applied };
    });
}

async function status(name) {
    if (!NAME_RE.test(name)) {
        const err = new Error('invalid client name');
        err.code = 400;
        throw err;
    }
    await findPeer(name);
    return { name, enabled: !(await readState()).includes(name) };
}

async function list() {
    const disabled = new Set(await readState());
    const nic = await getInterface();
    const live = await livePeerKeys(nic);

    return (await readPeers()).map(p => ({
        name: p.name,
        enabled: !disabled.has(p.name),
        ip: (p.allowedIPs.split(',')[0] || '').split('/')[0] || null,
        connected: live.has(p.publicKey),
    }));
}

/**
 * Re-apply the disabled list to the running interface.
 *
 * wg0.conf still contains every peer, so `wg-quick up` after a reboot loads
 * the disabled ones too. This strips them again. Runs on require().
 */
async function applyDisabled() {
    const disabled = await readState();
    if (disabled.length === 0) return { removed: [] };

    const nic = await getInterface();
    if (!(await isUp(nic))) return { removed: [] };

    const live = await livePeerKeys(nic);
    const removed = [];

    for (const peer of await readPeers()) {
        if (!disabled.includes(peer.name)) continue;
        if (!live.has(peer.publicKey)) continue;
        try {
            await removeFromInterface(nic, peer.publicKey);
            removed.push(peer.name);
        } catch (e) {
            /* keep going: one bad peer shouldn't block the rest */
        }
    }
    return { removed };
}

// Enforce the disabled list at startup.
applyDisabled().catch(() => {});

module.exports = {
    enable: name => setEnabled(name, true),
    disable: name => setEnabled(name, false),
    status,
    list,
    applyDisabled,
    getParams,
    getInterface,
    readPeers,
    NAME_RE,
};
