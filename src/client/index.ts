// @llmnative/runner/client — the client of the API v1 of the LLMNative Runner, for the browser and for Node.
//
// A key never belongs in the browser of the people of a tenant: a host app talks to the runner from its backend
// (`createRunnerProxy` forwards the requests of its signed-in people, adding the key, the tenant and the person),
// and its pages use `RunnerClient` against that backend. The console of the runner and a personal app with a key of
// its own use `RunnerClient` directly.

export type RunnerProvider = 'claude-code' | 'opencode-go' | 'opencode';
export type RunnerPermission = 'complete' | 'chat' | 'chat:tools' | 'accounts' | 'accounts:tenant' | 'act-as-user' | 'keys';

export type RunnerAccount = {
    provider: RunnerProvider;
    id: string;
    label?: string;
    /** When it was connected. */
    at: string;
    scope: 'user' | 'tenant';
    /** Out of credit until then (the limit of a subscription); absent when it has credit. */
    noCreditUntil?: string;
};

export type RunnerModels = {
    providers: Array<{ id: 'claude-code' | 'opencode-go'; models: string[]; accounts: number; available: number; yours: number; tenant: number }>;
};

export type RunnerTenant = { id: string; name: string; createdAt: string; usersWithAccounts?: number };
export type RunnerKey = { id: string; kind: 'platform' | 'project'; tenant?: string; name: string; permissions: RunnerPermission[]; createdAt: string; expiresAt: string | null };

export type RunnerStatus = {
    version: string;
    agentImage: string;
    url?: string;
    load: { chats: number; answering: number; completions: number; maxChats: number };
    machine: { totalBytes: number; availableBytes: number; cpus: number };
    tenants: RunnerTenant[];
};

/** A pairing request made by a platform: `request` is its secret (keep it in the backend), `code` is shown on both sides. */
export type RunnerPairingRequest = { request: string; code: string; approveUrl: string; expiresAt: string; interval: number };
export type RunnerPairingPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; key: string; record: RunnerKey; version: string };
export type RunnerPairingRequestView = { code: string; name: string; from?: string; createdAt: string; expiresAt: string };
export type RunnerHealth = { ok: boolean; version: string; chats: number; answering: number; completions: number; maxChats: number };

export type RunnerCompletionRequest = { provider: 'claude-code' | 'opencode-go'; model: string; prompt: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
export type RunnerCompletion = { text: string; usage?: { inputTokens: number; outputTokens: number } };

export type RunnerChatTool = { name: string; description: string; inputSchema: Record<string, unknown>; endsTurn?: boolean };
export type RunnerChatModel = { provider: string; model: string; variant?: string; name?: string; effort?: string };
export type RunnerChatEvent =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'step'; id: string; label: string; status: 'running' | 'done' }
    | { type: 'tool-call'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'done' }
    | { type: 'error'; message: string };

/** An error of the runner: its status and code (`no-credit`, `busy`…), and for `no-credit` until when. */
export class RunnerError extends Error {
    readonly status: number;
    readonly code: string;
    readonly until?: string;
    readonly detail?: string;

    constructor(status: number, code: string, extra: { until?: string; detail?: string } = {}) {
        super(code);
        this.name = 'RunnerError';
        this.status = status;
        this.code = code;
        if (extra.until) this.until = extra.until;
        if (extra.detail) this.detail = extra.detail;
    }
}

/** When a chat event says the accounts ran out of credit: until when (`no-credit:<iso>`). */
export const noCreditUntil = (event: RunnerChatEvent): string | undefined =>
    event.type === 'error' && event.message.startsWith('no-credit:') ? event.message.slice('no-credit:'.length) : undefined;

