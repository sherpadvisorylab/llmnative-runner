import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanLines } from './output.ts';
import type { TurnLog, KeptTurn } from './dispatcher.ts';

// What each turn of an issue printed, kept a while after it ends: one file per turn (its agent, when it
// started, how long, how it ended, its lines as a person reads them, secrets masked), so the studio shows
// what every agent did on a CR, also once it is closed. The whole text of every turn goes on to the log
// of the issue as before, for whoever reads the machine.

/** A turn kept, without its lines. */
export type TurnSummary = KeptTurn & { id: string; lineCount: number; cut: boolean };

/** Lines of a turn kept (its last ones), and how long a line may be. */
const MAX_LINES = 5000;
const MAX_LINE = 2000;
const DAY = 86_400_000;

const safe = (key: string) => key.replace(/[^A-Za-z0-9_.-]/g, '-');

export function fileTurnLogs(dir: string, mask: (text: string) => string, options: { keepDays?: number; now?: () => number } = {}): TurnLog {
    const keepDays = options.keepDays ?? 30;
    const now = options.now ?? Date.now;
    const turnsOf = (key: string) => join(dir, 'turns', safe(key));

    /** The turns of an issue older than the days kept go. */
    const sweep = (folder: string) => {
        try {
            for (const name of readdirSync(folder)) {
                const path = join(folder, name);
                if (now() - statSync(path).mtimeMs > keepDays * DAY) rmSync(path, { force: true });
            }
        } catch {
            // No turn kept yet.
        }
    };
    const readTurn = (path: string): (TurnSummary & { lines: string[] }) | null => {
        try {
            return JSON.parse(readFileSync(path, 'utf8')) as TurnSummary & { lines: string[] };
        } catch {
            return null;
        }
    };

    return {
        write(key, text, turn) {
            const masked = mask(text);
            appendFileSync(join(dir, 'logs', `${safe(key)}.log`), `\n===== ${new Date(now()).toISOString()}\n${masked}\n`);
            if (!turn) return;
            const { lines, partial } = cleanLines('', masked);
            const all = [...lines, ...(partial.trim() ? [partial] : [])].map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line));
            const kept = all.slice(-MAX_LINES);
            const id = `${turn.startedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${safe(turn.agent)}`;
            const folder = turnsOf(key);
            mkdirSync(folder, { recursive: true });
            writeFileSync(join(folder, `${id}.json`), JSON.stringify({ id, ...turn, lineCount: all.length, cut: all.length > kept.length, lines: kept }));
            sweep(folder);
        },
        list(key) {
            const folder = turnsOf(key);
            let names: string[] = [];
            try {
                names = readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
            } catch {
                return [];
            }
            return names.flatMap((name) => {
                const turn = readTurn(join(folder, name));
                if (!turn || now() - Date.parse(turn.startedAt) > keepDays * DAY) return [];
                const { lines: _lines, ...summary } = turn;
                return [summary];
            });
        },
        read(key, id) {
            if (!/^[0-9]{1,14}-[A-Za-z0-9_.-]{1,80}$/.test(id)) return null;
            return readTurn(join(turnsOf(key), `${id}.json`));
        },
    };
}
