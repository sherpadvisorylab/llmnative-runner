import { readFileSync } from 'node:fs';

// The settings of the dispatcher of a runner. The machine ones come from the environment of the
// container; each organization has its own file, <ORGANIZATIONS_DIR>/<organization>/.env, with its GitHub App, the
// secret of its webhook, the token of its studio and the keys of its models. A company only ever
// works with its own file.

/** The variables of a company handed to its turns when set: the keys of the model providers and the memory. */
export const DEFAULT_AGENT_ENV = [
    'OPENCODE_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'ZHIPU_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_KEY',
    'PLAYBOOK_MEMORY',
];

export const COMPANY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface MachineConfig {
    port: number;
    dataDir: string;
    /** Where the files of the organizations are (ORGANIZATIONS_DIR): one folder each, with its .env. */
    companiesDir: string;
    /** Where the studio sends them (`/_admin/organizations`): `<DATA_DIR>/organizations`, ahead of `companiesDir`. */
    pushedDir: string;
    image: string;
    /** Turns at once on the whole machine, every company together. */
    maxParallel: number;
    turnTimeout: number;
    failuresToBlock: number;
    reconcileMinutes: number;
    memory?: string;
    network?: string;
    /** The release of the runner (its images), baked in its image. */
    version: string;
    /** The registry of the images of the runner: only these are listed, pulled and removed. */
    registry: string;
    /** The images of the other services of the runner it manages too (its memory): repositories without a tag. */
    imageServices: string[];
    /** The file with the admin token of the runner (written by the studio); none: no admin routes. */
    adminTokenFile: string;
    /** The folder of the host where the backups of the memory go (BACKUP_DIR): a path of the machine, not of the container. */
    backupDir: string;
    /** The design sessions: the images of the design agents, one per kit (none: no design agent on this runner), how many at once on the machine, when they pause and go. */
    design: { images: string[]; maxSessions: number; idleMinutes: number; keepDays: number; memory?: string; network?: string };
}

export interface CompanyConfig {
    id: string;
    appId: string;
    privateKey: string;
    installationId?: number;
    webhookSecret?: string;
    /** The token the studio of the company sends to read its `/state`, `/events` and `/output`. */
    studioToken?: string;
    /** Turns at once of this company. */
    maxParallel: number;
    agentEnv: Record<string, string>;
}

export class ConfigError extends Error {}

type Vars = Record<string, string | undefined>;

const positive = (vars: Vars, name: string, fallback: number) => {
    const value = vars[name] === undefined || vars[name] === '' ? fallback : Number(vars[name]);
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`${name} must be a whole number of at least 1`);
    return value;
};

/** A .env file: KEY=value lines, comments and blank lines skipped, quotes around a value removed. */
export function parseEnvFile(text: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match || line.trim().startsWith('#')) continue;
        vars[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return vars;
}

export function readMachineConfig(env: Vars = process.env): MachineConfig {
    return {
        port: positive(env, 'PORT', 8080),
        dataDir: env.DATA_DIR || '/data',
        companiesDir: env.ORGANIZATIONS_DIR || '/organizations',
        pushedDir: `${env.DATA_DIR || '/data'}/organizations`,
        image: env.AGENT_IMAGE || 'ghcr.io/sherpadvisorylab/playbook-agent:1.19.3',
        maxParallel: positive(env, 'MAX_PARALLEL', 2),
        turnTimeout: positive(env, 'TURN_TIMEOUT', 3600),
        failuresToBlock: positive(env, 'FAILURES_TO_BLOCK', 2),
        reconcileMinutes: positive(env, 'RECONCILE_MINUTES', 10),
        memory: env.AGENT_MEMORY || undefined,
        network: env.AGENT_NETWORK || undefined,
        version: env.PLAYBOOK_RUNNER_VERSION || 'dev',
        registry: (env.IMAGE_REGISTRY || 'ghcr.io/sherpadvisorylab').replace(/\/+$/, ''),
        imageServices: (env.IMAGE_SERVICES ?? 'supermemory/supermemory').split(/[\s,]+/).filter(Boolean),
        adminTokenFile: env.ADMIN_TOKEN_FILE || '/admin/token',
        backupDir: (env.BACKUP_DIR || '/opt/playbook/backups').replace(/\/+$/, ''),
        design: {
            // The design agents of the runner, one image per kit (DESIGN_IMAGES, space or comma
            // separated; DESIGN_IMAGE for one, as before). None: no design sessions here.
            images: [...new Set(`${env.DESIGN_IMAGES ?? ''} ${env.DESIGN_IMAGE ?? ''}`.split(/[\s,]+/).filter(Boolean))],
            maxSessions: positive(env, 'DESIGN_MAX_SESSIONS', 2),
            idleMinutes: positive(env, 'DESIGN_IDLE_MINUTES', 30),
            keepDays: positive(env, 'DESIGN_KEEP_DAYS', 7),
            memory: env.DESIGN_MEMORY || undefined,
            // By default the network of the dispatcher container, found at start.
            network: env.DESIGN_NETWORK || undefined,
        },
    };
}

/** The settings of one company, from its own variables. */
export function readCompanyConfig(id: string, vars: Vars, readFile = (path: string) => readFileSync(path, 'utf8')): CompanyConfig {
    if (!COMPANY_ID_PATTERN.test(id)) throw new ConfigError(`${id}: not a company id`);
    const appId = vars.GITHUB_APP_ID?.trim();
    if (!appId) throw new ConfigError(`${id}: GITHUB_APP_ID is missing`);
    const privateKey = (vars.GITHUB_APP_PRIVATE_KEY_FILE ? readFile(vars.GITHUB_APP_PRIVATE_KEY_FILE) : vars.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
    if (!privateKey.includes('PRIVATE KEY')) throw new ConfigError(`${id}: GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE) is missing or not a PEM key`);
    const names = [...DEFAULT_AGENT_ENV, ...(vars.AGENT_ENV ?? '').split(',').map((name) => name.trim()).filter(Boolean)];
    return {
        id,
        appId,
        privateKey,
        installationId: vars.GITHUB_INSTALLATION_ID ? positive(vars, 'GITHUB_INSTALLATION_ID', 0) : undefined,
        webhookSecret: vars.GITHUB_WEBHOOK_SECRET || undefined,
        studioToken: vars.DISPATCHER_TOKEN || undefined,
        maxParallel: positive(vars, 'MAX_PARALLEL', 1),
        agentEnv: Object.fromEntries(names.filter((name) => vars[name]).map((name) => [name, vars[name]!])),
    };
}

/**
 * A dispatcher started the old way, with one company in its own environment: that company, named by
 * COMPANY_ID, served at the root as before and under its path as the others.
 */
export function readLegacyCompany(env: Vars = process.env): CompanyConfig | null {
    if (!env.GITHUB_APP_ID) return null;
    return readCompanyConfig(env.COMPANY_ID || 'default', env);
}