export type RunnerClientOptions = {
    /** The address of the runner (`https://runner.example.com`), or of the backend of the host that forwards to it. */
    url: string;
    /** A key of the runner (or the admin token in the console); none when the backend of the host adds it. */
    key?: string;
    /** With a platform key or the admin token: the tenant the requests are for. */
    tenant?: string;
    /** The person the requests are for (needs `act-as-user` with a project key). */
    user?: string;
    fetch?: typeof fetch;
    /** More headers for each request (the session of the host, for its backend). */
    headers?: () => Record<string, string> | Promise<Record<string, string>>;
};

export class RunnerClient {
    readonly options: RunnerClientOptions;

    constructor(options: RunnerClientOptions) {
        this.options = { ...options, url: options.url.replace(/\/+$/, '') };
    }

    /** The same runner for another tenant or person. */
    as(scope: { tenant?: string; user?: string }): RunnerClient {
        return new RunnerClient({ ...this.options, ...scope });
    }

    private async headers(json: boolean): Promise<Record<string, string>> {
        const { key, tenant, user, headers } = this.options;
        return {
            ...(json ? { 'content-type': 'application/json' } : {}),
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(tenant ? { 'x-runner-tenant': tenant } : {}),
            ...(user ? { 'x-runner-user': user } : {}),
            ...(await headers?.()),
        };
    }

