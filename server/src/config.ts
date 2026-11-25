// The settings of the runner, from the environment of its container. Everything else (tenants, keys, accounts)
// is data the runner keeps itself, under DATA_DIR.

export interface RunnerConfig {
    port: number;
    dataDir: string;
    /** The image of the harnesses: one container of it per chat and per answer. */
    agentImage: string;
    /** The release of the runner, baked in its image. */
    version: string;
    /** Its public address (https://runner.example.com), for what it tells clients. */
    publicUrl?: string;
    /** Chats open at once per tenant, and on the whole runner. */
    maxChatsPerTenant: number;
    maxChats: number;
    /** Answers at once per tenant. */
    maxCompletionsPerTenant: number;
    /** Memory and cores of each container of a harness; none: no limit. */
    agentMemory?: string;
    agentCpus?: number;
    /** The Docker network the containers of the harnesses join (found at start when not given). */
    network?: string;
    /** Where the console is (the built web app); none: no console. */
    consoleDir?: string;
}

export class ConfigError extends Error {}

type Vars = Record<string, string | undefined>;

const positive = (vars: Vars, name: string, fallback: number) => {
    const value = vars[name] === undefined || vars[name] === '' ? fallback : Number(vars[name]);
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`${name} must be a whole number of at least 1`);
    return value;
};

export function readConfig(env: Vars = process.env): RunnerConfig {
    const version = env.RUNNER_VERSION || 'dev';
    return {
        port: positive(env, 'PORT', 8080),
        dataDir: (env.DATA_DIR || '/data').replace(/\/+$/, ''),
        agentImage: env.AGENT_IMAGE || `ghcr.io/sherpadvisorylab/llmnative-runner-agent:${version === 'dev' ? 'latest' : version}`,
        version,
        ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL.replace(/\/+$/, '') } : {}),
        maxChatsPerTenant: positive(env, 'MAX_CHATS_PER_TENANT', 6),
        maxChats: positive(env, 'MAX_CHATS', 6),
        maxCompletionsPerTenant: positive(env, 'MAX_COMPLETIONS_PER_TENANT', 2),
        ...(env.AGENT_MEMORY ? { agentMemory: env.AGENT_MEMORY } : {}),
        ...(Number(env.AGENT_CPUS) > 0 ? { agentCpus: Number(env.AGENT_CPUS) } : {}),
        ...(env.AGENT_NETWORK ? { network: env.AGENT_NETWORK } : {}),
        ...(env.CONSOLE_DIR !== '' ? { consoleDir: env.CONSOLE_DIR || '/app/console' } : {}),
    };
}
