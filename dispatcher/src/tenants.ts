import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPANY_ID_PATTERN, ConfigError, parseEnvFile, readCompanyConfig, type CompanyConfig, type MachineConfig } from './config.ts';
import { Dispatcher, type FailureStore, type Log } from './dispatcher.ts';
import type { RunTurn } from './docker.ts';
import { createGitHub, type GitHubApi } from './github.ts';
import { Deliveries } from './webhook.ts';
import { DesignSessions, type DesignHost, type DesignSlots } from './designs.ts';

// The companies of a runner. Each one is a world of its own inside the dispatcher: its GitHub App,
// its queue, its failures, its logs, its secrets masked in them. Nothing of a company reaches another.

export interface Tenant {
    id: string;
    config: CompanyConfig;
    github: GitHubApi;
    dispatcher: Dispatcher;
    /** Its design sessions. */
    designs: DesignSessions;
    deliveries: Deliveries;
    mask: (text: string) => string;
    log: Log;
    /** When its .env was last read, to reload it when it changes. */
    version: string;
}

/** The secrets of a company never reach a log: the values of its turns, its webhook secret, its studio token, installation tokens. */
export function masker(config: CompanyConfig) {
    const secrets = [...Object.values(config.agentEnv), config.webhookSecret ?? '', config.studioToken ?? ''].filter((value) => value.length >= 8);
    return (text: string) => secrets.reduce((all, secret) => all.split(secret).join('***'), text).replace(/gh[suo]_[A-Za-z0-9]{20,}/g, '***');
}

/** The failures in a row of each issue of a company, in a JSON file that survives a restart. */
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

export interface TenantDeps {
    machine: MachineConfig;
    /** Runs a turn of this company: the image, on the machine, within the limit of the machine. */
    runTurn: (config: CompanyConfig) => RunTurn;
    /** The containers of the design sessions of this company. */
    designHost: (config: CompanyConfig) => DesignHost;
    /** Design sessions at once on the machine, every company together. */
    designSlots: DesignSlots;
    /** The design agents of the runner by kit (image and start command); empty: no design sessions here. */
    designKits?: Record<string, { image: string; command: string }>;
    /** For tests; by default GitHub itself. */
    github?: (config: CompanyConfig) => GitHubApi;
    /** For tests; by default the real fetch. */
    fetch?: typeof fetch;
}

export function createTenant(config: CompanyConfig, version: string, deps: TenantDeps): Tenant {
    const dir = join(deps.machine.dataDir, 'companies', config.id);
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    const mask = masker(config);
    const log: Log = (line, details) => console.log(mask(JSON.stringify({ at: new Date().toISOString(), company: config.id, msg: line, ...details })));
    const github = deps.github?.(config) ?? createGitHub({ appId: config.appId, privateKey: config.privateKey, installationId: config.installationId });
    const dispatcher = new Dispatcher({
        mask,
        github,
        runTurn: deps.runTurn(config),
        failures: fileFailures(join(dir, 'failures.json')),
        options: { maxParallel: config.maxParallel, turnTimeout: deps.machine.turnTimeout, failuresToBlock: deps.machine.failuresToBlock, agentEnv: config.agentEnv },
        log,
        turnLog: {
            write(key, text) {
                appendFileSync(join(logs, `${key.replace(/[^A-Za-z0-9_.-]/g, '-')}.log`), `\n===== ${new Date().toISOString()}\n${mask(text)}\n`);
            },
        },
    });
    const designs = new DesignSessions({
        company: config.id,
        github,
        host: deps.designHost(config),
        slots: deps.designSlots,
        file: join(dir, 'designs.json'),
        agentEnv: config.agentEnv,
        log,
        idleMinutes: deps.machine.design.idleMinutes,
        keepDays: deps.machine.design.keepDays,
        kits: deps.designKits ?? {},
        fetch: deps.fetch,
    });
    return { id: config.id, config, github, dispatcher, designs, deliveries: new Deliveries(), mask, log, version };
}

/** The .env of each company in the folder, with when it changed: `<dir>/<company>/.env`. */
export function readCompanyFiles(dir: string): Array<{ id: string; vars: Record<string, string>; version: string }> {
    if (!existsSync(dir)) return [];
    const found: Array<{ id: string; vars: Record<string, string>; version: string }> = [];
    for (const id of readdirSync(dir)) {
        const file = join(dir, id, '.env');
        if (!COMPANY_ID_PATTERN.test(id) || !existsSync(file)) continue;
        found.push({ id, vars: parseEnvFile(readFileSync(file, 'utf8')), version: String(statSync(file).mtimeMs) });
    }
    return found;
}

/**
 * The .env of every company of the machine: the folder of the machine, and the one the studio sends
 * to (in the data of the dispatcher), which wins for a company in both: it is the newer way.
 */