    /** One request; its JSON, or a RunnerError. */
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await (this.options.fetch ?? fetch)(`${this.options.url}${path}`, {
            method,
            headers: await this.headers(body !== undefined),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        let data: Record<string, unknown> = {};
        try {
            data = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch {
            // Not JSON (a proxy in between): said by its status.
        }
        if (!response.ok) {
            throw new RunnerError(response.status, typeof data.error === 'string' ? data.error : `http-${response.status}`, {
                ...(typeof data.until === 'string' ? { until: data.until } : {}),
                ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
            });
        }
        return data as T;
    }

    // ── Public ──────────────────────────────────────────────────────────────────────────────────────────────
    health(): Promise<RunnerHealth> {
        return this.request('GET', '/health');
    }

    /** A pairing code (printed by the installer) → a platform key, seen once. */
    pair(code: string, name?: string): Promise<{ key: string; record: RunnerKey; version: string }> {
        return this.request('POST', '/v1/pair', { code, ...(name ? { name } : {}) });
    }

    /**
     * Asks to connect (device flow): the admin of the runner approves it in the console at `approveUrl`, where the
     * same `code` is shown; meanwhile `pollPairing(request)` every `interval` seconds, until it gives the key.
     */
    requestPairing(name: string): Promise<RunnerPairingRequest> {
        return this.request('POST', '/v1/pair/requests', { name });
    }

    pollPairing(request: string): Promise<RunnerPairingPoll> {
        return this.request('POST', '/v1/pair/requests/poll', { request });
    }

    info(): Promise<{ version: string; harnesses: string[]; capabilities: Record<string, boolean>; permissions: RunnerPermission[]; tenant?: string }> {
        return this.request('GET', '/v1/info');
    }

    // ── Admin token ─────────────────────────────────────────────────────────────────────────────────────────
    createPairing(): Promise<{ code: string; expiresAt: string }> {
        return this.request('POST', '/v1/admin/pairing');
    }

    async pairingRequests(): Promise<RunnerPairingRequestView[]> {
        return (await this.request<{ requests: RunnerPairingRequestView[] }>('GET', '/v1/admin/pairing/requests')).requests;
    }

    async answerPairing(code: string, approve: boolean): Promise<RunnerPairingRequestView> {
        return (await this.request<{ request: RunnerPairingRequestView }>('POST', `/v1/admin/pairing/requests/${encodeURIComponent(code)}/${approve ? 'approve' : 'deny'}`)).request;
    }

    // ── Platform key ────────────────────────────────────────────────────────────────────────────────────────
    readonly platform = {
        status: (): Promise<RunnerStatus> => this.request('GET', '/v1/platform/status'),
        tenants: async (): Promise<RunnerTenant[]> => (await this.request<{ tenants: RunnerTenant[] }>('GET', '/v1/platform/tenants')).tenants,
        /** A tenant, with its first project key unless `key: false` (seen once: keep it in the backend). */
        createTenant: (id: string, options: { name?: string; key?: boolean; keyPermissions?: RunnerPermission[] } = {}): Promise<{ tenant: RunnerTenant; key?: string; keyRecord?: RunnerKey }> =>
            this.request('POST', '/v1/platform/tenants', { id, ...options }),
        removeTenant: async (id: string): Promise<boolean> => (await this.request<{ removed: boolean }>('DELETE', `/v1/platform/tenants/${encodeURIComponent(id)}`)).removed,
        keys: async (tenant: string): Promise<RunnerKey[]> => (await this.request<{ keys: RunnerKey[] }>('GET', `/v1/platform/tenants/${encodeURIComponent(tenant)}/keys`)).keys,
        createKey: (tenant: string, input: { name?: string; permissions?: RunnerPermission[]; expiresAt?: string | null } = {}): Promise<{ key: string; record: RunnerKey }> =>
            this.request('POST', `/v1/platform/tenants/${encodeURIComponent(tenant)}/keys`, input),
        revokeKey: async (tenant: string, id: string): Promise<boolean> => (await this.request<{ removed: boolean }>('DELETE', `/v1/platform/tenants/${encodeURIComponent(tenant)}/keys/${encodeURIComponent(id)}`)).removed,
        platformKeys: async (): Promise<RunnerKey[]> => (await this.request<{ keys: RunnerKey[] }>('GET', '/v1/platform/keys')).keys,
        revokePlatformKey: async (id: string): Promise<boolean> => (await this.request<{ removed: boolean }>('DELETE', `/v1/platform/keys/${encodeURIComponent(id)}`)).removed,
    };

    // ── Accounts of the person (or of the tenant) ───────────────────────────────────────────────────────────
    readonly accounts = {
        list: async (): Promise<{ scope: 'user' | 'tenant'; accounts: RunnerAccount[] }> => this.request('GET', '/v1/accounts'),
        /** The sign-in of a Claude subscription: open `url`, then give the code Anthropic shows to `finishClaudeLogin`. */
        startClaudeLogin: (): Promise<{ url: string }> => this.request('POST', '/v1/accounts/claude-code/login'),
        finishClaudeLogin: async (code: string, label?: string): Promise<RunnerAccount> =>
            (await this.request<{ account: RunnerAccount }>('POST', '/v1/accounts/claude-code/login/code', { code, ...(label ? { label } : {}) })).account,
        /** A token made elsewhere with `claude setup-token`. */
        addClaudeToken: async (token: string, label?: string): Promise<RunnerAccount> =>
            (await this.request<{ account: RunnerAccount }>('POST', '/v1/accounts/claude-code', { token, ...(label ? { label } : {}) })).account,
        addKey: async (provider: 'opencode-go' | 'opencode', key: string, label?: string): Promise<RunnerAccount> =>
            (await this.request<{ account: RunnerAccount }>('POST', `/v1/accounts/${provider}`, { key, ...(label ? { label } : {}) })).account,
        remove: async (provider: RunnerProvider, id: string): Promise<boolean> =>
            (await this.request<{ removed: boolean }>('DELETE', `/v1/accounts/${provider}/${encodeURIComponent(id)}`)).removed,
        order: async (provider: RunnerProvider, ids: string[]): Promise<RunnerAccount[]> =>
            (await this.request<{ accounts: RunnerAccount[] }>('PUT', '/v1/accounts/order', { provider, ids })).accounts,
    };

    models(): Promise<RunnerModels> {
        return this.request('GET', '/v1/models');
    }

    complete(request: RunnerCompletionRequest): Promise<RunnerCompletion> {
        return this.request('POST', '/v1/complete', request);
    }

    // ── Chats ───────────────────────────────────────────────────────────────────────────────────────────────
    readonly chats = {
        /** A chat (id: 8 hex characters, chosen by the client), with the tools the harness may call. */
        start: (id: string, tools?: RunnerChatTool[]): Promise<{ id: string }> => this.request('POST', '/v1/chats', { id, ...(tools ? { tools } : {}) }),
        /** A message: its events as they come. Aborting the signal stops the harness. */
        send: (id: string, message: { text: string; model: RunnerChatModel; attachments?: Array<{ name: string; mimeType: string; base64: string }> }, signal?: AbortSignal): AsyncIterable<RunnerChatEvent> =>
            this.stream(`/v1/chats/${encodeURIComponent(id)}/messages`, message, signal),
        answerCall: async (id: string, callId: string, answer: { result?: unknown; isError?: boolean }): Promise<boolean> =>
            (await this.request<{ answered: boolean }>('POST', `/v1/chats/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}`, answer)).answered,
        stop: async (id: string): Promise<boolean> => (await this.request<{ stopped: boolean }>('POST', `/v1/chats/${encodeURIComponent(id)}/stop`)).stopped,
        close: async (id: string): Promise<boolean> => (await this.request<{ closed: boolean }>('DELETE', `/v1/chats/${encodeURIComponent(id)}`)).closed,
    };

    private async *stream(path: string, body: unknown, signal?: AbortSignal): AsyncIterable<RunnerChatEvent> {
        const response = await (this.options.fetch ?? fetch)(`${this.options.url}${path}`, { method: 'POST', headers: await this.headers(true), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
        if (!response.ok || !response.body) {
            let code = `http-${response.status}`;
            try {
                const data = await response.json() as { error?: string };
                if (data.error) code = data.error;
            } catch {
                // Said by its status.
            }
            throw new RunnerError(response.status, code);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const lines = buffer.split('\n');
            buffer = done ? '' : lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let event: RunnerChatEvent | { type: 'ping' };
                try {
                    event = JSON.parse(line) as RunnerChatEvent | { type: 'ping' };
                } catch {
                    continue;
                }
                if (event.type !== 'ping') yield event;
            }
            if (done) return;
        }
    }
}

// ── For the backend of a host ───────────────────────────────────────────────────────────────────────────────

/** The routes the people of a tenant may reach through the backend of the host: never the platform ones. */
const PERSON_ROUTES = /^\/v1\/(info|models|complete|accounts(\/[A-Za-z0-9_.:-]+){0,3}|chats(\/[a-f0-9]{8}(\/(messages|stop|calls\/[a-f0-9]{12}))?)?)$/;

export type RunnerProxyTarget = {
    /** The address of the runner of this tenant. */
    url: string;
    /** A project key of the tenant (with `act-as-user`), or a platform key with `tenant`. */
    key: string;
    tenant?: string;
    /** The signed-in person, verified by the host. */
    user: string;
};

/**
 * Forwards a request of a signed-in person to their runner: only the routes of a person, with the key, tenant and
 * person added by the host (whatever the browser sent for them is dropped). Streams answers (chat replies) as they
 * come. `path` is the path of the runner, e.g. `/v1/models` (the host strips its own prefix).
 */
export async function forwardToRunner(request: Request, path: string, target: RunnerProxyTarget, fetchImpl: typeof fetch = fetch): Promise<Response> {
    if (!PERSON_ROUTES.test(path)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const headers: Record<string, string> = {
        authorization: `Bearer ${target.key}`,
        'x-runner-user': target.user,
        ...(target.tenant ? { 'x-runner-tenant': target.tenant } : {}),
    };
    const type = request.headers.get('content-type');
    if (type) headers['content-type'] = type;
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.arrayBuffer();
    const url = new URL(request.url);
    const answer = await fetchImpl(`${target.url.replace(/\/+$/, '')}${path}${url.search}`, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: request.signal,
    });
    return new Response(answer.body, {
        status: answer.status,
        headers: {
            'content-type': answer.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
        },
    });
}
