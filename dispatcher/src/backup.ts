import { run as runCommand, type RunCommand } from './images.ts';

// The backup of the memory of the runner (supermemory, a Coolify resource of its own on the same
// machine), made before an update: its container found by the label Coolify gives it, stopped (so its
// database is still and whole), then its /data volume put in a .tgz on the host by a throwaway
// container. It is never started again here: the deploy that follows starts the new version. Only the
// person who manages the machine asks for it, with the admin token of the runner.

/** The label of the container of the memory, as Coolify names the service of its compose. */
export const MEMORY_LABEL = 'coolify.service.subName=supermemory';

export interface MemoryBackup {
    /** Stops the memory and saves its data; the file on the host and its size. */
    backup(): Promise<{ file: string; bytes: number }>;
}

export class BackupError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/** `supermemory-2026-10-28-1405.tgz`: the date and time of the backup, as the guide names it. */
export const backupName = (at: Date) => `supermemory-${at.toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.tgz`;

const lastLine = (output: string) => output.trim().split('\n').pop() ?? '';

export function memoryBackup(options: {
    /** The folder of the host for the backups (the throwaway container mounts it). */
    dir: string;
    /** The image of the throwaway container: one with sh, tar and stat. */
    image: string;
    docker?: string;
    run?: RunCommand;
    now?: () => Date;
}): MemoryBackup {
    const docker = options.docker ?? 'docker';
    const run = options.run ?? runCommand;
    const now = options.now ?? (() => new Date());
    let running = false;
    return {
        async backup() {
            // Two at once would stop and copy the same data twice.
            if (running) throw new BackupError('a backup is running', 409);
            running = true;
            try {
                const listed = await run(docker, ['ps', '-aq', '--filter', `label=${MEMORY_LABEL}`]);
                if (listed.code !== 0) throw new BackupError(`docker ps failed: ${lastLine(listed.output)}`, 502);
                const container = listed.output.split('\n').map((line) => line.trim()).find((line) => /^[0-9a-f]{12,64}$/.test(line));
                if (!container) throw new BackupError('no memory on this machine', 404);
                const inspected = await run(docker, ['inspect', container, '--format', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}']);
                const volume = inspected.code === 0 ? inspected.output.trim() : '';
                if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume)) throw new BackupError('the memory has no data volume', 404);
                const stopped = await run(docker, ['stop', container]);
                if (stopped.code !== 0) throw new BackupError(`docker stop failed: ${lastLine(stopped.output)}`, 502);
                const file = backupName(now());
                const saved = await run(docker, [
                    'run', '--rm', '--entrypoint', 'sh',
                    '-v', `${volume}:/data:ro`, '-v', `${options.dir}:/backup`,
                    options.image, '-c', `tar czf /backup/${file} -C /data . && stat -c %s /backup/${file}`,
                ]);
                const bytes = Number(lastLine(saved.output));
                if (saved.code !== 0 || !Number.isInteger(bytes)) throw new BackupError(`backup failed: ${lastLine(saved.output)}`, 502);
                return { file: `${options.dir}/${file}`, bytes };
            } finally {
                running = false;
            }
        },
    };
}
