'use strict';

/**
 * Enable / disable WireGuard peers without deleting them.
 *
 * A peer is "disabled" by commenting out its [Peer] block in wg0.conf with a
 * marker prefix, then re-syncing the live interface. The `### Client <name>`
 * header line is deliberately left untouched so that wireguard-install.sh's
 * list (2) and revoke (3) menu options keep working.
 *
 * We do NOT use `wg-quick save`: it rewrites wg0.conf from the live interface
 * and strips every comment, which would destroy the `### Client` headers the
 * install script depends on.
 */

const { execFile } = require('child_process');
const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');

const OFF = '#!OFF!';
const NAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;

// ---------------------------------------------------------------------------
// Serialise every write. Two concurrent requests rewriting wg0.conf would
// otherwise lose one of the two changes.
// ---------------------------------------------------------------------------
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

/** Read the interface name the installer chose (defaults to wg0). */
async function getInterface() {
    try {
        const params = await fsp.readFile('/etc/wireguard/params', 'utf8');
        const m = params.match(/^SERVER_WG_NIC=(.+)$/m);
        if (m && m[1].trim()) return m[1].trim();
    } catch (e) {
        /* params file missing - fall through to default */
    }
    return 'wg0';
}

function confPath(nic) {
    return `/etc/wireguard/${nic}.conf`;
}

/**
 * Locate a client's peer block.
 * @returns {{header:number, start:number, end:number}|null}
 *          header = index of the `### Client x` line,
 *          [start, end) = the body lines belonging to that peer.
 */
function findBlock(lines, name) {
    const header = lines.findIndex(l => l.trim() === `### Client ${name}`);
    if (header === -1) return null;

    let end = header + 1;
    while (end < lines.length) {
        const line = lines[end].trim();
        if (line === '' || line.startsWith('### Client ')) break;
        end++;
    }
    return { header, start: header + 1, end };
}

function bodyIsDisabled(lines, block) {
    for (let i = block.start; i < block.end; i++) {
        if (lines[i].trim() === '') continue;
        return lines[i].startsWith(OFF);
    }
    return false;
}

/** Write wg0.conf atomically, keeping 0600 permissions. */
async function writeConf(file, text) {
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, file);
}

/** Is the interface currently up? */
async function isUp(nic) {
    try {
        await run('wg', ['show', nic]);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Push wg0.conf to the running interface.
 * `wg syncconf` only touches peers that actually changed, so other clients
 * keep their handshakes and stay connected.
 */
async function syncConf(nic) {
    if (!(await isUp(nic))) return false;

    const stripped = await run('wg-quick', ['strip', nic]);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wgsync-'));
    const tmp = path.join(dir, `${nic}.conf`);

    try {
        await fsp.writeFile(tmp, stripped, { mode: 0o600 });
        await run('wg', ['syncconf', nic, tmp]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
}

/** Flip one peer on or off. */
async function setEnabled(name, enabled) {
    if (!NAME_RE.test(name)) {
        const err = new Error('invalid client name');
        err.code = 400;
        throw err;
    }

    return withLock(async () => {
        const nic = await getInterface();
        const file = confPath(nic);
        const lines = (await fsp.readFile(file, 'utf8')).split('\n');
        const block = findBlock(lines, name);

        if (!block) {
            const err = new Error('client not found');
            err.code = 404;
            throw err;
        }

        const currentlyDisabled = bodyIsDisabled(lines, block);

        // Already in the requested state - nothing to write.
        if (enabled === !currentlyDisabled) {
            return { name, enabled, changed: false, applied: await isUp(nic) };
        }

        for (let i = block.start; i < block.end; i++) {
            if (lines[i].trim() === '') continue;
            lines[i] = enabled
                ? lines[i].slice(lines[i].startsWith(OFF) ? OFF.length : 0)
                : OFF + lines[i];
        }

        await writeConf(file, lines.join('\n'));
        const applied = await syncConf(nic);

        return { name, enabled, changed: true, applied };
    });
}

async function status(name) {
    if (!NAME_RE.test(name)) {
        const err = new Error('invalid client name');
        err.code = 400;
        throw err;
    }

    const nic = await getInterface();
    const lines = (await fsp.readFile(confPath(nic), 'utf8')).split('\n');
    const block = findBlock(lines, name);

    if (!block) {
        const err = new Error('client not found');
        err.code = 404;
        throw err;
    }
    return { name, enabled: !bodyIsDisabled(lines, block) };
}

/** Every client with its on/off state. */
async function list() {
    const nic = await getInterface();
    const lines = (await fsp.readFile(confPath(nic), 'utf8')).split('\n');
    const out = [];

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(/^### Client (\S+)$/);
        if (!m) continue;
        const block = findBlock(lines, m[1]);
        out.push({ name: m[1], enabled: !bodyIsDisabled(lines, block) });
    }
    return out;
}

module.exports = {
    enable: name => setEnabled(name, true),
    disable: name => setEnabled(name, false),
    status,
    list,
    getInterface,
    // exported for tests
    _findBlock: findBlock,
    _bodyIsDisabled: bodyIsDisabled,
    OFF,
};
