import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { USER_ID, isAccountProvider, type AccountProvider, type Scope } from './accounts.ts';
import { ChatError, chatFilesOf } from './chats.ts';
import { CompletionError, completionRequestOf, offerOf } from './completions.ts';
import { readMachine } from './machine.ts';
import { CLAUDE_CODE, accountKey } from './providers.ts';
import { PERMISSIONS, RegistryError, type KeyRecord, type Permission } from './registry.ts';
import type { Runtime } from './runtime.ts';

// The HTTP side of the runner: API v1 (JSON, `Authorization: Bearer <key>`) and the console.
//   GET  /health                                         public: alive, version, how busy (numbers only)
//   POST /v1/pair                                        a pairing code → a platform key
//   POST /v1/pair/requests                               a platform asks to connect: a secret, a code, the page to approve
//   POST /v1/pair/requests/poll                          the platform asks again with its secret: approved, a platform key
//   POST /v1/admin/pairing                               (admin token) a new pairing code
//   GET  /v1/admin/pairing/requests                      (admin token) the requests waiting
//   POST /v1/admin/pairing/requests/<code>/approve|deny  (admin token) the answer
//   GET  /v1/platform/status                             (platform) version, load, machine, tenants
//   GET|POST /v1/platform/tenants, DELETE …/<id>         (platform) tenants
//   GET|POST /v1/platform/tenants/<id>/keys, DELETE …/<key>  (platform) project keys of a tenant
//   GET|DELETE /v1/platform/keys[/<id>]                  (platform) platform keys
//   GET  /v1/info                                        (any key) what the runner offers
//   /v1/accounts…                                        (tenant) accounts of the person, or of the tenant
//   GET  /v1/models                                      (tenant) what can run now for the person
//   POST /v1/complete                                    (tenant, complete) one answer
//   /v1/chats…                                           (tenant, chat) chats with a harness, NDJSON replies
//   POST /v1/internal/<tenant>/chats/<id>/tool           (token of the chat) a call of a tool, from its container
//   GET  /console/…                                      the console (admin token)
// The tenant of a project key is its own; a platform key (or the admin token) names one with `X-Runner-Tenant`.
// The person: `X-Runner-User`, with the permission `act-as-user` for a project key. Errors: `{ error }` with
// 400 invalid, 401 bad token|expired, 403 forbidden, 404 not found, 409 no-provider|no-credit, 429 busy, 502, 504.

const MAX_BODY = 1024 * 1024;
const MAX_COMPLETION = 1024 * 1024;
/** A message of a chat with its files (15 MB at most, in base64). */
const MAX_CHAT_MESSAGE = 25 * 1024 * 1024;

type Caller = { kind: 'admin' } | { kind: 'platform'; key: KeyRecord } | { kind: 'project'; key: KeyRecord };

class HttpError extends Error {
    readonly status: number;
    readonly extra?: Record<string, unknown>;

    constructor(status: number, message: string, extra?: Record<string, unknown>) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function readBody(request: IncomingMessage, max = MAX_BODY): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
                reject(new HttpError(413, 'too large'));
                request.destroy();
            } else chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

async function json(request: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
    const text = await readBody(request, max);
    if (!text.trim()) return {};
    try {
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
        // Said below.
    }
    throw new HttpError(400, 'invalid');
}

const send = (response: ServerResponse, status: number, body: unknown) => {
    if (response.headersSent) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
};

