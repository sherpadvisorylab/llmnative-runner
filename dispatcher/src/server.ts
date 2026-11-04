import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Tenant, Tenants } from './tenants.ts';
import { actionOf, validSignature } from './webhook.ts';
import { DesignError, type DesignEvent } from './designs.ts';
import type { DesignKit } from './docker.ts';
import { ImageError, imagePattern, isAdmin, type ImageHost } from './images.ts';
import { ConfigError } from './config.ts';
import { BackupError, type MemoryBackup } from './backup.ts';
import { readMachine } from './machine.ts';

// The HTTP side of the runner. Every route of a company lives under its path, `/<company>/…`, and is
// served with that company only: its webhook secret, its studio token, its dispatcher.
//   GET  /health                       public: alive, and how busy (numbers only)
//   POST /<company>/webhook            the webhook of its GitHub App
//   GET  /<company>/state|events|output for its studio, with its DISPATCHER_TOKEN
//   /<company>/designs[/<id>[/messages|events|files|finish]]  its design sessions, for its studio too
//   POST /<company>/sources            the Actions of merged sources, for its studio
//   /_admin/images[/pull|/remove]       the images of the machine, with the admin token of the runner
//   /_admin/organizations[/<id>]        the organizations of the machine and the .env the studio sends for each
//   POST /_admin/memory/backup          the memory stopped and its data saved on the host, before an update
//   GET  /_admin/memory/key             the API key the memory made for itself (never logged)
//   GET  /_admin/machine                its memory and cores, for the limits of the turns
// A dispatcher started with one company in its environment also answers at the root, as before.

const MAX_BODY = 5 * 1024 * 1024;

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

/** The studio of this company, by its token: `Authorization: Bearer <DISPATCHER_TOKEN>`. */
function fromStudio(tenant: Tenant, request: IncomingMessage): boolean {
    const given = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(tenant.config.studioToken ?? '');
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
};

/** The company of a path and what is asked of it: `/acme/webhook` → acme, `/webhook`. */
export function routeOf(path: string, legacy?: string): { company?: string; rest: string } {
    // The parts after the first: an id of a session (8 hex) or of a turn (`20261104113533-tester`).
    const match = /^\/([a-z0-9][a-z0-9-]{0,62})(\/[a-z]+(?:\/[a-z0-9][a-z0-9_.-]{0,100}){0,2})$/.exec(path);
    if (match) return { company: match[1], rest: match[2] };
    return { company: legacy, rest: path };
}

/** The organizations of the machine as the studio manages them: their .env, sent, never read back. */
export interface CompanyFiles {
    list: () => Array<{ id: string; sent: boolean; active: boolean; problem?: string }>;
    /** Writes the .env of a company (checked first) and loads it; what it holds, by name. */
    write: (id: string, text: string) => { names: string[]; kept: string[] };
    remove: (id: string) => boolean;
}

/** What only the person who manages the machine does: its images, the files of its companies. */
export interface RunnerAdmin {
    /** The admin token now (none: the routes do not exist). */
    token: () => string | undefined;
    images: ImageHost;
    registry: string;
    /** The repositories of the other services of the runner (its memory). */
    services?: string[];
    organizations?: CompanyFiles;
    /** The backup of the memory of the runner, before an update. */
    memory?: MemoryBackup;
}

