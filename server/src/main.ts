import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createRunnerServer } from './api.ts';
import { CHAT_LABEL, dockerChatHost } from './chats.ts';
import { ConfigError, readConfig, type RunnerConfig } from './config.ts';
import { loadModules, startModules } from './modules.ts';
import { Runtime } from './runtime.ts';

// The runner: API v1 and console on PORT, its data under DATA_DIR, one container of AGENT_IMAGE per chat and per
// answer through the Docker socket. See README.md.

const SWEEP_MS = 5 * 60_000;

const log = (line: string, details?: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: line, ...details }));

/** The Docker network of this container: the containers of the harnesses join it to call the tools back. */
function ownNetwork(name: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn('docker', ['inspect', '--format', '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}', name], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        child.on('error', () => resolve(undefined));
        child.on('close', (code) => resolve(code === 0 ? output.split('\n').map((line) => line.trim()).find(Boolean) : undefined));
    });
}

/**
 * The containers of chats and answers left by a runner before this one (an update, a restart): their conversations
 * are gone with it, so they are removed rather than left running for weeks.
 */
function removeLeftovers(): Promise<number> {
    return new Promise((resolve) => {
        const list = spawn('docker', ['ps', '-aq', '--filter', `label=${CHAT_LABEL}`], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        list.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        list.on('error', () => resolve(0));
        list.on('close', () => {
            const ids = output.split(/\s+/).filter(Boolean);
            if (!ids.length) return resolve(0);
            const remove = spawn('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
            remove.on('error', () => resolve(0));
            remove.on('close', () => resolve(ids.length));
        });
    });
}

async function main() {
    let config: RunnerConfig;
    try {
        config = readConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`[runner] ${error.message}`);
            process.exit(64);
        }
        throw error;
    }
    const network = config.network ?? await ownNetwork(hostname());
    const removed = await removeLeftovers();
    if (removed) log('containers of before removed', { count: removed });
    const runtime = new Runtime({
        config,
        host: dockerChatHost('docker', network, { memory: config.agentMemory, cpus: config.agentCpus }),
        log,
        // The containers reach this one by its name on the same network; outside Docker, chats run without tools.
        ...(network ? { toolsBase: `http://${hostname()}:${config.port}` } : {}),
    });
    // The modules of the image (an image FROM llmnative-runner that adds them): each with the runner as it is.
    runtime.modules = await startModules(await loadModules(config.modules, log), () => ({
        config,
        log,
        host: runtime.deps.host,
        tenants: () => runtime.registry.tenants().map((tenant) => tenant.id),
        keysFor: (scope) => runtime.accounts.keysFor(scope),
        credit: (tenant) => (runtime.registry.tenant(tenant) ? runtime.tenant(tenant)?.credit : undefined),
    }), config.dataDir, log);
    const server = createRunnerServer(runtime, { corsOrigins: (process.env.CORS_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean) });
    server.listen(config.port, () => {
        log('runner listening', { version: config.version, port: config.port, agentImage: config.agentImage, network: network ?? 'none', tenants: runtime.registry.tenants().length });
        if (!runtime.registry.keys({ kind: 'platform' }).length) log('no platform connected yet: run `docker compose exec runner node src/cli.ts pair` for a pairing code');
        setInterval(() => void runtime.sweep().catch((error: Error) => log('sweep failed', { error: error.message })), SWEEP_MS).unref();
    });
    const stop = async () => {
        log('stopping');
        server.close();
        for (const module of runtime.modules) await Promise.resolve(module.stop?.()).catch(() => undefined);
        await runtime.stop().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGTERM', () => void stop());
    process.on('SIGINT', () => void stop());
}

void main();
