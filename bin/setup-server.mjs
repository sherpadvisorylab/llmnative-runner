// The backend of `npx @llmnative/runner setup`, on 127.0.0.1 only: the runners of this computer (with their platform
// keys) in ~/.llmnative-runner/fleet.json (0600), the installation over SSH from here, the state of each runner.
// Every request carries the token of the address it opened, so that no other page of the browser can call it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOverSsh } from '../dist/setup.mjs';
import { RunnerClient } from '../dist/client.mjs';
import { localSshFor } from './ssh-keys.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'setup-app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

export function fleetFile(home = homedir()) {
    return join(home, '.llmnative-runner', 'fleet.json');
}

function readFleet(file) {
    try {
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { runners: [] };
    } catch {
        return { runners: [] };
    }
}

function writeFleet(file, fleet) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(fleet, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
}

const view = ({ key: _key, ...entry }) => entry;
const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
};
const body = (request) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) { reject(new Error('too large')); request.destroy(); } else chunks.push(chunk);
    });
    request.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid')); }
    });
    request.on('error', reject);
});

/** Starts the page; resolves with its address (token included). */
export function startSetupServer({ port = 0, file = fleetFile(), log = () => {} } = {}) {
    const token = randomBytes(24).toString('base64url');
    const allowed = (request) => {
        const given = Buffer.from(String(request.headers['x-setup-token'] ?? ''));
        const expected = Buffer.from(token);
        return given.length === expected.length && timingSafeEqual(given, expected);
    };
    const save = (change) => {
        const fleet = readFleet(file);
        const next = change(fleet) ?? fleet;
        writeFleet(file, next);
        return next;
    };
    /** Connects a runner by its pairing code (or a key made before) and keeps it. */
    async function connect({ name, url, code, key }, extra = {}) {
        const address = String(url ?? '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(address)) throw Object.assign(new Error('invalid url'), { status: 400 });
        const platformKey = key ? String(key) : (await new RunnerClient({ url: address }).pair(String(code ?? ''), 'setup on this computer')).key;
        // The key works: its state answers.
        await new RunnerClient({ url: address, key: platformKey }).platform.status();
        const entry = { id: randomBytes(4).toString('hex'), name: String(name || new URL(address).hostname).slice(0, 80), url: address, key: platformKey, ...extra };
        save((fleet) => {
            if (!fleet.runners.length) entry.isDefault = true;
            fleet.runners.push(entry);
        });
        log(`runner added: ${entry.name} (${entry.url})`);
        return entry;
    }

    // Requests to connect a runner already installed (device flow): their secrets stay here, in memory.
    const pairings = new Map();
    async function startPairing({ name, url }) {
        const address = String(url ?? '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(address)) throw Object.assign(new Error('invalid url'), { status: 400 });
        const made = await new RunnerClient({ url: address }).requestPairing('setup on this computer');
        const id = randomBytes(8).toString('hex');
        pairings.set(id, { name: String(name || new URL(address).hostname), url: address, request: made.request, expiresAt: made.expiresAt });
        log(`asked ${address} to connect: approve code ${made.code} on the runner`);
        return { id, code: made.code, approveUrl: made.approveUrl, expiresAt: made.expiresAt };
    }
    async function pairingStatus(id) {
        const pending = pairings.get(id);
        if (!pending) return { status: 'expired' };
        const polled = await new RunnerClient({ url: pending.url }).pollPairing(pending.request);
        if (polled.status === 'pending') return polled;
        pairings.delete(id);
        if (polled.status !== 'approved') return { status: polled.status };
        return { status: 'approved', runner: view(await connect({ name: pending.name, url: pending.url, key: polled.key })) };
    }

    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        try {
            if (url.pathname.startsWith('/api/')) {
                if (!allowed(request)) return send(response, 401, { error: 'bad token' });
                const parts = url.pathname.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
                const [area, id, what] = parts;
                if (area === 'runners' && !id && request.method === 'GET') return send(response, 200, { runners: readFleet(file).runners.map(view) });
                if (area === 'runners' && !id && request.method === 'POST') return send(response, 201, { runner: view(await connect(await body(request))) });
                if (area === 'pairings' && !id && request.method === 'POST') return send(response, 201, await startPairing(await body(request)));
                if (area === 'pairings' && id && request.method === 'GET') return send(response, 200, await pairingStatus(id));
                const entry = readFleet(file).runners.find((runner) => runner.id === id);
                if (area === 'runners' && id && !entry) return send(response, 404, { error: 'not found' });
                if (area === 'runners' && what === 'status' && request.method === 'GET') {
                    return send(response, 200, await new RunnerClient({ url: entry.url, key: entry.key }).platform.status());
                }
                if (area === 'runners' && !what && request.method === 'PATCH') {
                    const patch = await body(request);
                    save((fleet) => {
                        for (const runner of fleet.runners) {
                            if (runner.id === id) {
                                if (typeof patch.name === 'string') runner.name = patch.name.slice(0, 80);
                                if (typeof patch.draining === 'boolean') runner.draining = patch.draining;
                                if (patch.isDefault === true) runner.isDefault = true;
                                if (patch.isDefault === false) delete runner.isDefault;
                            } else if (patch.isDefault === true) delete runner.isDefault;
                        }
                    });
                    return send(response, 200, { ok: true });
                }
                if (area === 'runners' && !what && request.method === 'DELETE') {
                    save((fleet) => ({ runners: fleet.runners.filter((runner) => runner.id !== id) }));
                    return send(response, 200, { removed: true });
                }
                if (area === 'install' && !id && request.method === 'POST') {
                    const input = await body(request);
                    const access = input.access ?? {};
                    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
                    const write = (event) => response.write(`${JSON.stringify(event)}\n`);
                    try {
                        // No key nor password given: the key of this computer for that host (~/.ssh/config).
                        const local = !access.privateKey && !access.password ? localSshFor(String(access.host ?? '')) : {};
                        if (!access.privateKey && !access.password && !local.privateKey) throw Object.assign(new Error('no SSH key of this computer for this host'), { code: 'ssh-key' });
                        const username = String(access.username || local.user || 'root');
                        log(`installing on ${username}@${access.host} as ${input.domain}${local.file ? ` (key ${local.file})` : ''}…`);
                        const installed = await installOverSsh({
                            host: String(access.host ?? ''),
                            port: Number(access.port) || 22,
                            username,
                            ...(access.privateKey ? { privateKey: String(access.privateKey) } : local.privateKey ? { privateKey: local.privateKey } : {}),
                            ...(access.password ? { password: String(access.password) } : {}),
                        }, {
                            domain: String(input.domain ?? ''),
                            onProgress: ({ line, phase }) => write({ type: 'line', line, ...(phase ? { phase } : {}) }),
                        });
                        const entry = await connect({ name: input.name, url: installed.url, code: installed.pairingCode }, { hostFingerprint: installed.hostFingerprint });
                        write({ type: 'done', runner: view(entry) });
                    } catch (error) {
                        write({ type: 'error', message: error.message, ...(error.code ? { code: error.code } : {}) });
                    }
                    return response.end();
                }
                return send(response, 404, { error: 'not found' });
            }
            // The page itself.
            const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
            let path = join(APP_DIR, relative);
            if (!path.startsWith(normalize(APP_DIR + sep)) && path !== normalize(APP_DIR)) return send(response, 404, { error: 'not found' });
            if (!existsSync(path) || statSync(path).isDirectory()) path = join(APP_DIR, 'index.html');
            response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
            createReadStream(path).pipe(response);
        } catch (error) {
            send(response, error.status ?? 400, { error: error.code ?? error.message });
        }
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        const address = `http://127.0.0.1:${server.address().port}/#token=${token}`;
        resolve({ address, token, server });
    }));
}