export function createRunnerServer(tenants: Tenants, options: { legacy?: string; log: (line: string, details?: Record<string, unknown>) => void; designs?: DesignKit[]; version?: string; admin?: RunnerAdmin }) {
    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://runner');
            if (request.method === 'GET' && url.pathname === '/health') {
                const all = tenants.all();
                return send(response, 200, {
                    ok: true,
                    version: options.version ?? 'dev',
                    organizations: all.length,
                    running: all.reduce((sum, tenant) => sum + tenant.dispatcher.state.running.length, 0),
                    queued: all.reduce((sum, tenant) => sum + tenant.dispatcher.state.queued.length, 0),
                    // The services of the runner: what the studio shows on its page (no secret here).
                    services: {
                        dispatcher: true,
                        // Every design agent of the runner, one per kit.
                        designs: (options.designs ?? []).map(({ kit, name, command, skills, source, commit, opencode }) => ({ kit, name, command, skills, source, commit, opencode })),
                    },
                });
            }
            // `_` is never in the id of a company: these paths are of the machine.
            if (url.pathname.startsWith('/_admin/')) {
                const admin = options.admin;
                // No admin token on the machine and a wrong one look the same from outside.
                if (!admin || !isAdmin(admin.token(), request.headers.authorization)) return send(response, 404, { error: 'not found' });
                const path = url.pathname.slice('/_admin'.length);
                if (path === '/organizations' || path.startsWith('/organizations/')) return await organizations(admin, request, response, path.slice('/organizations'.length).replace(/^\//, ''), options.log);
                if (path === '/memory/backup') {
                    if (request.method !== 'POST' || !admin.memory) return send(response, 404, { error: 'not found' });
                    // Minutes for a large memory: the studio waits for the answer.
                    const saved = await admin.memory.backup();
                    options.log('memory saved', saved);
                    return send(response, 200, { ok: true, ...saved });
                }
                if (path === '/machine') {
                    if (request.method !== 'GET') return send(response, 404, { error: 'not found' });
                    return send(response, 200, await readMachine());
                }
                if (path === '/memory/key') {
                    if (request.method !== 'GET' || !admin.memory) return send(response, 404, { error: 'not found' });
                    const key = await admin.memory.key();
                    options.log('memory key read');
                    return send(response, 200, { key });
                }
                return await images(admin, request, response, path, options.log);
            }
            const { company, rest } = routeOf(url.pathname, options.legacy);
            const tenant = company ? tenants.get(company) : undefined;
            // An unknown company and a wrong token look the same from outside.
            if (!tenant) return send(response, 404, { error: 'not found' });
            const { dispatcher } = tenant;

            if (request.method === 'POST' && rest === '/webhook') {
                if (!tenant.config.webhookSecret) return send(response, 404, { error: 'webhook not configured' });
                const body = await readBody(request);
                if (!validSignature(tenant.config.webhookSecret, body, request.headers['x-hub-signature-256'] as string | undefined)) return send(response, 401, { error: 'bad signature' });
                if (!tenant.deliveries.first(request.headers['x-github-delivery'] as string | undefined)) return send(response, 200, { duplicate: true });
                const action = actionOf(request.headers['x-github-event'] as string | undefined, JSON.parse(body));
                // GitHub waits ten seconds at most: answer first, work after.
                send(response, 202, { accepted: action.kind });
                dispatcher.announce({ type: 'issue', at: new Date().toISOString(), repository: action.kind === 'none' ? '' : action.repository, ...(action.kind === 'issue' ? { issue: action.number } : {}), action: request.headers['x-github-event'] as string ?? '' });
                if (action.kind === 'issue') void dispatcher.consider(action.repository, action.number, true);
                if (action.kind === 'comment') void dispatcher.answered(action.repository, action.number, action.comment);
                if (action.kind === 'repository') {
                    // A source merged: its Action for the agent of the Source channel, then the repository again.
                    void (action.sources?.length ? dispatcher.openSources(action.repository, action.sources) : Promise.resolve()).then(() => dispatcher.reconcileRepository(action.repository));
                }
                return;
            }

            if (request.method === 'GET' && (rest === '/state' || rest === '/events' || rest === '/output' || rest === '/stats')) {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                if (rest === '/state') return send(response, 200, dispatcher.state);
                // The output of the turn of one issue: ?repository=owner/name&issue=12
                // What the container of the running turn of one issue takes now: ?repository=owner/name&issue=12
                if (rest === '/stats') {
                    const stats = await dispatcher.statsOf(url.searchParams.get('repository') ?? '', Number(url.searchParams.get('issue')));
                    return stats ? send(response, 200, stats) : send(response, 404, { error: 'no turn' });
                }
                if (rest === '/output') {
                    const output = dispatcher.outputOf(url.searchParams.get('repository') ?? '', Number(url.searchParams.get('issue')));
                    return output ? send(response, 200, output) : send(response, 404, { error: 'no turn' });
                }
                // Server-Sent Events: the state first, then every event; a comment keeps proxies from closing it.
                response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
                const write = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                write('state', dispatcher.state);
                const stop = dispatcher.onEvent((event) => {
                    write(event.type, event);
                    if (event.type !== 'issue' && event.type !== 'turn-output') write('state', dispatcher.state);
                });
                const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
                request.on('close', () => {
                    clearInterval(keepAlive);
                    stop();
                });
                return;
            }
            // The turns of an issue kept on the machine (what each agent printed), and one of them with its lines:
            // ?repository=owner/name&issue=12, /turns/<id>.
            if (request.method === 'GET' && (rest === '/turns' || rest.startsWith('/turns/'))) {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                const repository = url.searchParams.get('repository') ?? '';
                const issue = Number(url.searchParams.get('issue'));
                if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !Number.isInteger(issue) || issue < 1) return send(response, 400, { error: 'repository and issue are required' });
                if (rest === '/turns') return send(response, 200, dispatcher.turnsOf(repository, issue));
                const turn = dispatcher.turnOf(repository, issue, decodeURIComponent(rest.slice('/turns/'.length)));
                return turn ? send(response, 200, turn) : send(response, 404, { error: 'not found' });
            }
            // The Actions of sources merged whose push was lost: opened on the request of its studio, never twice.
            if (request.method === 'POST' && rest === '/sources') {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                const body = JSON.parse((await readBody(request)) || '{}') as { repository?: unknown; sources?: unknown };
                const repository = String(body.repository ?? '');
                const sources = Array.isArray(body.sources) ? body.sources.filter((source): source is string => typeof source === 'string' && /^sources\/[A-Za-z0-9._\/-]+$/.test(source) && !source.includes('..')) : [];
                if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !sources.length) return send(response, 400, { error: 'repository and sources are required' });
                return send(response, 200, { opened: await dispatcher.openSources(repository, sources) });
            }
            if (rest === '/designs' || rest.startsWith('/designs/')) {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                return await designs(tenant, request, response, rest.split('/').slice(2));
            }
            send(response, 404, { error: 'not found' });
        } catch (error) {
            if (error instanceof DesignError || error instanceof ImageError || error instanceof BackupError) return send(response, error.status, { error: error.message });
            options.log('request failed', { error: (error as Error).message });
            if (!response.headersSent) send(response, 400, { error: 'bad request' });
        }
    });
}

