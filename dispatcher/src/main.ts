import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, readConfig, type Config } from './config.ts';
import { Dispatcher, type FailureStore, type Log } from './dispatcher.ts';
import { dockerRunner } from './docker.ts';
import { createGitHub } from './github.ts';
import { Deliveries, actionOf, validSignature } from './webhook.ts';

// The dispatcher process: the webhook and the health check on PORT, the reconciliation at start and
// every RECONCILE_MINUTES. State (failures in a row) and the log of every turn under DATA_DIR.

const MAX_BODY = 5 * 1024 * 1024;

/** The failures in a row of each issue, in a JSON file that survives a restart. */
function fileFailures(path: string): FailureStore {
    let failures: Record<string, number> = {};
    try {
        failures = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        // First start.
    }
    return {
        get: (key) => failures[key] ?? 0,
        set(key, value) {
            if (value) failures[key] = value;
            else delete failures[key];
            writeFileSync(`${path}.tmp`, JSON.stringify(failures, null, 2));
            renameSync(`${path}.tmp`, path);
        },
    };
}

/** Secrets never reach a log: every value of the turn environment and the key of the App are masked. */
function masker(config: Config) {
    const secrets = [...Object.values(config.agentEnv), config.webhookSecret ?? '', config.studioToken ?? ''].filter((value) => value.length >= 8);
    return (text: string) => secrets.reduce((all, secret) => all.split(secret).join('***'), text)
        // Installation tokens of the turns.
        .replace(/gh[suo]_[A-Za-z0-9]{20,}/g, '***');
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('too large'));
                request.destroy();
            } else chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

/** The studio of the company, by its token: `Authorization: Bearer <DISPATCHER_TOKEN>`. */
function fromStudio(config: Config, request: IncomingMessage): boolean {
    const given = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(config.studioToken ?? '');
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

function main() {
    let config: Config;
    try {
        config = readConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`[dispatcher] ${error.message}`);
            process.exit(64);
        }
        throw error;
    }
    const logs = join(config.dataDir, 'logs');
    mkdirSync(logs, { recursive: true });
    const mask = masker(config);
    const log: Log = (line, details) => console.log(mask(JSON.stringify({ at: new Date().toISOString(), msg: line, ...details })));

    const github = createGitHub({ appId: config.appId, privateKey: config.privateKey, installationId: config.installationId });
    const docker = dockerRunner({ image: config.image, memory: config.memory, network: config.network });
    const dispatcher = new Dispatcher({
        github,
        runTurn: docker.runTurn,
        failures: fileFailures(join(config.dataDir, 'failures.json')),
        options: { maxParallel: config.maxParallel, turnTimeout: config.turnTimeout, failuresToBlock: config.failuresToBlock, agentEnv: config.agentEnv },
        log,
        turnLog: {
            write(key, text) {
                const file = join(logs, `${key.replace(/[^A-Za-z0-9_.-]/g, '-')}.log`);
                appendFileSync(file, `\n===== ${new Date().toISOString()}\n${mask(text)}\n`);
            },
        },
    });
    const deliveries = new Deliveries();

    const send = (response: ServerResponse, status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    };

    const server = createServer(async (request, response) => {
        try {
            // Public: alive or not, and how busy; which repositories and issues only for the studio.
            if (request.method === 'GET' && request.url === '/health') {
                const { running, queued, lastReconcile } = dispatcher.state;
                return send(response, 200, { ok: true, running: running.length, queued: queued.length, lastReconcile });
            }
            if (request.method === 'GET' && (request.url === '/state' || request.url === '/events')) {
                if (!config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(config, request)) return send(response, 401, { error: 'bad token' });
                if (request.url === '/state') return send(response, 200, dispatcher.state);
                // Server-Sent Events: the state first, then every event; a comment keeps proxies from closing it.
                response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
                const write = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                write('state', dispatcher.state);
                const stop = dispatcher.onEvent((event) => {
                    write(event.type, event);
                    // Each change of what runs or waits comes with the state after it.
                    if (event.type !== 'issue') write('state', dispatcher.state);
                });
                const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
                request.on('close', () => {
                    clearInterval(keepAlive);
                    stop();
                });
                return;
            }
            if (request.method === 'POST' && request.url === '/webhook') {
                if (!config.webhookSecret) return send(response, 404, { error: 'webhook not configured' });
                const body = await readBody(request);
                if (!validSignature(config.webhookSecret, body, request.headers['x-hub-signature-256'] as string | undefined)) return send(response, 401, { error: 'bad signature' });
                if (!deliveries.first(request.headers['x-github-delivery'] as string | undefined)) return send(response, 200, { duplicate: true });
                const action = actionOf(request.headers['x-github-event'] as string | undefined, JSON.parse(body));
                // GitHub waits ten seconds at most: answer first, work after.
                send(response, 202, { accepted: action.kind });
                dispatcher.announce({ type: 'issue', at: new Date().toISOString(), repository: action.kind === 'none' ? '' : action.repository, ...(action.kind === 'issue' ? { issue: action.number } : {}), action: request.headers['x-github-event'] as string ?? '' });
                if (action.kind === 'issue') void dispatcher.consider(action.repository, action.number, true);
                if (action.kind === 'repository') void dispatcher.reconcileRepository(action.repository);
                return;
            }
            send(response, 404, { error: 'not found' });
        } catch (error) {
            log('request failed', { error: (error as Error).message });
            if (!response.headersSent) send(response, 400, { error: 'bad request' });
        }
    });

    server.listen(config.port, async () => {
        log('dispatcher listening', { port: config.port, image: config.image, maxParallel: config.maxParallel, webhook: !!config.webhookSecret, studio: !!config.studioToken, agentEnv: Object.keys(config.agentEnv) });
        await docker.cleanUp();
        await dispatcher.reconcile();
        setInterval(() => void dispatcher.reconcile(), config.reconcileMinutes * 60_000).unref();
    });

    const stop = () => {
        log('stopping');
        server.close();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

main();