const bearerOf = (request: IncomingMessage) => String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
const header = (request: IncomingMessage, name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

export type ServerOptions = {
    /** Origins allowed to call the API from a browser (a personal app with a key of its own); none by default. */
    corsOrigins?: string[];
};

export function createRunnerServer(runtime: Runtime, options: ServerOptions = {}) {
    const { log } = runtime.deps;

    function callerOf(request: IncomingMessage): Caller {
        const bearer = bearerOf(request);
        if (!bearer) throw new HttpError(401, 'bad token');
        if (runtime.isAdmin(bearer)) return { kind: 'admin' };
        const key = runtime.registry.authenticate(bearer);
        if (key === 'expired') throw new HttpError(401, 'expired');
        if (!key) throw new HttpError(401, 'bad token');
        return key.kind === 'platform' ? { kind: 'platform', key } : { kind: 'project', key };
    }

    const platformOnly = (caller: Caller) => {
        if (caller.kind === 'project') throw new HttpError(403, 'forbidden');
    };

    const can = (caller: Caller, permission: Permission) => caller.kind !== 'project' || caller.key.permissions.includes(permission);
    const need = (caller: Caller, permission: Permission) => {
        if (!can(caller, permission)) throw new HttpError(403, 'forbidden');
    };

    /** The tenant and person a request is for. */
    function scopeOf(request: IncomingMessage, caller: Caller): Scope {
        const tenant = caller.kind === 'project' ? caller.key.tenant! : header(request, 'x-runner-tenant');
        if (!tenant || !runtime.registry.tenant(tenant)) throw new HttpError(404, 'no-tenant');
        const user = header(request, 'x-runner-user');
        if (user !== undefined) {
            if (!USER_ID.test(user)) throw new HttpError(400, 'invalid user');
            need(caller, 'act-as-user');
        }
        return { tenant, ...(user ? { user } : {}) };
    }

    const keyName = (caller: Caller) => (caller.kind === 'admin' ? 'admin' : caller.key.id);

    async function platform(request: IncomingMessage, response: ServerResponse, caller: Caller, parts: string[]) {
        platformOnly(caller);
        const [what, id, sub, subId] = parts;
        if (what === 'status' && !id && request.method === 'GET') {
            return send(response, 200, {
                version: runtime.config.version,
                agentImage: runtime.config.agentImage,
                ...(runtime.config.publicUrl ? { url: runtime.config.publicUrl } : {}),
                load: runtime.load(),
                machine: await readMachine(),
                tenants: runtime.registry.tenants().map((tenant) => ({ ...tenant, usersWithAccounts: runtime.usersWithAccounts(tenant.id) })),
            });
        }
        if (what === 'tenants') {
            if (!id && request.method === 'GET') return send(response, 200, { tenants: runtime.registry.tenants() });
            if (!id && request.method === 'POST') {
                const body = await json(request);
                const tenant = runtime.registry.createTenant(String(body.id ?? ''), typeof body.name === 'string' ? body.name : undefined);
                // Its first key, when asked: what a platform gives the backend of that tenant.
                const permissions = Array.isArray(body.keyPermissions) ? body.keyPermissions.map(String) as Permission[] : undefined;
                const made = body.key === false ? undefined : runtime.registry.createKey({ kind: 'project', tenant: tenant.id, name: 'default', permissions: permissions ?? ['complete', 'chat', 'chat:tools', 'accounts', 'act-as-user'] });
                log('tenant created', { tenant: tenant.id, by: keyName(caller) });
                return send(response, 201, { tenant, ...(made ? { key: made.key, keyRecord: made.record } : {}) });
            }
            if (id && !sub && request.method === 'DELETE') {
                const removed = await runtime.removeTenant(id);
                if (removed) log('tenant removed', { tenant: id, by: keyName(caller) });
                return send(response, removed ? 200 : 404, removed ? { removed } : { error: 'not found' });
            }
            if (id && sub === 'keys') {
                if (!runtime.registry.tenant(id)) throw new HttpError(404, 'no-tenant');
                if (!subId && request.method === 'GET') return send(response, 200, { keys: runtime.registry.keys({ kind: 'project', tenant: id }) });
                if (!subId && request.method === 'POST') {
                    const body = await json(request);
                    const made = runtime.registry.createKey({
                        kind: 'project',
                        tenant: id,
                        name: typeof body.name === 'string' ? body.name : undefined,
                        permissions: Array.isArray(body.permissions) ? body.permissions.map(String) as Permission[] : undefined,
                        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
                    });
                    log('key created', { tenant: id, key: made.record.id, by: keyName(caller) });
                    return send(response, 201, { key: made.key, record: made.record });
                }
                if (subId && request.method === 'DELETE') {
                    const removed = runtime.registry.revokeKey(subId, id);
                    return send(response, removed ? 200 : 404, removed ? { removed } : { error: 'not found' });
                }
            }
        }
        if (what === 'keys') {
            if (!id && request.method === 'GET') return send(response, 200, { keys: runtime.registry.keys({ kind: 'platform' }) });
            if (id && request.method === 'DELETE') {
                const removed = runtime.registry.revokeKey(id);
                return send(response, removed ? 200 : 404, removed ? { removed } : { error: 'not found' });
            }
        }
        throw new HttpError(404, 'not found');
    }

    async function accounts(request: IncomingMessage, response: ServerResponse, caller: Caller, parts: string[]) {
        const scope = scopeOf(request, caller);
        need(caller, scope.user ? 'accounts' : 'accounts:tenant');
        const mine = runtime.accounts.of(scope);
        const tenantRuntime = runtime.tenant(scope.tenant)!;
        const view = () => mine.list().map((account) => {
            const reset = tenantRuntime.credit.resetOf(accountKey(account.provider, { id: `${scope.user ? 'u' : 't'}:${account.id}` }));
            return { ...account, ...(reset ? { noCreditUntil: new Date(reset).toISOString() } : {}) };
        });
        const [provider, id, more] = parts;
        if (!provider && request.method === 'GET') return send(response, 200, { scope: scope.user ? 'user' : 'tenant', accounts: view() });
        if (provider === 'order' && !id && request.method === 'PUT') {
            const body = await json(request);
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
            if (typeof body.provider !== 'string' || !isAccountProvider(body.provider) || !mine.setOrder(body.provider, ids)) throw new HttpError(400, 'invalid');
            return send(response, 200, { accounts: view() });
        }
        if (!provider || !isAccountProvider(provider)) throw new HttpError(404, 'not found');
        const who = { tenant: scope.tenant, ...(scope.user ? { user: scope.user } : {}) };
        if (provider === CLAUDE_CODE && id === 'login') {
            // The sign-in of a Claude subscription: the page of Anthropic, then the code the person got there.
            if (!more && request.method === 'POST') {
                const started = await mine.claude.start();
                log('claude sign-in started', { ...who, ok: 'url' in started });
                return send(response, 'url' in started ? 200 : 409, 'url' in started ? started : { error: started.error });
            }
            if (more === 'code' && request.method === 'POST') {
                const body = await json(request);
                const accountId = mine.newClaudeId();
                const done = await mine.claude.code(accountId, String(body.code ?? '').slice(0, 500), typeof body.label === 'string' ? body.label : undefined);
                log('claude sign-in ended', { ...who, connected: 'connected' in done, ...('error' in done ? { error: done.error } : {}) });
                if (!('connected' in done)) return send(response, 409, { error: done.error, ...(done.detail ? { detail: done.detail } : {}) });
                return send(response, 200, { connected: true, account: view().find((account) => account.provider === CLAUDE_CODE && account.id === accountId) });
            }
            throw new HttpError(404, 'not found');
        }
        if (!id && request.method === 'POST') {
            const body = await json(request);
            if (provider === CLAUDE_CODE) {
                // A token made elsewhere with `claude setup-token`.
                const accountId = mine.newClaudeId();
                if (!mine.claude.set(accountId, String(body.token ?? ''), typeof body.label === 'string' ? body.label : undefined)) throw new HttpError(400, 'invalid');
                log('account added', { ...who, provider });
                return send(response, 201, { account: view().find((account) => account.provider === CLAUDE_CODE && account.id === accountId) });
            }
            const added = mine.addKey(provider as AccountProvider, String(body.key ?? ''), typeof body.label === 'string' ? body.label : undefined);
            if (!added) throw new HttpError(400, 'invalid');
            log('account added', { ...who, provider });
            return send(response, 201, { account: added });
        }
        if (id && !more && request.method === 'DELETE') {
            const removed = mine.remove(provider as AccountProvider, id);
            if (removed) log('account removed', { ...who, provider });
            return send(response, removed ? 200 : 404, removed ? { removed } : { error: 'not found' });
        }
        throw new HttpError(404, 'not found');
    }

    async function chats(request: IncomingMessage, response: ServerResponse, caller: Caller, parts: string[]) {
        const scope = scopeOf(request, caller);
        need(caller, 'chat');
        const tenant = runtime.tenant(scope.tenant)!;
        const [id, action, callId] = parts;
        if (!id && request.method === 'POST') {
            const body = await json(request);
            if (body.tools !== undefined) need(caller, 'chat:tools');
            const load = runtime.load();
            if (load.chats >= load.maxChats && !tenant.chats.has(String(body.id ?? ''), scope.user)) throw new HttpError(429, 'busy');
            return send(response, 201, await tenant.chats.start(String(body.id ?? ''), scope.user, body.tools));
        }
        if (!id || !tenant.chats.has(id, scope.user)) throw new HttpError(404, 'no-chat');
        if (!action && request.method === 'DELETE') return send(response, 200, { closed: await tenant.chats.close(id) });
        if (action === 'stop' && request.method === 'POST') return send(response, 200, { stopped: await tenant.chats.stop(id) });
        if (action === 'calls' && callId && request.method === 'POST') {
            const body = await json(request);
            return send(response, 200, { answered: tenant.chats.answerTool(id, scope.user, callId, { result: body.result, ...(body.isError ? { isError: true } : {}) }) });
        }
        if (action === 'messages' && request.method === 'POST') {
            const body = await json(request, MAX_CHAT_MESSAGE);
            const model = body.model as { provider?: unknown; model?: unknown; variant?: unknown; name?: unknown; effort?: unknown } | undefined;
            if (typeof model?.provider !== 'string' || typeof model.model !== 'string') throw new HttpError(400, 'invalid');
            const files = chatFilesOf(body.attachments);
            if (!files) throw new HttpError(400, 'invalid-files');
            response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
            // A line every 15 s while the harness thinks or waits for a tool: a reply silent for minutes would be cut
            // by what is in between.
            const alive = setInterval(() => response.write(`${JSON.stringify({ type: 'ping' })}\n`), 15_000);
            // The person stopped the reply (or the client went away): its harness stopped too, the chat free again.
            let finished = false;
            response.on('close', () => {
                if (!finished) void tenant.chats.stop(id);
            });
            await tenant.chats.send(id, String(body.text ?? ''), {
                provider: model.provider,
                model: model.model,
                ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
                ...(typeof model.name === 'string' ? { name: model.name } : {}),
                ...(typeof model.effort === 'string' ? { effort: model.effort } : {}),
            }, (event) => response.write(`${JSON.stringify(event)}\n`), files).catch((error: Error) => {
                response.write(`${JSON.stringify({ type: 'error', message: error.message })}\n`);
            });
            finished = true;
            clearInterval(alive);
            response.end();
            return;
        }
        throw new HttpError(404, 'not found');
    }

    function consoleFile(response: ServerResponse, path: string) {
        const root = runtime.config.consoleDir;
        if (!root || !existsSync(root)) return send(response, 404, { error: 'not found' });
        const relative = normalize(decodeURIComponent(path.replace(/^\/console\/?/, ''))).replace(/^([/\\])+/, '');
        let file = join(root, relative);
        if (!file.startsWith(normalize(root + sep)) && file !== normalize(root)) return send(response, 404, { error: 'not found' });
        // The console is one page: what is not a file is its index.
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
        if (!existsSync(file)) return send(response, 404, { error: 'not found' });
        response.writeHead(200, {
            'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
            'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        createReadStream(file).pipe(response);
    }

    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://runner');
            const origin = header(request, 'origin');
            if (origin && options.corsOrigins?.includes(origin)) {
                response.setHeader('access-control-allow-origin', origin);
                response.setHeader('vary', 'origin');
                response.setHeader('access-control-allow-headers', 'authorization, content-type, x-runner-tenant, x-runner-user');
                response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
                if (request.method === 'OPTIONS') {
                    response.writeHead(204);
                    return response.end();
                }
            }
            const path = url.pathname;
            if (request.method === 'GET' && path === '/health') {
                // Public and numbers only: a guide in a browser checks it from another origin.
                response.setHeader('access-control-allow-origin', '*');
                return send(response, 200, { ok: true, version: runtime.config.version, ...runtime.load() });
            }
            if (request.method === 'GET' && (path === '/' || path === '/console')) {
                response.writeHead(302, { location: '/console/' });
                return response.end();
            }
            if (request.method === 'GET' && path.startsWith('/console/')) return consoleFile(response, path);
            if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found');
            const parts = path.slice('/v1/'.length).split('/').filter(Boolean).map(decodeURIComponent);
            const [area, ...rest] = parts;

            if (area === 'pair' && !rest.length && request.method === 'POST') {
                const body = await json(request);
                const made = runtime.registry.pair(String(body.code ?? ''), typeof body.name === 'string' ? body.name : undefined);
                log('paired', { key: made.record.id, name: made.record.name });
                return send(response, 200, { key: made.key, record: made.record, version: runtime.config.version });
            }
            if (area === 'pair' && rest[0] === 'requests' && rest.length === 1 && request.method === 'POST') {
                const body = await json(request);
                const forwarded = header(request, 'x-forwarded-for')?.split(',')[0]?.trim();
                const made = runtime.registry.requestPairing(typeof body.name === 'string' ? body.name : '', forwarded || request.socket.remoteAddress || undefined);
                const base = runtime.config.publicUrl ?? `https://${header(request, 'host') ?? 'localhost'}`;
                log('pairing requested', { from: forwarded || request.socket.remoteAddress });
                return send(response, 201, { ...made, approveUrl: `${base}/console/?approve=${encodeURIComponent(made.code)}`, interval: 2 });
            }
            if (area === 'pair' && rest[0] === 'requests' && rest[1] === 'poll' && rest.length === 2 && request.method === 'POST') {
                const body = await json(request);
                const polled = runtime.registry.pollPairing(String(body.request ?? ''));
                if (polled.status === 'approved') {
                    log('paired', { key: polled.record.id, name: polled.record.name });
                    return send(response, 200, { ...polled, version: runtime.config.version });
                }
                return send(response, 200, polled);
            }
            // A call of a tool by the harness of a chat, from its container: the token of the chat, not a key.
            if (area === 'internal' && rest.length === 4 && rest[1] === 'chats' && rest[3] === 'tool' && request.method === 'POST') {
                const tenant = runtime.tenant(rest[0]);
                if (!tenant) throw new HttpError(404, 'not found');
                const body = await json(request);
                const input = body.input && typeof body.input === 'object' ? body.input as Record<string, unknown> : {};
                return send(response, 200, await tenant.chats.callTool(rest[2], String(request.headers['x-chat-token'] ?? ''), String(body.name ?? ''), input));
            }

            const caller = callerOf(request);
            if (area === 'admin') {
                if (caller.kind !== 'admin') throw new HttpError(403, 'forbidden');
                if (rest[0] === 'pairing' && rest.length === 1 && request.method === 'POST') {
                    const code = runtime.registry.createPairing();
                    log('pairing code made');
                    return send(response, 201, code);
                }
                if (rest[0] === 'pairing' && rest[1] === 'requests' && rest.length === 2 && request.method === 'GET') {
                    return send(response, 200, { requests: runtime.registry.pairingRequests() });
                }
                if (rest[0] === 'pairing' && rest[1] === 'requests' && rest.length === 4 && (rest[3] === 'approve' || rest[3] === 'deny') && request.method === 'POST') {
                    const answered = runtime.registry.answerPairing(rest[2], rest[3] === 'approve');
                    log(rest[3] === 'approve' ? 'pairing approved' : 'pairing denied', { name: answered.name });
                    return send(response, 200, { request: answered });
                }
                throw new HttpError(404, 'not found');
            }
            if (area === 'platform') return await platform(request, response, caller, rest);
            if (area === 'info' && !rest.length && request.method === 'GET') {
                return send(response, 200, {
                    version: runtime.config.version,
                    harnesses: ['claude-code', 'opencode'],
                    capabilities: { complete: true, chats: true, tools: !!runtime.deps.toolsBase, files: true },
                    permissions: caller.kind === 'project' ? caller.key.permissions : [...PERMISSIONS],
                    ...(caller.kind === 'project' ? { tenant: caller.key.tenant } : {}),
                });
            }
            if (area === 'accounts') return await accounts(request, response, caller, rest);
            if (area === 'models' && !rest.length && request.method === 'GET') {
                const scope = scopeOf(request, caller);
                const tenant = runtime.tenant(scope.tenant)!;
                const keys = runtime.accounts.keysFor(scope);
                const providers = offerOf(keys, tenant.credit.exhausted).map((offer) => {
                    const listed = keys.accounts[offer.id] ?? [];
                    return { ...offer, yours: listed.filter((account) => account.id.startsWith('u:')).length, tenant: listed.filter((account) => account.id.startsWith('t:')).length };
                });
                return send(response, 200, { providers });
            }
            if (area === 'complete' && !rest.length && request.method === 'POST') {
                const scope = scopeOf(request, caller);
                need(caller, 'complete');
                const completion = completionRequestOf(await json(request, MAX_COMPLETION));
                if (!completion) throw new HttpError(400, 'invalid');
                return send(response, 200, await runtime.tenant(scope.tenant)!.completions.complete(completion, { key: keyName(caller), ...(scope.user ? { user: scope.user } : {}) }));
            }
            if (area === 'chats') return await chats(request, response, caller, rest);
            throw new HttpError(404, 'not found');
        } catch (error) {
            if (error instanceof HttpError) return send(response, error.status, { error: error.message, ...error.extra });
            if (error instanceof RegistryError || error instanceof ChatError) return send(response, error.status, { error: error.message });
            if (error instanceof CompletionError) return send(response, error.status, { error: error.message, ...(error.until ? { until: error.until } : {}) });
            log('request failed', { error: (error as Error).message });
            send(response, 500, { error: 'failed' });
        }
    });
}
