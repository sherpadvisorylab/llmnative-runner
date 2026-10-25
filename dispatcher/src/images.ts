import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

// The images of the runner on its machine: which are there, which it uses, pulling a new version and
// removing an old one. Only the person who manages the machine does this, with the admin token of the
// runner (a file on the machine, written by the studio: never a company token). Only images of the
// registry of the runner (IMAGE_REGISTRY, ghcr.io/sherpadvisorylab by default) are touched.

export interface MachineImage {
    /** repository:tag */
    ref: string;
    repository: string;
    tag: string;
    /** On the machine; false for an image the runner uses but has not pulled yet. */
    present: boolean;
    /** The runner uses it now: its dispatcher, the agent of the turns, a design agent. */
    inUse: boolean;
    id?: string;
    size?: string;
    created?: string;
}

export interface ImageHost {
    /** The images of the registry on the machine, with those the runner uses. */
    list(): Promise<MachineImage[]>;
    pull(ref: string): Promise<void>;
    remove(ref: string): Promise<void>;
}

export class ImageError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export const DEFAULT_REGISTRY = 'ghcr.io/sherpadvisorylab';

/** An image of the registry, by repository and tag: `ghcr.io/sherpadvisorylab/playbook-agent:0.11.0`. */
export function imagePattern(registry: string): RegExp {
    const escaped = registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}/playbook-[a-z0-9-]+:[A-Za-z0-9._-]{1,64}$`);
}

const run = (command: string, args: string[]) => new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-100_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => resolve({ code: 127, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
});

/**
 * The images of the machine through its Docker: those of the registry, and those the runner uses
 * (`inUse`: the images of its settings and the one its own container runs).
 */
export function dockerImages(options: { registry: string; inUse: () => Promise<string[]>; docker?: string }): ImageHost {
    const command = options.docker ?? 'docker';
    const prefix = `${options.registry}/playbook-`;
    return {
        async list() {
            const listed = await run(command, ['image', 'ls', '--format', '{{json .}}']);
            if (listed.code !== 0) throw new ImageError(`docker image ls failed: ${listed.output.trim().split('\n').pop()}`, 502);
            const used = new Set(await options.inUse());
            const found = new Map<string, MachineImage>();
            for (const line of listed.output.split('\n')) {
                try {
                    const image = JSON.parse(line) as { Repository: string; Tag: string; ID: string; Size: string; CreatedAt: string };
                    if (!image.Repository.startsWith(prefix) || image.Tag === '<none>') continue;
                    const ref = `${image.Repository}:${image.Tag}`;
                    found.set(ref, { ref, repository: image.Repository, tag: image.Tag, present: true, inUse: used.has(ref), id: image.ID, size: image.Size, created: image.CreatedAt });
                } catch {
                    // Not a line of the list.
                }
            }
            for (const ref of used) {
                if (found.has(ref) || !ref.startsWith(prefix)) continue;
                const at = ref.lastIndexOf(':');
                found.set(ref, { ref, repository: ref.slice(0, at), tag: ref.slice(at + 1), present: false, inUse: true });
            }
            return [...found.values()].sort((a, b) => a.ref.localeCompare(b.ref));
        },
        async pull(ref) {
            const pulled = await run(command, ['pull', '-q', ref]);
            if (pulled.code !== 0) throw new ImageError(pulled.output.trim().split('\n').pop() || 'docker pull failed', 502);
        },
        async remove(ref) {
            if ((await options.inUse()).includes(ref)) throw new ImageError('in use', 409);
            const removed = await run(command, ['rmi', ref]);
            // A container still made from it (a paused design session, say) keeps it.
            if (removed.code !== 0) throw new ImageError(removed.output.trim().split('\n').pop() || 'docker rmi failed', 409);
        },
    };
}

/** The image the container of the dispatcher runs, as its compose names it. */
export async function ownImage(hostname: string, command = 'docker'): Promise<string | undefined> {
    const result = await run(command, ['inspect', '--format', '{{.Config.Image}}', hostname]);
    return result.code === 0 ? result.output.trim() || undefined : undefined;
}

/** The admin token of the runner, read at every request (written on the machine without a restart); none: no admin. */
export function adminToken(file: string, read = (path: string) => readFileSync(path, 'utf8')): string | undefined {
    try {
        return read(file).trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Whether a request carries the admin token: `Authorization: Bearer <token>`. */
export function isAdmin(token: string | undefined, authorization: string | undefined): boolean {
    if (!token) return false;
    const given = Buffer.from(String(authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
