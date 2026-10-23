import { readFileSync } from 'node:fs';

// The settings of the dispatcher, from the environment (see runner/.env.example).

/** The variables handed to every turn when set: the keys of the model providers and the memory. */
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

export interface Config {
    port: number;
    dataDir: string;
    appId: string;
    privateKey: string;
    installationId?: number;
    webhookSecret?: string;
    /** The token the studio of the company sends to read `/state` and `/events`. */
    studioToken?: string;
    image: string;
    maxParallel: number;
    turnTimeout: number;
    failuresToBlock: number;
    reconcileMinutes: number;
    memory?: string;
    network?: string;
    agentEnv: Record<string, string>;
}

export class ConfigError extends Error {}

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`${name} must be a whole number of at least 1`);
    return value;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env, readFile = (path: string) => readFileSync(path, 'utf8')): Config {
    const appId = env.GITHUB_APP_ID?.trim();
    if (!appId) throw new ConfigError('GITHUB_APP_ID is missing');
    const privateKey = (env.GITHUB_APP_PRIVATE_KEY_FILE ? readFile(env.GITHUB_APP_PRIVATE_KEY_FILE) : env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
    if (!privateKey.includes('PRIVATE KEY')) throw new ConfigError('GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE) is missing or not a PEM key');
    const names = [...DEFAULT_AGENT_ENV, ...(env.AGENT_ENV ?? '').split(',').map((name) => name.trim()).filter(Boolean)];
    const agentEnv = Object.fromEntries(names.filter((name) => env[name]).map((name) => [name, env[name]!]));
    return {
        port: positive(env, 'PORT', 8080),
        dataDir: env.DATA_DIR || '/data',
        appId,
        privateKey,
        installationId: env.GITHUB_INSTALLATION_ID ? positive(env, 'GITHUB_INSTALLATION_ID', 0) : undefined,
        webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
        studioToken: env.DISPATCHER_TOKEN || undefined,
        image: env.AGENT_IMAGE || 'ghcr.io/sherpadvisorylab/playbook-agent:1.19.3',
        maxParallel: positive(env, 'MAX_PARALLEL', 1),
        turnTimeout: positive(env, 'TURN_TIMEOUT', 3600),
        failuresToBlock: positive(env, 'FAILURES_TO_BLOCK', 2),
        reconcileMinutes: positive(env, 'RECONCILE_MINUTES', 10),
        memory: env.AGENT_MEMORY || undefined,
        network: env.AGENT_NETWORK || undefined,
        agentEnv,
    };
}
