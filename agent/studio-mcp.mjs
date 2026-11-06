#!/usr/bin/env node
// The tools of the studio for a harness on the server (docs/playbook-model.md §8.7): a Model Context Protocol
// server on stdio, started by Claude Code or opencode in the container of a chat. It lists the tools the studio
// gave the chat (PLAYBOOK_TOOLS) and sends each call to the dispatcher (PLAYBOOK_TOOLS_URL, with the token of the
// chat), which passes it to the studio: the person approves there what needs it, the studio runs it and its
// answer comes back here. Nothing of the studio runs in the container.
import { createInterface } from 'node:readline';

const tools = (() => {
    try {
        return JSON.parse(process.env.PLAYBOOK_TOOLS ?? '[]');
    } catch {
        return [];
    }
})();
const url = process.env.PLAYBOOK_TOOLS_URL ?? '';
const token = process.env.PLAYBOOK_TOOLS_TOKEN ?? '';
/** A call waits for the person (an approval) as long as this. */
const CALL_TIMEOUT_MS = 15 * 60_000;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

async function call(name, args) {
    if (!tools.some((tool) => tool.name === name)) return { ...text(`No tool ${name}.`), isError: true };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-chat-token': token },
            body: JSON.stringify({ name, input: args ?? {} }),
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const answer = await response.json().catch(() => ({}));
        if (!response.ok) return { ...text(answer.error ?? `The studio did not answer (${response.status}).`), isError: true };
        return { ...text(answer.result ?? null), ...(answer.isError ? { isError: true } : {}) };
    } catch (error) {
        return { ...text(`The studio did not answer: ${error.message}`), isError: true };
    }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    const { id, method, params } = message;
    // A notification: nothing to answer.
    if (id === undefined) return;
    if (method === 'initialize') {
        send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio', version: '1.0.0' } } });
    } else if (method === 'tools/list') {
        send({ id, result: { tools } });
    } else if (method === 'tools/call') {
        send({ id, result: await call(params?.name, params?.arguments) });
    } else if (method === 'ping') {
        send({ id, result: {} });
    } else {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
});
