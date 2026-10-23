import { spawn } from 'node:child_process';

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

export function dockerRunner(options: DockerOptions): { runTurn: RunTurn; cleanUp(): Promise<void> } {
    const command = options.docker ?? 'docker';
    return {
        async runTurn(spec) {
            const args = [
                'run', '--rm', '--name', spec.name, '--label', `${TURN_LABEL}=${options.owner}`,
                ...(options.memory ? ['--memory', options.memory] : []),
                ...(options.network ? ['--network', options.network] : []),
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
        async cleanUp() {
            const listed = await docker(command, ['ps', '-aq', '--filter', `label=${TURN_LABEL}=${options.owner}`]);
            const ids = listed.output.split(/\s+/).filter(Boolean);
            if (listed.code === 0 && ids.length) await docker(command, ['rm', '-f', ...ids]);
        },
    };
}
