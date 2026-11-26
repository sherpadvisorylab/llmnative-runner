import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AccountsRegistry } from './accounts.ts';
import { ServerChats, type ChatHost } from './chats.ts';
import { ClaudeAccounts } from './claudeAccounts.ts';
import { ServerCompletions } from './completions.ts';
import type { RunnerConfig } from './config.ts';
import { Credit } from './credit.ts';
import type { RunnerModule } from './modules.ts';
import { Registry } from './registry.ts';

// Everything the runner holds while it runs: its tenants and keys (registry), the accounts of every scope, and for
// each tenant its chats, answers and credit. One object, created by main.ts (or by a test with fakes).

export type Log = (line: string, details?: Record<string, unknown>) => void;

export type TenantRuntime = { chats: ServerChats; completions: ServerCompletions; credit: Credit };

export type RuntimeDeps = {
    config: RunnerConfig;
    host: ChatHost;
    log: Log;
    /** How a Claude subscription is signed in; by default `claude setup-token` in a container of the agent image. */
    claude?: (file: string) => ClaudeAccounts;
    /** Where the containers call the tools of a chat back, from inside the network; none: chats without tools. */
    toolsBase?: string;
    now?: () => number;
};

/** The admin token of the machine: made at the first start (0600), read by the installer and the console. */
export function adminTokenOf(file: string): string {
    if (existsSync(file)) {
        const token = readFileSync(file, 'utf8').trim();
        if (token.length >= 32) return token;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
}

export class Runtime {
    readonly registry: Registry;
    readonly accounts: AccountsRegistry;
    readonly deps: RuntimeDeps;
    private readonly tenants = new Map<string, TenantRuntime>();
    private readonly adminToken: string;
    /** The modules started (modules.ts): told when a tenant goes. */
    modules: RunnerModule[] = [];

    constructor(deps: RuntimeDeps) {
        this.deps = deps;
        const dir = deps.config.dataDir;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.registry = new Registry(join(dir, 'registry.json'), deps.now);
        this.adminToken = adminTokenOf(join(dir, 'admin-token'));
        this.accounts = new AccountsRegistry(dir, deps.claude ?? ((file) => ClaudeAccounts.docker(file, deps.config.agentImage)));
    }

    get config() {
        return this.deps.config;
    }

    isAdmin(bearer: string): boolean {
        const given = Buffer.from(bearer);
        const expected = Buffer.from(this.adminToken);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }

    /** The chats, answers and credit of a tenant of the registry; none for an unknown one. */
    tenant(id: string): TenantRuntime | undefined {
        if (!this.registry.tenant(id)) return undefined;
        let runtime = this.tenants.get(id);
        if (!runtime) {
            const { config, host, log, toolsBase, now } = this.deps;
            const credit = new Credit(join(config.dataDir, 'tenants', id, 'credit.json'), now);
            const keys = (user?: string) => this.accounts.keysFor({ tenant: id, ...(user ? { user } : {}) });
            const chats = new ServerChats({
                tenant: id,
                image: config.agentImage,
                host,
                keys,
                log,
                credit,
                ...(now ? { now } : {}),
                maxChats: config.maxChatsPerTenant,
                ...(toolsBase ? { toolsUrl: (chat: string) => `${toolsBase}/v1/internal/${id}/chats/${chat}/tool` } : {}),
            });
            const completions = new ServerCompletions({
                tenant: id,
                image: config.agentImage,
                host,
                keys,
                log,
                credit: { exhausted: credit.exhausted, spent: credit.spent, until: credit.resetOf },
                ...(now ? { now } : {}),
                parallel: config.maxCompletionsPerTenant,
            });
            this.tenants.set(id, runtime = { chats, completions, credit });
        }
        return runtime;
    }

    /** Takes a tenant off: its chats closed, its keys gone, its accounts kept on disk until removed by hand. */
    async removeTenant(id: string): Promise<boolean> {
        for (const module of this.modules) await Promise.resolve(module.removeTenant?.(id)).catch((error: Error) => this.deps.log('module removeTenant failed', { module: module.name, error: error.message }));
        await this.tenants.get(id)?.chats.closeAll();
        this.tenants.delete(id);
        this.accounts.forget(id);
        return this.registry.removeTenant(id);
    }

    /** How busy the runner is, every tenant together. */
    load() {
        const all = [...this.tenants.values()];
        return {
            chats: all.reduce((sum, tenant) => sum + tenant.chats.load.open, 0),
            answering: all.reduce((sum, tenant) => sum + tenant.chats.load.busy, 0),
            completions: all.reduce((sum, tenant) => sum + tenant.completions.load, 0),
            maxChats: this.deps.config.maxChats,
        };
    }

    /** How many people of a tenant have accounts of their own here. */
    usersWithAccounts(tenant: string): number {
        const dir = join(this.deps.config.dataDir, 'tenants', tenant, 'accounts', 'users');
        if (!existsSync(dir)) return 0;
        return readdirSync(dir).filter((user) => this.accounts.of({ tenant, user: Buffer.from(user, 'base64url').toString() }).list().length > 0).length;
    }

    /** Closes the chats idle for long, of every tenant. */
    async sweep() {
        for (const tenant of this.tenants.values()) await tenant.chats.sweep();
    }

    async stop() {
        for (const tenant of this.tenants.values()) await tenant.chats.closeAll();
    }
}