/**
 * The organizations of the machine: which there are (sent by the studio or placed by hand), the .env of
 * one sent by the studio, and taking it off. The answers never hold a value of the file.
 */
async function organizations(admin: RunnerAdmin, request: IncomingMessage, response: ServerResponse, id: string, log: (line: string, details?: Record<string, unknown>) => void) {
    const files = admin.organizations;
    if (!files) return send(response, 404, { error: 'not found' });
    if (!id) return request.method === 'GET' ? send(response, 200, { organizations: files.list() }) : send(response, 404, { error: 'not found' });
    if (request.method === 'PUT') {
        const body = JSON.parse((await readBody(request)) || '{}') as { env?: unknown };
        if (typeof body.env !== 'string' || !body.env.trim()) return send(response, 400, { error: 'env is required' });
        try {
            const written = files.write(id, body.env);
            log('organization sent by the studio', { company: id, variables: written.names, kept: written.kept });
            return send(response, 200, { ok: true, ...written, organization: files.list().find((item) => item.id === id) });
        } catch (error) {
            if (error instanceof ConfigError) return send(response, 400, { error: error.message });
            throw error;
        }
    }
    if (request.method === 'DELETE') {
        const removed = files.remove(id);
        if (removed) log('organization taken off by the studio', { company: id });
        return send(response, 200, { removed, organization: files.list().find((item) => item.id === id) ?? null });
    }
    send(response, 404, { error: 'not found' });
}

