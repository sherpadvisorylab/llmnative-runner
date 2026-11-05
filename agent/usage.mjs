#!/usr/bin/env node
// What the turn cost, read from opencode before the container goes: its one session (each turn runs in
// a new container), exported as JSON, its replies summed. Printed as one line the dispatcher reads:
//   [playbook-agent] usage {"model":"opencode/deepseek-v4.1-flash","input":…,"output":…,"reasoning":…,"cacheRead":…,"cacheWrite":…,"cost":…,"replies":…,"contextStart":…,"contextEnd":…}
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
    // The context of the turn: what the model read for its first reply (the prompt, the instructions) and
    // for its last (all the turn read and did on top), each new, written to the cache and read from it.
    let contextStart = 0;
    let contextEnd = 0;
    for (const message of messages) {
        const info = message?.info ?? message;
        if (info?.role !== 'assistant') continue;
        const context = (info.tokens?.input ?? 0) + (info.tokens?.cache?.read ?? 0) + (info.tokens?.cache?.write ?? 0);
        if (context > 0) {
            if (!contextStart) contextStart = context;
            contextEnd = context;
        }
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
    if (contextStart) Object.assign(usage, { contextStart, contextEnd });
    return usage.replies ? usage : null;
}

/**
 * The usage of a turn run by Claude Code, from its stream-json events (claude-stream.mjs keeps them):
 * the result says the cost, the steps and the tokens; the context is what the model read for its first
 * reply and for its last, as for opencode. Null without a result.
 */
export function claudeUsageOf(text) {
    const events = String(text ?? '').split(/\r?\n/).flatMap((line) => {
        try {
            return line.trim() ? [JSON.parse(line)] : [];
        } catch {
            return [];
        }
    });
    const result = events.filter((event) => event.type === 'result').at(-1);
    if (!result) return null;
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
    const contexts = events
        .filter((event) => event.type === 'assistant' && event.message?.usage)
        .map(({ message: { usage } }) => (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0))
        .filter((context) => context > 0);
    const usage = result.usage ?? {};
    const model = Object.keys(result.modelUsage ?? {})[0] ?? init?.model ?? '';
    return {
        model: model ? `claude-code/${model}` : 'claude-code',
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        reasoning: 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        // What the turn would cost at the prices of the API: with the subscription it is not billed.
        cost: Math.round((result.total_cost_usd ?? 0) * 1e6) / 1e6,
        replies: result.num_turns ?? 0,
        ...(contexts.length ? { contextStart: contexts[0], contextEnd: contexts.at(-1) } : {}),
    };
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
        // Run by Claude Code: its events; else the last session of opencode.
        let usage = null;
        if (process.env.PLAYBOOK_ENGINE === 'claude-code') {
            usage = claudeUsageOf(readFileSync(process.env.CLAUDE_STREAM_FILE || '/tmp/claude-turn.jsonl', 'utf8'));
        } else {
            const sessions = jsonOf(opencode(['session', 'list', '--max-count', '1', '--format', 'json']));
            const id = (Array.isArray(sessions) ? sessions[0] : sessions)?.id;
            usage = id ? usageOf(jsonOf(exported(id))) : null;
        }
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
