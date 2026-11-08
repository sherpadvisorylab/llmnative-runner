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

/** The kind of work a tool call is, from its name and its command: what the timing of a turn sums. */
export function toolKind(name, input = {}) {
    const command = String(input.command ?? '');
    if (/^(WebSearch|WebFetch)$/.test(name)) return 'web';
    if (/memory_search/.test(name) || /memory\.mjs\s+search/.test(command)) return 'memoryRead';
    if (/memory_propose/.test(name) || /memory\.mjs\s+propose/.test(command)) return 'memoryWrite';
    if (/^(Read|Grep|Glob|NotebookRead)$/.test(name)) return 'read';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'write';
    if (/^(Monitor|TaskOutput|BashOutput)$/.test(name)) return 'waiting';
    if (name !== 'Bash') return 'other';
    if (/playbook\.mjs\s+verify\b/.test(command)) return 'verify';
    if (/playbook\.mjs\s+mutate\b/.test(command)) return 'mutate';
    if (/playbook\.mjs\s+\w/.test(command)) return 'workflow';
    if (/\b(npm|pnpm|yarn)\s+(ci|install|i)\b/.test(command)) return 'install';
    if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|node\s+--test|emulators:exec|vitest|jest|mocha/.test(command)) return 'tests';
    if (/^\s*(sleep|until|while)\b|tail\s+--pid/.test(command)) return 'waiting';
    if (/\bgit\s+(commit|push)\b/.test(command)) return 'write';
    if (/\bgit\s+(show|diff|log|grep|ls-files|fetch|status)\b|^\s*(cat|sed|head|tail|grep|ls|find|wc)\b/.test(command)) return 'read';
    return 'other';
}

/**
 * Where the time of a turn run by Claude Code went, from its events stamped by claude-stream.mjs: the setup of
 * the container (start to the agent), the tools by kind (count and seconds, from a call to its result) and the
 * model (the rest: thinking and writing). Null when the events have no moments.
 */
export function timingOf(text, startedMs, agentMs) {
    const events = String(text ?? '').split(/\r?\n/).flatMap((line) => {
        try {
            const event = line.trim() ? JSON.parse(line) : null;
            return event && typeof event._at === 'number' ? [event] : [];
        } catch {
            return [];
        }
    });
    if (!events.length) return null;
    const calls = new Map();
    const intervals = [];
    const tools = {};
    for (const event of events) {
        for (const part of event.message?.content ?? []) {
            if (event.type === 'assistant' && part.type === 'tool_use') calls.set(part.id, { kind: toolKind(part.name, part.input), at: event._at });
            if (event.type === 'user' && part.type === 'tool_result' && calls.has(part.tool_use_id)) {
                const call = calls.get(part.tool_use_id);
                calls.delete(part.tool_use_id);
                const seconds = Math.max(0, (event._at - call.at) / 1000);
                const sum = tools[call.kind] ?? [0, 0];
                tools[call.kind] = [sum[0] + 1, Math.round((sum[1] + seconds) * 10) / 10];
                intervals.push([call.at, event._at]);
            }
        }
    }
    // The tools may run side by side: their time is the union of their spans, the model has the rest.
    intervals.sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let end = -Infinity;
    for (const [from, to] of intervals) {
        if (from > end) {
            busy += to - from;
            end = to;
        } else if (to > end) {
            busy += to - end;
            end = to;
        }
    }
    const first = events[0]._at;
    const last = events.at(-1)._at;
    const round = (ms) => Math.round(ms / 100) / 10;
    const setup = Number(agentMs) > 0 && Number(startedMs) > 0 ? round(Number(agentMs) - Number(startedMs)) : undefined;
    return { ...(setup !== undefined ? { setup } : {}), model: round(Math.max(0, last - first - busy)), tools };
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
            const stream = readFileSync(process.env.CLAUDE_STREAM_FILE || '/tmp/claude-turn.jsonl', 'utf8');
            usage = claudeUsageOf(stream);
            const timing = usage ? timingOf(stream, process.env.PLAYBOOK_STARTED_MS, process.env.PLAYBOOK_AGENT_MS) : null;
            if (timing) usage = { ...usage, timing };
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
