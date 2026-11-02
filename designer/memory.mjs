#!/usr/bin/env node
// The memory of the company in a design session, read only: the spaces (tags) the person chose when
// starting it, nothing else, and no way to write. The dispatcher gives the connection (PLAYBOOK_MEMORY,
// JSON: url, apiKey) and the spaces (PLAYBOOK_MEMORY_TAGS, a JSON list) only when spaces were chosen.
//   playbook-memory search "<query>" [limit] [--knowledge]   the best passages of every space
//   playbook-memory list <tag> [page]                          the documents of a space, 25 a page
//   playbook-memory read <tag> <id>                            one document whole
//   playbook-memory mcp                                        the same as MCP tools (stdio), for opencode
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PAGE = 25;

/** The connection and the spaces of this session; none when the person chose no space. */
export function settings(env = process.env) {
    let tags = [];
    try {
        tags = JSON.parse(env.PLAYBOOK_MEMORY_TAGS || '[]');
    } catch {
        tags = [];
    }
    tags = [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean))];
    let connection = {};
    try {
        connection = JSON.parse(env.PLAYBOOK_MEMORY || '{}');
    } catch {
        connection = {};
    }
    if (!tags.length || !connection.url || !connection.apiKey) return null;
    return { url: String(connection.url).replace(/\/+$/, ''), apiKey: String(connection.apiKey), tags };
}

const NONE = 'No memory was chosen for this session: there is nothing to read. Work from the repository and the person.';

/** A tag as a namespace of supermemory v5, which takes letters, digits, _ : and - only (a dot becomes -). */
const ns = (tag) => '/ns/' + encodeURIComponent(tag.replace(/[^a-zA-Z0-9_:-]/g, '-'));

async function call(memory, method, path, body) {
    const response = await fetch(memory.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + memory.apiKey, 'x-api-key': memory.apiKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('The memory answered ' + response.status);
    return response.json();
}

/** Only the spaces of the session: any other is refused, so nothing outside them is read. */
function own(memory, tag) {
    const wanted = String(tag || '').trim();
    if (!memory.tags.includes(wanted)) throw new Error('"' + wanted + '" is not a space of this session; these are: ' + memory.tags.join(', ') + '.');
    return wanted;
}

/** What a document is, from its metadata: knowledge (and its status) or a note. */
function label(meta = {}) {
    if (meta.playbook !== 'knowledge') return '[note]';
    return '[' + meta.kind + (meta.status === 'in_force' ? ', in force' : ', ' + meta.status) + ']';
}

/** The best passages of every space, each document once; knowledge: the knowledge in force only. */
export async function search(memory, query, limit = 10, knowledge = false) {
    const filter = knowledge ? { operator: 'and', operands: [{ field: 'playbook', operator: 'eq', value: 'knowledge' }, { field: 'status', operator: 'eq', value: 'in_force' }] } : undefined;
    const answers = await Promise.all(memory.tags.map(async (tag) => ({
        tag,
        answer: await call(memory, 'POST', ns(tag) + '/search', { query, limit: Math.min(100, limit * 3), include: { documents: true }, ...(filter ? { filter } : {}) }),
    })));
    const documents = new Map();
    answers
        .flatMap(({ tag, answer }) => ((answer && answer.results) || []).map((item) => ({ tag, item })))
        .sort((left, right) => (right.item.similarity || 0) - (left.item.similarity || 0))
        .forEach(({ tag, item }) => {
            const document = (item.included && item.included.document) || {};
            const id = document.id || item.id;
            const text = item.memory || item.chunk || '';
            const found = documents.get(id);
            if (found) found.content += text && !found.content.includes(text) ? ' ' + text : '';
            else documents.set(id, { id, tag, title: document.title || 'Untitled', content: text, metadata: { ...document.metadata, ...item.metadata } });
        });
    const items = [...documents.values()].slice(0, limit);
    if (!items.length) return 'Nothing in the memory about this.';
    return items.map((item) => '- ' + label(item.metadata) + ' ' + item.title + ' (' + item.tag + ', id ' + item.id + '): ' + item.content.replace(/\s+/g, ' ').slice(0, 600)).join('\n');
}

/** The documents of a space, a page at a time, newest first: their title, id and date. */
export async function list(memory, tag, page = 1) {
    const space = own(memory, tag);
    const answer = await call(memory, 'POST', ns(space) + '/list/documents?page=' + Math.max(1, page) + '&limit=' + PAGE, {});
    const documents = (answer && answer.documents) || [];
    const pages = (answer && answer.pagination && answer.pagination.totalPages) || 1;
    const total = (answer && answer.pagination && answer.pagination.totalItems) || documents.length;
    if (!documents.length) return 'No documents in ' + space + (page > 1 ? ' on page ' + page : '') + '.';
    return [
        space + ': ' + total + ' documents, page ' + page + ' of ' + pages + '.',
        ...documents.map((document) => '- ' + label(document.metadata) + ' ' + (document.title || 'Untitled') + ' (id ' + document.id + ', ' + String((document.system && document.system.updatedAt) || '').slice(0, 10) + ')'),
    ].join('\n');
}

/** One document of a space, whole. */
export async function read(memory, tag, id) {
    const space = own(memory, tag);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(id || ''))) throw new Error('The id of a document is letters, digits, _ and -.');
    const document = await call(memory, 'GET', ns(space) + '/document/' + encodeURIComponent(String(id)));
    const meta = document.metadata || {};
    return [
        label(meta) + ' ' + (document.title || 'Untitled'),
        'Space ' + space + ', id ' + document.id + ', updated ' + String((document.system && document.system.updatedAt) || '').slice(0, 10) + (meta.source ? ', source ' + meta.source : ''),
        '',
        String(document.content || ''),
    ].join('\n');
}

