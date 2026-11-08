#!/usr/bin/env node
// A turn run by Claude Code (`claude -p --output-format stream-json --verbose`): its events, one JSON per
// line on stdin, kept as they are for usage.mjs (CLAUDE_STREAM_FILE) and written as lines a person reads
// for the log of the turn and the chat of its CR, as opencode writes its own: the text of the agent, each
// tool it runs with what it runs, and the end. Never stops on a line it does not understand.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const CLAUDE_STREAM_FILE = '/tmp/claude-turn.jsonl';

const clip = (text, max) => {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** What a tool call does, in one line: the command, the file, the pattern, else its input. */
function toolLine(name, input = {}) {
    const what = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input);
    return `⚙ ${name} ${clip(what, 300)}`;
}

/** The lines a person reads for one event of Claude Code; none for the events of no interest. */
export function readableLines(event) {
    if (!event || typeof event !== 'object') return [];
    if (event.type === 'system' && event.subtype === 'init') return [`Claude Code ${event.claude_code_version ?? ''} · ${event.model ?? ''}`.trim()];
    if (event.type === 'assistant') {
        return (event.message?.content ?? []).flatMap((part) => {
            if (part.type === 'text' && part.text?.trim()) return part.text.trim().split('\n');
            if (part.type === 'tool_use') return [toolLine(part.name, part.input)];
            return [];
        });
    }
    if (event.type === 'user') {
        return (event.message?.content ?? []).flatMap((part) => (part.type === 'tool_result' && part.is_error ? [`✗ ${clip(typeof part.content === 'string' ? part.content : JSON.stringify(part.content), 300)}`] : []));
    }
    if (event.type === 'result') return [`${event.is_error ? '✗ failed' : `✓ ${event.subtype ?? 'done'}`} · ${event.num_turns ?? 0} steps`];
    return [];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const file = process.env.CLAUDE_STREAM_FILE || CLAUDE_STREAM_FILE;
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', (line) => {
        // Each event with the moment it came: the timing of the turn (usage.mjs) reads where the time went.
        let kept = line;
        try {
            const event = JSON.parse(line);
            if (event && typeof event === 'object') kept = JSON.stringify({ ...event, _at: Date.now() });
        } catch {
            // Not an event: kept as it is.
        }
        try {
            appendFileSync(file, `${kept}\n`);
        } catch {
            // The usage only: the turn goes on.
        }
        try {
            for (const out of readableLines(JSON.parse(line))) console.log(out);
        } catch {
            if (line.trim()) console.log(line);
        }
    });
}
