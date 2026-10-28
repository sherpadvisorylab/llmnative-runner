import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

// The images of the runner on its machine: which are there, which it uses, pulling a new version and
// removing an old one. Only the person who manages the machine does this, with the admin token of the
// runner (a file on the machine, written by the studio: never a company token). Only images of the
// registry of the runner (IMAGE_REGISTRY, ghcr.io/sherpadvisorylab by default) are touched, and the
// images of the other services of the runner (IMAGE_SERVICES: supermemory/supermemory, its memory).

export interface MachineImage {
    /** repository:tag, or repository@id for an image left without a tag (an older version pulled over). */
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
    /**
     * The containers made from it, running or stopped: Docker keeps the image while one is there. A
     * design session names its own (`design`: its id, `company`), so the page can say which one.
     */
    containers?: Array<{ name: string; state: string; design?: string; company?: string }>;
}

/** The design session of a container, from its name: `playbook-design-<company>-<id>`. */
export function designOfContainer(name: string): { company: string; design: string } | undefined {
    const match = /^playbook-design-([a-z0-9][a-z0-9-]*)-([a-f0-9]{8})$/.exec(name);
    return match ? { company: match[1], design: match[2] } : undefined;
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

/**
 * An image of the registry, by repository and tag (`ghcr.io/sherpadvisorylab/playbook-agent:0.11.0`)
 * or, left without a tag, by repository and id (`…/playbook-designer@01ce418d87d9`).
 */
export function imagePattern(registry: string, services: readonly string[] = []): RegExp {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repositories = [`${escape(registry)}/playbook-[a-z0-9-]+`, ...services.map(escape)].join('|');
    return new RegExp(`^(${repositories})(:[A-Za-z0-9._-]{1,64}|@[0-9a-f]{12,64})$`);
}

/** Whether a repository is one the runner manages: of its registry, or of one of its services. */
const managed = (repository: string, registry: string, services: readonly string[]) => repository.startsWith(`${registry}/playbook-`) || services.includes(repository);

/** Runs a command of the machine (the docker CLI), its output kept: what the tests replace with a fake. */
export type RunCommand = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

export const run: RunCommand = (command, args) => new Promise((resolve) => {
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
export function dockerImages(options: { registry: string; services?: readonly string[]; inUse: () => Promise<string[]>; docker?: string }): ImageHost {
    const command = options.docker ?? 'docker';
    const services = options.services ?? [];
    const ours = (repository: string) => managed(repository, options.registry, services);
    return {
        async list() {
            const listed = await run(command, ['image', 'ls', '--format', '{{json .}}']);
            if (listed.code !== 0) throw new ImageError(`docker image ls failed: ${listed.output.trim().split('\n').pop()}`, 502);
            const used = new Set(await options.inUse());
            const found = new Map<string, MachineImage>();
            // The containers of the machine, by the image they were made from (its name, or its id once untagged).
            const containers: Array<{ image: string; name: string; state: string }> = [];
            const ps = await run(command, ['ps', '-a', '--format', '{{json .}}']);
            for (const line of ps.code === 0 ? ps.output.split('\n') : []) {
                try {
                    const container = JSON.parse(line) as { Image: string; Names: string; State: string };
                    containers.push({ image: container.Image, name: container.Names, state: container.State });
                } catch {
                    // Not a line of the list.
                }
            }
            const holders = (ref: string, id: string) => containers
                .filter((container) => container.image === ref || (id && id.startsWith(container.image)) || (id && container.image.startsWith(id)))
                .map(({ name, state }) => ({ name, state, ...designOfContainer(name) }));
            for (const line of listed.output.split('\n')) {
                try {
                    const image = JSON.parse(line) as { Repository: string; Tag: string; ID: string; Size: string; CreatedAt: string };
                    if (!ours(image.Repository)) continue;
                    // An image left without a tag (a new version pulled over it) is known by its id.
                    const ref = image.Tag === '<none>' ? `${image.Repository}@${image.ID}` : `${image.Repository}:${image.Tag}`;
                    const held = holders(ref, image.ID);
                    found.set(ref, { ref, repository: image.Repository, tag: image.Tag, present: true, inUse: used.has(ref), id: image.ID, size: image.Size, created: image.CreatedAt, ...(held.length ? { containers: held } : {}) });
                } catch {
                    // Not a line of the list.
                }
            }
            for (const ref of used) {
                if (found.has(ref) || !ours(ref.slice(0, ref.lastIndexOf(':')))) continue;
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
            // An image without a tag goes by its id, and only one that is listed as such.
            let target = ref;
            if (ref.includes('@')) {
                const listed = await this.list();
                if (!listed.some((image) => image.ref === ref && image.tag === '<none>')) throw new ImageError('not found', 404);
                target = ref.slice(ref.indexOf('@') + 1);
            }
            const removed = await run(command, ['rmi', target]);
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
