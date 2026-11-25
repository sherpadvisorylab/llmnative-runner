import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAccounts } from './claudeAccounts.ts';
import { CLAUDE_CODE } from './providers.ts';

// The accounts of the harnesses, by scope: a tenant (used by everyone of it) or a person of a tenant (used by them
// only). Claude subscriptions are signed in with `claude setup-token` (claudeAccounts.ts); the other providers are a
// key. Secrets stay in the folder of the scope (0600), never in an answer: clients see ids, labels, dates, order.

export const OPENCODE_GO = 'opencode-go';
export const OPENCODE_ZEN = 'opencode';
/** The providers of the runner and the variable each harness reads. */
export const ACCOUNT_PROVIDERS = {
    [CLAUDE_CODE]: 'CLAUDE_CODE_OAUTH_TOKEN',
    [OPENCODE_GO]: 'OPENCODE_GO_API_KEY',
    [OPENCODE_ZEN]: 'OPENCODE_API_KEY',
} as const;
export type AccountProvider = keyof typeof ACCOUNT_PROVIDERS;
export const isAccountProvider = (value: string): value is AccountProvider => Object.hasOwn(ACCOUNT_PROVIDERS, value);
/** A person of a tenant, as the client names them (a Firebase uid, an email hash…). */
export const USER_ID = /^[A-Za-z0-9_.@-]{1,128}$/;
const KEY_PATTERN = /^[\x21-\x7e]{8,400}$/;

export type Scope = { tenant: string; user?: string };
export type AccountView = { provider: AccountProvider; id: string; label?: string; at: string; scope: 'user' | 'tenant' };
type KeyFile = { keys: Partial<Record<AccountProvider, Array<{ id: string; label?: string; key: string; at: string }>>>; order: Partial<Record<AccountProvider, string[]>> };

const newId = () => randomBytes(5).toString('hex').slice(0, 8);

function readJson<T>(file: string, fallback: T): T {
    try {
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback;
    } catch {
        return fallback;
    }
}

export function writeJson(file: string, value: unknown) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
}

/** The accounts of one scope. */
export class ScopeAccounts {
    readonly claude: ClaudeAccounts;
    readonly scope: Scope;
    private readonly file: string;
    private readonly now: () => Date;

    constructor(dir: string, scope: Scope, claude: (file: string) => ClaudeAccounts, now = () => new Date()) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.scope = scope;
        this.file = join(dir, 'keys.json');
        this.claude = claude(join(dir, 'claude.json'));
        this.now = now;
    }

    private read(): KeyFile {
        const saved = readJson<KeyFile>(this.file, { keys: {}, order: {} });
        return { keys: saved.keys ?? {}, order: saved.order ?? {} };
    }

    /** Every account of the scope, in its order per provider; never a secret. */
    list(): AccountView[] {
        const saved = this.read();
        const scope = this.scope.user ? 'user' : 'tenant';
        return (Object.keys(ACCOUNT_PROVIDERS) as AccountProvider[]).flatMap((provider) => {
            const items = provider === CLAUDE_CODE
                ? this.claude.list().map(({ id, at, label }) => ({ id, at, label }))
                : (saved.keys[provider] ?? []).map(({ id, at, label }) => ({ id, at, label }));
            return ordered(items, saved.order[provider]).map((item) => ({ provider, id: item.id, at: item.at, scope, ...(item.label ? { label: item.label } : {}) }));
        });
    }

    /** The secrets of the scope per provider, in order: for the harnesses only. */
    secrets(): Record<AccountProvider, Array<{ id: string; label?: string; value: string }>> {
        const saved = this.read();
        const tokens = this.claude.tokens();
        const claude = ordered(this.claude.list(), saved.order[CLAUDE_CODE]).map(({ id, label }) => ({ id, ...(label ? { label } : {}), value: tokens[id] }));
        const of = (provider: AccountProvider) => ordered(saved.keys[provider] ?? [], saved.order[provider]).map(({ id, label, key }) => ({ id, ...(label ? { label } : {}), value: key }));
        return { [CLAUDE_CODE]: claude, [OPENCODE_GO]: of(OPENCODE_GO), [OPENCODE_ZEN]: of(OPENCODE_ZEN) };
    }

    /** A key of a provider (not Claude Code: its token comes from the sign-in). */
    addKey(provider: AccountProvider, key: string, label?: string): AccountView | undefined {
        if (provider === CLAUDE_CODE || !KEY_PATTERN.test(key.trim())) return undefined;
        const saved = this.read();
        const id = newId();
        const name = label?.trim().slice(0, 60);
        const at = this.now().toISOString();
        saved.keys[provider] = [...(saved.keys[provider] ?? []), { id, key: key.trim(), at, ...(name ? { label: name } : {}) }];
        writeJson(this.file, saved);
        return { provider, id, at, scope: this.scope.user ? 'user' : 'tenant', ...(name ? { label: name } : {}) };
    }

    remove(provider: AccountProvider, id: string): boolean {
        if (provider === CLAUDE_CODE) return this.claude.remove(id);
        const saved = this.read();
        const before = saved.keys[provider] ?? [];
        saved.keys[provider] = before.filter((item) => item.id !== id);
        if (saved.keys[provider]!.length === before.length) return false;
        writeJson(this.file, saved);
        return true;
    }

    /** The order of the accounts of a provider: the ids given first, the others after as they were. */
    setOrder(provider: AccountProvider, ids: string[]): boolean {
        const known = new Set(this.list().filter((item) => item.provider === provider).map((item) => item.id));
        if (!ids.every((id) => known.has(id))) return false;
        const saved = this.read();
        saved.order[provider] = [...new Set(ids)];
        writeJson(this.file, saved);
        return true;
    }

    /** A new id for a Claude subscription being signed in. */
    newClaudeId(): string {
        return newId();
    }
}

