import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesignFile, DesignHost } from './designs.ts';

// One turn is one container of the agent image, run next to the dispatcher through the Docker socket.
// Values go through the environment of the docker command (`-e NAME`), never on its command line.

export interface TurnSpec {
    /** The container name: one turn per issue at a time. */
    name: string;
    env: Record<string, string>;
    /** Seconds; the agent stops itself at PLAYBOOK_TIMEOUT, this is the hard stop a bit later. */
    timeout: number;
    /** Each piece of output, as it comes. */
    onOutput?: (chunk: string) => void;
}

export interface TurnResult {
    code: number;
    /** The end of what the turn printed. */
    output: string;
}

export type RunTurn = (spec: TurnSpec) => Promise<TurnResult>;

export const TURN_LABEL = 'playbook.turn';
const KEEP_OUTPUT = 200_000;

export interface DockerOptions {
    image: string;
    /** `--memory` of each turn, e.g. 4g. */
    memory?: string;
    /** `--cpus` of each turn, e.g. 2.5. */
    cpus?: number;
    /** `--network` of each turn. */
    network?: string;
    docker?: string;
    /**
     * Whose turns these are (the App of the company): several dispatchers can share a machine, and a
     * dispatcher that starts again only clears its own.
     */
    owner: string;
}

function docker(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, onOutput?: (chunk: string) => void): Promise<TurnResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const keep = (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            output = (output + text).slice(-KEEP_OUTPUT);
            onOutput?.(text);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (error) => resolve({ code: 127, output: `${output}\n${error.message}` }));
        child.on('close', (code) => resolve({ code: code ?? 1, output }));
    });
}

/** A size of `docker stats` ("1.2GiB", "512MiB", "900kB") in bytes. */
export function bytesOf(text: string): number {
    const match = /^([\d.]+)\s*([kKMGT]?i?B)$/.exec(text.trim());
    if (!match) return 0;
    const units: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3, TB: 1e12, TiB: 1024 ** 4 };
    return Math.round(Number(match[1]) * (units[match[2]] ?? 1));
}

/** What containers take now, by name: CPU in percent of one core, memory and its limit. */
export async function containerStats(names: string[], command = 'docker'): Promise<Record<string, { cpu: number; memory: number; limit: number }>> {
    if (!names.length) return {};
    const result = await docker(command, ['stats', '--no-stream', '--format', '{{json .}}', ...names]);
    const stats: Record<string, { cpu: number; memory: number; limit: number }> = {};
    for (const line of result.output.split('\n')) {
        try {
            const row = JSON.parse(line) as { Name?: string; CPUPerc?: string; MemUsage?: string };
            if (!row.Name) continue;
            const [used = '', limit = ''] = (row.MemUsage ?? '').split('/');
            stats[row.Name] = { cpu: Number.parseFloat(row.CPUPerc ?? '0') || 0, memory: bytesOf(used), limit: bytesOf(limit) };
        } catch {
            // Not a line of stats.
        }
    }
    return stats;
}

/** The volume of the npm cache of an organization: its owner as a name docker takes. */
export const npmCacheVolume = (owner: string) => `playbook-npm-${owner.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}`;

export function dockerRunner(options: DockerOptions): { runTurn: RunTurn; cleanUp(): Promise<void> } {
    const command = options.docker ?? 'docker';
    return {
        async runTurn(spec) {
            const args = [
                'run', '--rm', '--name', spec.name, '--label', `${TURN_LABEL}=${options.owner}`,
                ...(options.memory ? ['--memory', options.memory] : []),
                ...(options.cpus ? ['--cpus', String(options.cpus)] : []),
                ...(options.network ? ['--network', options.network] : []),
                // The packages npm downloaded in the turns before, kept for the next: an install takes seconds,
                // not minutes. One volume per organization (its App): what one downloads, another never reads.
                '-v', `${npmCacheVolume(options.owner)}:/home/agent/.npm`,
                ...Object.keys(spec.env).flatMap((name) => ['-e', name]),
                options.image,
            ];
            const env = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...spec.env };
            const stop = setTimeout(() => void docker(command, ['kill', spec.name]), (spec.timeout + 120) * 1000);
            try {
                return await docker(command, args, env, spec.onOutput);
            } finally {
                clearTimeout(stop);
            }
        },
        /** Turns left running by a dispatcher that stopped: they are started again by the reconciliation. */
        // (Design sessions carry another label and survive a restart: see designHost.)
        async cleanUp() {
            const listed = await docker(command, ['ps', '-aq', '--filter', `label=${TURN_LABEL}=${options.owner}`]);
            const ids = listed.output.split(/\s+/).filter(Boolean);
            if (listed.code === 0 && ids.length) await docker(command, ['rm', '-f', ...ids]);
        },
    };
}