/** The images of the machine: the list, then pulling or removing some, one by one (each with its outcome). */
async function images(admin: RunnerAdmin, request: IncomingMessage, response: ServerResponse, path: string, log: (line: string, details?: Record<string, unknown>) => void) {
    if (request.method === 'GET' && path === '/images') return send(response, 200, { registry: admin.registry, images: await admin.images.list() });
    if (request.method === 'POST' && (path === '/images/pull' || path === '/images/remove')) {
        const body = JSON.parse((await readBody(request)) || '{}') as { images?: unknown };
        const refs = Array.isArray(body.images) ? body.images.filter((ref): ref is string => typeof ref === 'string') : [];
        const valid = imagePattern(admin.registry, admin.services);
        if (!refs.length || refs.length > 20 || !refs.every((ref) => valid.test(ref))) return send(response, 400, { error: `images of ${[`${admin.registry}/playbook-*`, ...(admin.services ?? [])].join(', ')} only` });
        const pull = path === '/images/pull';
        const results = [];
        for (const ref of refs) {
            try {
                await (pull ? admin.images.pull(ref) : admin.images.remove(ref));
                log(pull ? 'image pulled' : 'image removed', { image: ref });
                results.push({ ref, ok: true });
            } catch (error) {
                results.push({ ref, ok: false, error: (error as Error).message });
            }
        }
        return send(response, 200, { results });
    }
    send(response, 404, { error: 'not found' });
}

/** The design sessions of a company: list and start, then one session, its messages, events and end. */
async function designs(tenant: Tenant, request: IncomingMessage, response: ServerResponse, [id, what]: string[]) {
    const sessions = tenant.designs;
    const json = async () => JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>;
    // A repository transferred to another organization: its ended sessions go from one company to the
    // other through the studio, which holds the token of both.
    if (id === 'export' && !what && request.method === 'GET') {
        return send(response, 200, sessions.exportOf(new URL(request.url ?? '', 'http://dispatcher').searchParams.get('repository') ?? ''));
    }
    if (id === 'import' && !what && request.method === 'POST') {
        const body = await json();
        return send(response, 200, sessions.importFrom(String(body.repository ?? ''), body.designs));
    }
    if (id === 'release' && !what && request.method === 'POST') {
        const body = await json();
        return send(response, 200, { released: sessions.release(String(body.repository ?? ''), body.ids) });
    }
    if (!id) {
        if (request.method === 'GET') return send(response, 200, sessions.list());
        if (request.method === 'POST') return send(response, 201, await sessions.start(await json()));
    } else if (!what) {
        if (request.method === 'GET') {
            const design = sessions.get(id);
            return design ? send(response, 200, { design, messages: await sessions.messages(id).catch(() => []) }) : send(response, 404, { error: 'not found' });
        }
        // Deleting a session archives it: closed if it is live, off the lists, kept in the data.
        if (request.method === 'DELETE') return send(response, 200, await sessions.archive(id));
    } else if (what === 'messages' && request.method === 'POST') {
        await sessions.send(id, await json());
        return send(response, 202, { accepted: true });
    } else if (what === 'files' && request.method === 'GET') {
        return send(response, 200, await sessions.files(id));
    } else if (what === 'finish' && request.method === 'POST') {
        return send(response, 200, await sessions.finish(id, await json()));
    } else if (what === 'events' && request.method === 'GET') {
        if (!sessions.get(id)) return send(response, 404, { error: 'not found' });
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        // Its status first, then what opencode does.
        const stop = sessions.follow(id, (event: DesignEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
        request.on('close', () => {
            clearInterval(keepAlive);
            stop();
        });
        return;
    }
    send(response, 404, { error: 'not found' });
}
