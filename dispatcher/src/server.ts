import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Tenant, Tenants } from './tenants.ts';
import { actionOf, validSignature } from './webhook.ts';
import { DesignError, type DesignEvent } from './designs.ts';

// The HTTP side of the runner. Every route of a company lives under its path, `/<company>/…`, and is
// served with that company only: its webhook secret, its studio token, its dispatcher.
//   GET  /health                       public: alive, and how busy (numbers only)
//   POST /<company>/webhook            the webhook of its GitHub App
//   GET  /<company>/state|events|output for its studio, with its DISPATCHER_TOKEN
//   /<company>/designs[/<id>[/messages|events|finish]]  its design sessions, for its studio too
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
    const match = /^\/([a-z0-9][a-z0-9-]{0,62})(\/[a-z]+(?:\/[a-z0-9]+){0,2})$/.exec(path);
    if (match) return { company: match[1], rest: match[2] };
    return { company: legacy, rest: path };
}

export function createRunnerServer(tenants: Tenants, options: { legacy?: string; log: (line: string, details?: Record<string, unknown>) => void }) {
    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://runner');
            if (request.method === 'GET' && url.pathname === '/health') {
                const all = tenants.all();
                return send(response, 200, {
                    ok: true,
                    companies: all.length,
                    running: all.reduce((sum, tenant) => sum + tenant.dispatcher.state.running.length, 0),
                    queued: all.reduce((sum, tenant) => sum + tenant.dispatcher.state.queued.length, 0),
                });
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
                if (action.kind === 'repository') void dispatcher.reconcileRepository(action.repository);
                return;
            }

            if (request.method === 'GET' && (rest === '/state' || rest === '/events' || rest === '/output')) {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                if (rest === '/state') return send(response, 200, dispatcher.state);
                // The output of the turn of one issue: ?repository=owner/name&issue=12
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
            if (rest === '/designs' || rest.startsWith('/designs/')) {
                if (!tenant.config.studioToken) return send(response, 404, { error: 'studio access not configured' });
                if (!fromStudio(tenant, request)) return send(response, 401, { error: 'bad token' });
                return await designs(tenant, request, response, rest.split('/').slice(2));
            }
            send(response, 404, { error: 'not found' });
        } catch (error) {
            if (error instanceof DesignError) return send(response, error.status, { error: error.message });
            options.log('request failed', { error: (error as Error).message });
            if (!response.headersSent) send(response, 400, { error: 'bad request' });
        }
    });
}

/** The design sessions of a company: list and start, then one session, its messages, events and end. */
async function designs(tenant: Tenant, request: IncomingMessage, response: ServerResponse, [id, what]: string[]) {
    const sessions = tenant.designs;
    const json = async () => JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>;
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
