#!/usr/bin/env node
// What the turn cost, read from opencode before the container goes: its one session (each turn runs in
// a new container), exported as JSON, its replies summed. Printed as one line the dispatcher reads:
//   [playbook-agent] usage {"model":"opencode/deepseek-v4.1-flash","input":…,"output":…,"reasoning":…,"cacheRead":…,"cacheWrite":…,"cost":…,"replies":…}
// Never fails the turn: without a session or an export, it prints nothing.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const opencode = (args) => execFileSync('opencode', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });

/** The requests the command of the workflow made to GitHub in this turn: one number per run, summed. */
export function githubRequestsOf(text) {
    return String(text ?? '').split(/\r?\n/).reduce((total, line) => total + (Number.parseInt(line, 10) || 0), 0);
}

/** The JSON a command printed, from its first bracket (a line of its own may come before it). */
export function jsonOf(text) {
    const start = text.search(/[[{]/);
    return start < 0 ? null : JSON.parse(text.slice(start));
}

/** The usage of the replies of an exported session: tokens and cost summed, the model of the last reply. */
export function usageOf(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const usage = { model: '', input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, replies: 0 };
    for (const message of messages) {
        const info = message?.info ?? message;
        if (info?.role !== 'assistant') continue;
        usage.replies += 1;
        usage.input += info.tokens?.input ?? 0;
        usage.output += info.tokens?.output ?? 0;
        usage.reasoning += info.tokens?.reasoning ?? 0;
        usage.cacheRead += info.tokens?.cache?.read ?? 0;
        usage.cacheWrite += info.tokens?.cache?.write ?? 0;
        usage.cost += info.cost ?? 0;
        if (info.modelID) usage.model = info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
    }
    usage.cost = Math.round(usage.cost * 1e6) / 1e6;
    return usage.replies ? usage : null;
}

/**
 * The export of a session, through a file: written to a pipe, opencode stops at 64 KB and the JSON of a
 * long turn comes cut (only short sessions read whole).
 */
function exported(id) {
    const file = join(mkdtempSync(join(tmpdir(), 'playbook-usage-')), 'session.json');
    const out = openSync(file, 'w');
    try {
        execFileSync('opencode', ['export', id], { stdio: ['ignore', out, 'ignore'], timeout: 60_000 });
    } finally {
        closeSync(out);
    }
    return readFileSync(file, 'utf8');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    try {
        const sessions = jsonOf(opencode(['session', 'list', '--max-count', '1', '--format', 'json']));
        const id = (Array.isArray(sessions) ? sessions[0] : sessions)?.id;
        const usage = id ? usageOf(jsonOf(exported(id))) : null;
        // The requests of the command of the workflow (.playbook/playbook.mjs), from the repository of the turn.
        let github = 0;
        try {
            github = githubRequestsOf(readFileSync('.playbook/out/github-requests.log', 'utf8'));
        } catch {
            // None made, or another command.
        }
        if (usage) console.log(`[playbook-agent] usage ${JSON.stringify(github ? { ...usage, github } : usage)}`);
    } catch {
        // No usage: the turn is what counts.
    }
}