export const DESIGN_LABEL = 'playbook.design';

export interface DesignHostOptions {
    owner: string;
    memory?: string;
    /**
     * The network the dispatcher is on: the session joins it and answers at http://<name>:4096. Without
     * one (a dispatcher outside Docker) its port is published on 127.0.0.1 only.
     */
    network?: string;
    docker?: string;
}

/** The containers of the design sessions: started detached, stopped when idle, removed at the end. */
export function designHost(options: DesignHostOptions): DesignHost {
    const command = options.docker ?? 'docker';
    const base = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST };
    const must = async (args: string[], env: NodeJS.ProcessEnv = base) => {
        const result = await docker(command, args, env);
        if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.output.trim().split('\n').pop()}`);
        return result.output;
    };
    const address = async (name: string) => {
        if (options.network) return `http://${name}:4096`;
        const port = (await must(['port', name, '4096/tcp'])).trim().split('\n')[0];
        return `http://${port.replace('0.0.0.0', '127.0.0.1')}`;
    };
    return {
        async start(spec) {
            const settings = [
                '--name', spec.name, '--label', `${DESIGN_LABEL}=${options.owner}`,
                ...(options.memory ? ['--memory', options.memory] : []),
                ...(options.network ? ['--network', options.network] : ['-p', '127.0.0.1::4096']),
                ...Object.keys(spec.env).flatMap((name) => ['-e', name]),
                spec.image,
            ];
            if (!spec.inputs?.length) {
                await must(['run', '-d', ...settings], { ...base, ...spec.env });
                return address(spec.name);
            }
            // The files the person gave go in before it runs: created, given its files, then started.
            await must(['create', ...settings], { ...base, ...spec.env });
            const folder = await mkdtemp(join(tmpdir(), 'design-inputs-'));
            try {
                await chmod(folder, 0o755);
                for (const input of spec.inputs) await writeFile(join(folder, input.name), input.content, { mode: 0o644 });
                await must(['cp', `${folder}/.`, `${spec.name}:/work/inputs`]);
            } finally {
                await rm(folder, { recursive: true, force: true });
            }
            await must(['start', spec.name]);
            return address(spec.name);
        },
        async wake(name) {
            await must(['start', name]);
            return address(name);
        },
        async pause(name) {
            await must(['stop', '-t', '20', name]);
        },
        async remove(name) {
            await must(['rm', '-f', name]);
        },
        async logs(name) {
            return (await docker(command, ['logs', '--tail', '30', name], base)).output;
        },
        async files(name) {
            const output = await must(['exec', name, 'playbook-design-files']);
            return (JSON.parse(output.slice(output.indexOf('{'))) as { files: DesignFile[] }).files;
        },
    };
}

/** The kit of a design image, from its labels (`playbook.design.*`): who asks the questions, with which skills. */
export type DesignKit = { image: string; kit: string; name: string; command: string; skills: string[]; source: string; commit: string; opencode: string };

/** Reads the kit of the design image, pulling it the first time; undefined when it cannot be read. */
export async function designKit(image: string, command = 'docker'): Promise<DesignKit | undefined> {
    const inspect = () => docker(command, ['image', 'inspect', '--format', '{{json .Config.Labels}}', image]);
    let result = await inspect();
    if (result.code !== 0) {
        await docker(command, ['pull', '-q', image]);
        result = await inspect();
    }
    if (result.code !== 0) return undefined;
    try {
        const labels = JSON.parse(result.output.trim().split('\n').pop() ?? '{}') as Record<string, string>;
        const label = (name: string) => labels[`playbook.design.${name}`] ?? '';
        return {
            image,
            kit: label('kit') || 'unknown',
            name: label('name'),
            command: label('command') || 'grill-with-docs',
            skills: label('skills').split(/\s+/).filter(Boolean).map((skill) => skill.split('/').pop() ?? skill),
            source: label('source'),
            commit: label('commit'),
            opencode: label('opencode'),
        };
    } catch {
        return undefined;
    }
}

/** The network of the container the dispatcher runs in, if it runs in one: the sessions join it. */
export async function ownNetwork(hostname: string, command = 'docker'): Promise<string | undefined> {
    const result = await docker(command, ['inspect', '--format', '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}', hostname]);
    return result.code === 0 ? result.output.split('\n').map((line) => line.trim()).find(Boolean) : undefined;
}