const tools = [
    {
        name: 'memory_search',
        description: 'Search the memory of the company, read only, in the spaces the person chose for this session: decisions, notes and the knowledge of the projects. knowledge: true keeps the knowledge in force only. What you find is a claim to check against the code, never the truth by itself.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, knowledge: { type: 'boolean' } }, required: ['query'] },
    },
    {
        name: 'memory_list',
        description: 'List the documents of one space of this session, 25 a page, newest first: to go through all its notes.',
        inputSchema: { type: 'object', properties: { tag: { type: 'string' }, page: { type: 'number' } }, required: ['tag'] },
    },
    {
        name: 'memory_read',
        description: 'Read one document of a space of this session, whole, by its id (from memory_list or memory_search).',
        inputSchema: { type: 'object', properties: { tag: { type: 'string' }, id: { type: 'string' } }, required: ['tag', 'id'] },
    },
];

/** What a tool answers, as text: an error is told, never thrown at the agent. */
export async function answer(memory, name, args = {}) {
    if (!memory) return NONE;
    try {
        if (name === 'memory_search') return await search(memory, String(args.query || ''), Number(args.limit) || 10, args.knowledge === true);
        if (name === 'memory_list') return await list(memory, args.tag, Number(args.page) || 1);
        if (name === 'memory_read') return await read(memory, args.tag, args.id);
        return 'No such tool: ' + name + '.';
    } catch (error) {
        return error.message;
    }
}

function serve(memory) {
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
    createInterface({ input: process.stdin }).on('line', async (line) => {
        let request;
        try {
            request = JSON.parse(line);
        } catch {
            return;
        }
        const { id, method, params } = request;
        if (id === undefined) return;
        const reply = (result) => send({ jsonrpc: '2.0', id, result });
        if (method === 'initialize') return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'playbook-memory', version: '1.0.0' } });
        if (method === 'ping') return reply({});
        if (method === 'tools/list') return reply({ tools });
        if (method === 'tools/call') return reply({ content: [{ type: 'text', text: await answer(memory, params && params.name, (params && params.arguments) || {}) }] });
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const memory = settings();
    const [command, ...args] = process.argv.slice(2);
    if (command === 'mcp') serve(memory);
    else {
        const name = { search: 'memory_search', list: 'memory_list', read: 'memory_read' }[command];
        const input = command === 'search'
            ? { query: args.filter((arg) => !arg.startsWith('--'))[0], limit: Number(args.filter((arg) => !arg.startsWith('--'))[1]) || 10, knowledge: args.includes('--knowledge') }
            : command === 'list' ? { tag: args[0], page: Number(args[1]) || 1 } : { tag: args[0], id: args[1] };
        if (!name || (command === 'search' && !input.query) || (command !== 'search' && !input.tag)) {
            console.log('Usage: playbook-memory search "<query>" [limit] [--knowledge] | list <tag> [page] | read <tag> <id> | mcp');
            process.exitCode = 1;
        } else console.log(await answer(memory, name, input));
    }
}
