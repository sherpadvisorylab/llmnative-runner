import { createSign } from 'node:crypto';

// GitHub as the App of the company sees it: a JWT signed with its private key, installation tokens
// minted from it. `fetch` is injected so tests can stand in for GitHub.

export class GitHubError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

export type TokenPermissions = Record<string, 'read' | 'write'>;

export interface GitHubApi {
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
    graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
    /** A token for one turn: one repository, the permissions of the agent; valid for an hour. */
    turnToken(repository: string, permissions: TokenPermissions): Promise<string>;
    /** An answer that is text, not JSON (the log of a job of Actions). */
    text?(path: string): Promise<string>;
}

export type AppCredentials = { appId: string; privateKey: string; installationId?: number };

const API = 'https://api.github.com';

export function appJwt(app: { appId: string; privateKey: string }, now = Date.now()): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const issued = Math.floor(now / 1000) - 60;
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued, exp: issued + 540, iss: app.appId })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(app.privateKey, 'base64url')}`;
}

/** A fetch that tries again when GitHub cannot be reached or answers 502/503/504. */
export function retryingFetch(plain: typeof fetch, attempts = 4, wait = (ms: number) => new Promise((done) => setTimeout(done, ms))): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        for (let attempt = 1; ; attempt += 1) {
            try {
                const response = await plain(input, init);
                if (attempt < attempts && [502, 503, 504].includes(response.status)) {
                    await wait(attempt * 2000);
                    continue;
                }
                return response;
            } catch (error) {
                if (attempt >= attempts) throw error;
                await wait(attempt * 2000);
            }
        }
    }) as typeof fetch;
}

export function createGitHub(app: AppCredentials, fetchGitHub: typeof fetch = retryingFetch(globalThis.fetch), now = () => Date.now()): GitHubApi {
    let installationId = app.installationId;
    let cached: { token: string; expires: number } | undefined;

    async function call<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
        const response = await fetchGitHub(url.startsWith('http') ? url : `${API}${url}`, {
            method,
            headers: {
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'llmnative-playbook-dispatcher',
                authorization: `Bearer ${token}`,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : undefined;
        if (!response.ok) throw new GitHubError(data?.message ?? `GitHub answered ${response.status}`, response.status);
        return data as T;
    }

    async function installation(): Promise<number> {
        if (installationId) return installationId;
        // The App of a company is installed on its organization only.
        const installations = await call<{ id: number }[]>('GET', '/app/installations', appJwt(app, now()));
        if (installations.length !== 1) throw new GitHubError(`The App has ${installations.length} installations: set GITHUB_INSTALLATION_ID`);
        installationId = installations[0].id;
        return installationId;
    }

    async function mint(body: object): Promise<{ token: string; expires_at: string }> {
        return call('POST', `/app/installations/${await installation()}/access_tokens`, appJwt(app, now()), body);
    }

    /** The token of the dispatcher itself: every permission of the installation, renewed before it expires. */
    async function token(): Promise<string> {
        if (!cached || cached.expires - now() < 5 * 60_000) {
            const minted = await mint({});
            cached = { token: minted.token, expires: Date.parse(minted.expires_at) };
        }
        return cached.token;
    }

    return {
        async request<T>(method: string, path: string, body?: unknown) {
            return call<T>(method, path, await token(), body);
        },
        async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
            const result = await call<{ data: T; errors?: { message: string }[] }>('POST', '/graphql', await token(), { query, variables });
            if (result.errors?.length) throw new GitHubError(result.errors.map((error) => error.message).join('; '));
            return result.data;
        },
        async turnToken(repository: string, permissions: TokenPermissions) {
            return (await mint({ repositories: [repository.split('/')[1]], permissions })).token;
        },
        async text(path: string) {
            // A log redirects to storage that needs no token: fetch drops it on the way.
            const response = await fetchGitHub(`${API}${path}`, { headers: { 'user-agent': 'llmnative-playbook-dispatcher', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${await token()}` } });
            if (!response.ok) throw new GitHubError(`GitHub answered ${response.status}`, response.status);
            return response.text();
        },
    };
}