export function readAllCompanyFiles(machine: Pick<MachineConfig, 'companiesDir' | 'pushedDir'>): Array<{ id: string; vars: Record<string, string>; version: string; sent: boolean }> {
    const sent = readCompanyFiles(machine.pushedDir).map((file) => ({ ...file, version: `sent-${file.version}`, sent: true }));
    const placed = readCompanyFiles(machine.companiesDir).filter((file) => !sent.some((other) => other.id === file.id)).map((file) => ({ ...file, sent: false }));
    return [...sent, ...placed];
}

/**
 * The .env the studio sends for a company, checked as the runner will read it, then written whole
 * (a temporary file renamed, readable by the dispatcher only). The secret of the webhook is of the
 * runner when the studio has none (set by hand, docs/runner-setup.md §6.3): kept, not lost.
 */
export function writeSentCompany(machine: Pick<MachineConfig, 'companiesDir' | 'pushedDir'>, id: string, text: string): { names: string[]; kept: string[] } {
    if (!COMPANY_ID_PATTERN.test(id)) throw new ConfigError(`${id}: not a company id`);
    const vars = parseEnvFile(text);
    const kept: string[] = [];
    const current = readAllCompanyFiles(machine).find((file) => file.id === id);
    let body = text.endsWith('\n') ? text : `${text}\n`;
    if (!vars.GITHUB_WEBHOOK_SECRET && current?.vars.GITHUB_WEBHOOK_SECRET) {
        vars.GITHUB_WEBHOOK_SECRET = current.vars.GITHUB_WEBHOOK_SECRET;
        body += `GITHUB_WEBHOOK_SECRET=${current.vars.GITHUB_WEBHOOK_SECRET}\n`;
        kept.push('GITHUB_WEBHOOK_SECRET');
    }
    readCompanyConfig(id, vars);
    const dir = join(machine.pushedDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, '.env');
    writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return { names: Object.keys(vars), kept };
}

/** Takes off the .env the studio sent for a company; false when there was none (a file of the machine stays). */
export function removeSentCompany(machine: Pick<MachineConfig, 'pushedDir'>, id: string): boolean {
    if (!COMPANY_ID_PATTERN.test(id)) return false;
    const file = join(machine.pushedDir, id, '.env');
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
}

/**
 * The companies of the runner, kept in step with their folder: a new .env adds a company, a changed
 * one reloads it, a removed one takes it off. A company whose .env is wrong is skipped and said so.
 */
export class Tenants {
    private readonly tenants = new Map<string, Tenant>();
    private readonly deps: TenantDeps;
    private readonly fixed: CompanyConfig[];
    readonly problems = new Map<string, string>();

    constructor(deps: TenantDeps, fixed: CompanyConfig[] = []) {
        this.deps = deps;
        this.fixed = fixed;
    }

    get(id: string): Tenant | undefined {
        return this.tenants.get(id);
    }

    all(): Tenant[] {
        return [...this.tenants.values()];
    }

    /** Reads the folder again; returns the companies added or reloaded, to start them. */
    sync(files: Array<{ id: string; vars: Record<string, string>; version: string }> = readAllCompanyFiles(this.deps.machine)): Tenant[] {
        const started: Tenant[] = [];
        const seen = new Set<string>();
        for (const config of this.fixed) {
            seen.add(config.id);
            if (!this.tenants.has(config.id)) {
                const tenant = createTenant(config, 'env', this.deps);
                this.tenants.set(config.id, tenant);
                started.push(tenant);
            }
        }
        for (const file of files) {
            if (seen.has(file.id)) continue;
            seen.add(file.id);
            const current = this.tenants.get(file.id);
            if (current?.version === file.version) continue;
            // A company whose .env changed while its turns run is reloaded once they are over: the
            // same issue never runs twice.
            if (current && current.dispatcher.state.running.length) continue;
            try {
                const tenant = createTenant(readCompanyConfig(file.id, file.vars), file.version, this.deps);
                this.tenants.set(file.id, tenant);
                this.problems.delete(file.id);
                started.push(tenant);
            } catch (error) {
                if (!(error instanceof ConfigError)) throw error;
                this.problems.set(file.id, error.message);
                this.tenants.delete(file.id);
            }
        }
        for (const id of [...this.tenants.keys()]) if (!seen.has(id)) this.tenants.delete(id);
        return started;
    }
}

/** At most `limit` turns at once on the machine, every company together; the others wait their turn. */
export function machineLimit(limit: number) {
    let running = 0;
    const waiting: Array<() => void> = [];
    return async <T>(work: () => Promise<T>): Promise<T> => {
        if (running >= limit) await new Promise<void>((go) => waiting.push(go));
        running += 1;
        try {
            return await work();
        } finally {
            running -= 1;
            waiting.shift()?.();
        }
    };
}