function ordered<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
    if (!order?.length) return items;
    const at = (id: string) => {
        const index = order.indexOf(id);
        return index < 0 ? order.length : index;
    };
    return items.map((item, index) => ({ item, index })).sort((a, b) => at(a.item.id) - at(b.item.id) || a.index - b.index).map(({ item }) => item);
}

/** The n-th variable (from 1) of a provider, as providers.ts reads them: `<VAR>`, `<VAR>__2`… */
const variable = (name: string, index: number) => (index > 1 ? `${name}__${index}` : name);

/**
 * The keys a request runs with: the accounts of the person first, then those of the tenant, as the variables
 * and the listed accounts providers.ts takes. Account ids are prefixed by their scope (`u:` / `t:`), unique in
 * the tenant: the credit of each is known by them.
 */
export function keysOf(scopes: ScopeAccounts[]): { env: Record<string, string>; accounts: Record<string, Array<{ id: string; label?: string }>> } {
    const env: Record<string, string> = {};
    const accounts: Record<string, Array<{ id: string; label?: string }>> = {};
    const all = scopes.map((scope) => ({ tag: scope.scope.user ? 'u' : 't', secrets: scope.secrets() }));
    for (const provider of Object.keys(ACCOUNT_PROVIDERS) as AccountProvider[]) {
        const list = all.flatMap(({ tag, secrets }) => secrets[provider].filter((item) => item.value).map((item) => ({ ...item, id: `${tag}:${item.id}` })));
        list.slice(0, 20).forEach((item, index) => {
            env[variable(ACCOUNT_PROVIDERS[provider], index + 1)] = item.value;
            (accounts[provider] ??= []).push({ id: item.id, ...(item.label ? { label: item.label } : {}) });
        });
    }
    return { env, accounts };
}

/** The accounts of every scope of the runner, one object per scope for its whole life (a sign-in under way is kept). */
export class AccountsRegistry {
    private readonly scopes = new Map<string, ScopeAccounts>();
    private readonly dataDir: string;
    private readonly claude: (file: string) => ClaudeAccounts;

    constructor(dataDir: string, claude: (file: string) => ClaudeAccounts) {
        this.dataDir = dataDir;
        this.claude = claude;
    }

    of(scope: Scope): ScopeAccounts {
        const key = `${scope.tenant}/${scope.user ?? ''}`;
        let accounts = this.scopes.get(key);
        if (!accounts) {
            const base = join(this.dataDir, 'tenants', scope.tenant, 'accounts');
            const dir = scope.user ? join(base, 'users', Buffer.from(scope.user).toString('base64url')) : join(base, 'tenant');
            this.scopes.set(key, accounts = new ScopeAccounts(dir, scope, this.claude));
        }
        return accounts;
    }

    /** What a request runs with: the person's scope first (when there is one), then the tenant's. */
    keysFor(scope: Scope) {
        return keysOf([...(scope.user ? [this.of(scope)] : []), this.of({ tenant: scope.tenant })]);
    }

    /** Forgets the scopes of a tenant (taken off the runner). */
    forget(tenant: string) {
        for (const key of [...this.scopes.keys()]) if (key.startsWith(`${tenant}/`)) this.scopes.delete(key);
    }
}
