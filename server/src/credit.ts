import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJson } from './accounts.ts';

// The accounts of a tenant out of credit (`provider#account`), until when: shared by its chats and answers, kept in
// a file so that a restart does not try them again before their reset.

export class Credit {
    private until: Record<string, number>;
    private readonly file: string;
    private readonly now: () => number;

    constructor(file: string, now = () => Date.now()) {
        this.file = file;
        this.now = now;
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        let saved: Record<string, number> = {};
        try {
            if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
        } catch {
            // Broken: started empty.
        }
        this.until = saved;
    }

    exhausted = (key: string): boolean => (this.until[key] ?? 0) > this.now();

    /** When an account out of credit may have some again; none when it has credit. */
    resetOf = (key: string): number | undefined => (this.exhausted(key) ? this.until[key] : undefined);

    spent = (key: string, until: number): void => {
        const now = this.now();
        this.until = Object.fromEntries(Object.entries(this.until).filter(([, at]) => at > now));
        this.until[key] = until;
        writeJson(this.file, this.until);
    };
}
