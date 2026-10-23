// The output of a turn as a person reads it: no terminal colours or cursor moves, a spinner line
// overwritten in place kept only as it ends, no runs of empty lines.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]/g;

/** Splits text into clean lines; `partial` is what was left of the previous chunk without a newline. */
export function cleanLines(partial: string, chunk: string): { lines: string[]; partial: string } {
    const text = (partial + chunk).replace(ANSI, '');
    const parts = text.split('\n');
    const rest = parts.pop() ?? '';
    const lines = parts
        // A carriage return rewrites the line: what stays is what came after the last one.
        .map((line) => line.split('\r').filter(Boolean).pop() ?? '')
        .map((line) => line.trimEnd())
        .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
    return { lines, partial: rest };
}

/** The last lines of a turn, kept while it runs and a while after. */
export class OutputBuffer {
    private readonly lines: string[] = [];
    private partial = '';
    private readonly limit: number;

    constructor(limit = 300) {
        this.limit = limit;
    }

    /** Adds a chunk of output; returns the new complete lines. */
    add(chunk: string): string[] {
        const { lines, partial } = cleanLines(this.partial, chunk);
        this.partial = partial;
        this.lines.push(...lines);
        if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
        return lines;
    }

    get tail(): string[] {
        return [...this.lines];
    }
}
