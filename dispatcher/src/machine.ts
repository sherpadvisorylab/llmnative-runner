import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';

// What the machine has, for the studio that suggests the limits of the turns: its memory (all of it,
// and what the system and the services running leave free) and its cores. The dispatcher runs without
// a memory limit of its own, so it sees the memory of the host.

export interface Machine {
    totalBytes: number;
    availableBytes: number;
    cpus: number;
}

/** "MemAvailable" of /proc/meminfo, in bytes: what can be taken without swapping; null when it is not there. */
export function availableOf(meminfo: string): number | null {
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
    return match ? Number(match[1]) * 1024 : null;
}

export async function readMachine(read = () => readFile('/proc/meminfo', 'utf8')): Promise<Machine> {
    const available = await read().then(availableOf).catch(() => null);
    return { totalBytes: totalmem(), availableBytes: available ?? freemem(), cpus: cpus().length };
}
