#!/usr/bin/env node
// The tools of the client for a harness on the runner (the chats of the runner): a Model Context Protocol
// server on stdio, started by Claude Code or opencode in the container of a chat. It lists the tools the client
// gave the chat (RUNNER_TOOLS) and sends each call to the runner (RUNNER_TOOLS_URL, with the token of the
// chat), which passes it to the client: the person approves there what needs it, the client runs it and its
// answer comes back here. Nothing of the client runs in the container.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';

const tools = (() => {
    try {
        return JSON.parse(process.env.RUNNER_TOOLS ?? '[]');
    } catch {
        return [];
    }
})();
const url = process.env.RUNNER_TOOLS_URL ?? '';
const token = process.env.RUNNER_TOOLS_TOKEN ?? '';
/** A call waits for the person (an approval) as long as this. */
const CALL_TIMEOUT_MS = 15 * 60_000;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

/**
 * One POST that may wait as long as CALL_TIMEOUT_MS for its answer. Not fetch: its client gives up on an answer
 * whose headers take more than 5 minutes ("fetch failed"), and an approval of the person can take longer.
 */
function post(target, body) {
    return new Promise((resolve, reject) => {
        const address = new URL(target);
        const request = (address.protocol === 'https:' ? httpsRequest : httpRequest)(address, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-chat-token': token },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', reject);
        });
        request.setTimeout(CALL_TIMEOUT_MS, () => request.destroy(new Error('timed out')));
        request.on('error', reject);
        request.end(body);
    });
}

async function call(name, args) {
    if (!tools.some((tool) => tool.name === name)) return { ...text(`No tool ${name}.`), isError: true };
    try {
        const response = await post(url, JSON.stringify({ name, input: args ?? {} }));
        let answer = {};
        try {
            answer = JSON.parse(response.text);
        } catch {
            // Not JSON: said by its status below.
        }
        if (response.status < 200 || response.status >= 300) return { ...text(answer.error ?? `The client did not answer (${response.status}).`), isError: true };
        return { ...text(answer.result ?? null), ...(answer.isError ? { isError: true } : {}) };
    } catch (error) {
        return { ...text(`The client did not answer: ${error.message}`), isError: true };
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
        send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tools', version: '1.0.0' } } });
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
