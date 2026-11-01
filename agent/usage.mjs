#!/usr/bin/env node
// What the turn cost, read from opencode before the container goes: its one session (each turn runs in
// a new container), exported as JSON, its replies summed. Printed as one line the dispatcher reads:
//   [playbook-agent] usage {"model":"opencode/deepseek-v4.1-flash","input":…,"output":…,"reasoning":…,"cacheRead":…,"cacheWrite":…,"cost":…,"replies":…}
// Never fails the turn: without a session or an export, it prints nothing.
import { execFileSync } from 'node:child_process';

const opencode = (args) => execFileSync('opencode', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });

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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    try {
        const sessions = jsonOf(opencode(['session', 'list', '--max-count', '1', '--format', 'json']));
        const id = (Array.isArray(sessions) ? sessions[0] : sessions)?.id;
        const usage = id ? usageOf(jsonOf(opencode(['export', id]))) : null;
        if (usage) console.log(`[playbook-agent] usage ${JSON.stringify(usage)}`);
    } catch {
        // No usage: the turn is what counts.
    }
}
