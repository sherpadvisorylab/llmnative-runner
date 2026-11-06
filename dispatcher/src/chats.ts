import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { GitHubApi } from './github.ts';
import { CLAUDE_CODE, candidateEnv, connectedAccounts, type Candidate } from './providers.ts';

// The chats of the studio with a harness on the server (docs/playbook-model.md §8.7): Agentico talks to Claude
// Code (with the subscription of the organization) or to opencode (with its keys) running here, next to the
// repository of a project, read only. One container per chat, the repository cloned once; each message runs
// the harness in it, continuing the conversation of the one before, and its reply goes to the studio as it
// comes: text, the tools it uses, its end. The tools of the studio reach the harness as an MCP server in the
// container (runner/agent/studio-mcp.mjs): each call comes here with the token of the chat, goes to the studio
// as an event of the reply (the person approves what needs it, the studio runs it) and its answer goes back.

export const CHAT_LABEL = 'playbook.chat';
/** A chat no one wrote to for this long is closed (its container removed). */
export const CHAT_IDLE_MS = 30 * 60_000;
export const CHAT_ID = /^[a-f0-9]{8}$/;
const MESSAGE_MAX = 20_000;

/** What a chat says to the studio as it answers, one JSON line each. */
export type ChatEvent =
    | { type: 'text'; text: string }
    | { type: 'step'; id: string; label: string; status: 'running' | 'done' }
    | { type: 'done' }
    | { type: 'error'; message: string }
    | { type: 'tool-call'; id: string; name: string; input: Record<string, unknown> };

/** A tool of the studio the harness may call (the MCP Tool format). */
export type ChatTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** How long a call of a tool waits for the studio (the approval of the person included). */
export const TOOL_CALL_TIMEOUT_MS = 14 * 60_000;
const MCP_SCRIPT = '/usr/local/lib/playbook/studio-mcp.mjs';

/** Where a chat runs: the provider of the organization and the model its engine is given. */
export type ChatModel = { provider: string; model: string; variant?: string; name?: string };

export interface ChatHost {
    /** Starts the container of a chat, idle until a message; on the network of the dispatcher, when it has one. */
    start(name: string, image: string, owner: string): Promise<void>;
    /** Runs a command in it with these variables; its output as it comes. */
    exec(name: string, command: string, env: Record<string, string>, onOutput: (chunk: string) => void): Promise<number>;
    remove(name: string): Promise<void>;
}

/** The containers of the chats, through the Docker socket; the values of the variables never on a command line. */
export function dockerChatHost(command = 'docker', network?: string): ChatHost {
    const run = (args: string[], env: Record<string, string> = {}, onOutput?: (chunk: string) => void) => new Promise<number>((resolve) => {
        const child = spawn(command, args, { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code ?? 1));
    });
    return {
        async start(name, image, owner) {
            const code = await run(['run', '-d', '--name', name, '--label', `${CHAT_LABEL}=${owner}`, ...(network ? ['--network', network] : []), '--entrypoint', 'sleep', image, 'infinity']);
            if (code !== 0) throw new Error('the container of the chat did not start');
        },
        exec: (name, script, env, onOutput) => run(['exec', ...Object.keys(env).flatMap((key) => ['-e', key]), name, 'bash', '-lc', script], env, onOutput),
        async remove(name) {
            await run(['rm', '-f', name]);
        },
    };
}

/** The repository cloned in the container, with a token that reads it and is never written down. */
const CLONE = `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=\${GITHUB_TOKEN}"; }; f'
git clone --quiet --depth 50 "https://github.com/\${GITHUB_REPOSITORY}.git" /work/repo && git config --global --unset credential.helper`;

/**
 * The harness, on the message in PLAYBOOK_PROMPT; read only: no tool that writes or runs commands. With the
 * tools of the studio, its MCP server: for Claude Code a file written from PLAYBOOK_MCP (the token of the chat
 * never on a command line), for opencode its configuration in OPENCODE_CONFIG_CONTENT.
 */
export function chatScript(engine: 'claude-code' | 'opencode', continued: boolean, tools = false): string {
    if (engine === 'claude-code') {
        // The subscription, never an API key; the prompt from stdin (the list of tools would take it).
        const mcp = tools ? `umask 077 && printf '%s' "$PLAYBOOK_MCP" > /tmp/studio-mcp.json && ` : '';
        const allow = tools ? ' --mcp-config /tmp/studio-mcp.json --allowedTools mcp__studio' : '';
        return `cd /work/repo && ${mcp}printf '%s' "$PLAYBOOK_PROMPT" | env -u ANTHROPIC_API_KEY -u PLAYBOOK_MCP DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose --include-partial-messages --model "$PLAYBOOK_MODEL"${continued ? ' --continue' : ''}${allow} --disallowedTools Edit Write NotebookEdit Bash`;
    }
    return `cd /work/repo && opencode run --model "$PLAYBOOK_MODEL"\${PLAYBOOK_VARIANT:+ --variant "$PLAYBOOK_VARIANT"}${continued ? ' --continue' : ''} "$PLAYBOOK_PROMPT"`;
}

/** The variables of a message that give the harness its permissions and, with tools, the MCP server of the studio. */
export function chatConfig(engine: 'claude-code' | 'opencode', tools: { list: ChatTool[]; url: string; token: string } | undefined): Record<string, string> {
    const environment = tools ? { PLAYBOOK_TOOLS: JSON.stringify(tools.list), PLAYBOOK_TOOLS_URL: tools.url, PLAYBOOK_TOOLS_TOKEN: tools.token } : undefined;
    if (engine === 'claude-code') {
        return environment ? { PLAYBOOK_MCP: JSON.stringify({ mcpServers: { studio: { command: 'node', args: [MCP_SCRIPT], env: environment } } }) } : {};
    }
    return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: { edit: 'deny', bash: 'deny' },
            ...(environment ? { mcp: { studio: { type: 'local', command: ['node', MCP_SCRIPT], environment } } } : {}),
        }),
    };
}

/** The colours and moves of a terminal, out of a text. */
const ESCAPES = /\u001b\][^\u0007]*\u0007|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[@-_]|\r/g;

/** What a tool did, in a few words: its name and what it was given. */
const toolLabel = (name: string, input: Record<string, unknown> | undefined) => {
    const detail = input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? '';
    return `${name}${detail ? ` ${String(detail)}` : ''}`.slice(0, 200);
};

/**
 * Reads the output of a harness as events for the studio: the stream-json of Claude Code (its text as it is
 * written, its tools, its end), or the text of opencode as it comes.
 */
export function chatReader(engine: 'claude-code' | 'opencode', emit: (event: ChatEvent) => void) {
    let buffer = '';
    let ended = false;
    let wrote = false;
    const line = (raw: string) => {
        if (engine !== 'claude-code') {
            const text = raw.replace(ESCAPES, '');
            if (text.trim() && !/^\s*>\s*(build|plan)\b/.test(text)) {
                emit({ type: 'text', text: `${text}\n` });
                wrote = true;
            }
            return;
        }
        let event: Record<string, any>;
        try {
            event = JSON.parse(raw);
        } catch {
            return;
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
            emit({ type: 'text', text: String(event.event.delta.text ?? '') });
            wrote = true;
        } else if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
                if (block.type === 'tool_use') emit({ type: 'step', id: String(block.id), label: toolLabel(String(block.name), block.input), status: 'running' });
            }
        } else if (event.type === 'user') {
            for (const block of event.message?.content ?? []) {
                if (block.type === 'tool_result') emit({ type: 'step', id: String(block.tool_use_id), label: '', status: 'done' });
            }
        } else if (event.type === 'result') {
            ended = true;
            // A reply that is an error (a limit of the subscription, a refused model): said as one.
            if (event.is_error) emit({ type: 'error', message: String(event.result ?? event.subtype ?? 'error').slice(0, 500) });
            else {
                if (!wrote && typeof event.result === 'string') emit({ type: 'text', text: event.result });
                emit({ type: 'done' });
            }
        }
    };
    return {
        push(chunk: string) {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const raw of lines) line(raw);
        },
        /** The end of the output: what is left read, and an end said if the harness did not say one. */
        end(code: number, tail: string) {
            if (buffer) line(buffer);
            buffer = '';
            if (ended) return;
            if (code === 0) emit({ type: 'done' });
            else emit({ type: 'error', message: (tail.replace(ESCAPES, '').trim().split('\n').slice(-3).join(' ') || `exit ${code}`).replace(/sk-ant\S*|[A-Za-z0-9_\-]{32,}/g, '***').slice(0, 500) });
        },
    };
}

type Chat = {
    id: string;
    name: string;
    repository: string;
    container: string;
    messages: number;
    busy: boolean;
    lastActive: number;
    /** The tools of the studio for it, and the token its MCP server calls back with. */
    tools: ChatTool[];
    token: string;
    /** Where the events of the message being answered go; none between messages. */
    emit?: (event: ChatEvent) => void;
    /** The calls of tools waiting for the studio. */
    calls: Map<string, (answer: { result?: unknown; isError?: boolean }) => void>;
};

export type ChatDeps = {
    company: string;
    owner: string;
    image: string;
    host: ChatHost;
    github: Pick<GitHubApi, 'turnToken'>;
    /** The keys of the turns and the accounts of each provider, as the dispatcher has them now. */
    keys: () => { env: Record<string, string>; accounts: Record<string, Array<{ id: string; label?: string }>> };
    log: (line: string, details?: Record<string, unknown>) => void;
    now?: () => number;
    /** Where the MCP server of a chat calls the dispatcher back, from the container; none: no tools. */
    toolsUrl?: (chatId: string) => string;
};

/** The tools of the studio as it gives them: a few, named plainly, small. */
const toolsOf = (value: unknown): ChatTool[] => {
    if (!Array.isArray(value) || value.length > 40 || JSON.stringify(value).length > 100_000) return [];
    return value.flatMap((tool) => {
        const entry = tool as Partial<ChatTool>;
        return typeof entry?.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(entry.name) && typeof entry.description === 'string' && entry.inputSchema && typeof entry.inputSchema === 'object'
            ? [{ name: entry.name, description: entry.description.slice(0, 2000), inputSchema: entry.inputSchema }]
            : [];
    });
};

export class ChatError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export class ServerChats {
    private readonly chats = new Map<string, Chat>();
    private readonly deps: ChatDeps;
    private readonly now: () => number;

    constructor(deps: ChatDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }

    /** A chat of the repository: its container started and the repository cloned there (read only). */
    async start(id: string, repository: string, tools?: unknown): Promise<{ id: string }> {
        if (!CHAT_ID.test(id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new ChatError('invalid', 400);
        if (this.chats.has(id)) return { id };
        const container = `playbook-chat-${this.deps.company}-${id}`;
        await this.deps.host.start(container, this.deps.image, this.deps.owner);
        const token = await this.deps.github.turnToken(repository, { metadata: 'read', contents: 'read' });
        let output = '';
        const code = await this.deps.host.exec(container, CLONE, { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository }, (chunk) => { output += chunk; });
        if (code !== 0) {
            await this.deps.host.remove(container);
            this.deps.log('chat could not clone', { chat: id, repository, output: output.slice(-300) });
            throw new ChatError('clone', 502);
        }
        this.chats.set(id, { id, name: id, repository, container, messages: 0, busy: false, lastActive: this.now(), tools: this.deps.toolsUrl ? toolsOf(tools) : [], token: randomBytes(24).toString('hex'), calls: new Map() });
        this.deps.log('chat started', { chat: id, repository });
        return { id };
    }

    has(id: string, repository: string): boolean {
        return this.chats.get(id)?.repository === repository;
    }

    /** A message of the person, answered by the harness of `model` in the chat; its events as they come. */
    async send(id: string, text: string, model: ChatModel, emit: (event: ChatEvent) => void): Promise<void> {
        const chat = this.chats.get(id);
        if (!chat) throw new ChatError('no-chat', 404);
        if (chat.busy) throw new ChatError('busy', 409);
        if (!text.trim() || text.length > MESSAGE_MAX) throw new ChatError('invalid', 400);
        const { env, accounts } = this.deps.keys();
        const account = connectedAccounts(env, accounts)[model.provider]?.[0];
        if (!account) throw new ChatError('no-provider', 409);
        const engine = model.provider === CLAUDE_CODE ? 'claude-code' : 'opencode';
        const candidate: Candidate = { provider: model.provider, model: model.model, ...(model.variant ? { variant: model.variant } : {}), name: model.name ?? model.model, account };
        const keys = candidateEnv(candidate, undefined, env);
        chat.busy = true;
        chat.emit = emit;
        chat.lastActive = this.now();
        let tail = '';
        const reader = chatReader(engine, emit);
        const tools = chat.tools.length && this.deps.toolsUrl ? { list: chat.tools, url: this.deps.toolsUrl(chat.id), token: chat.token } : undefined;
        try {
            const code = await this.deps.host.exec(chat.container, chatScript(engine, chat.messages > 0, !!tools), { ...keys, ...chatConfig(engine, tools), PLAYBOOK_PROMPT: text }, (chunk) => {
                tail = (tail + chunk).slice(-4000);
                reader.push(chunk);
            });
            reader.end(code, tail);
            chat.messages += 1;
        } finally {
            chat.busy = false;
            chat.emit = undefined;
            // The calls still waiting end with the message.
            for (const answer of chat.calls.values()) answer({ result: 'The message ended before the studio answered.', isError: true });
            chat.calls.clear();
            chat.lastActive = this.now();
        }
    }

    /**
     * A call of a tool of the studio by the harness of a chat (its MCP server, with the token of the chat): sent
     * to the studio with the reply being written, answered when the studio says what it gave.
     */
    async callTool(id: string, token: string, name: string, input: Record<string, unknown>): Promise<{ result?: unknown; isError?: boolean }> {
        const chat = this.chats.get(id);
        const expected = Buffer.from(chat?.token ?? '');
        const given = Buffer.from(token);
        if (!chat || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ChatError('bad token', 401);
        if (!chat.tools.some((tool) => tool.name === name)) throw new ChatError('unknown tool', 404);
        if (!chat.emit) throw new ChatError('no message', 409);
        const callId = randomBytes(6).toString('hex');
        const answered = new Promise<{ result?: unknown; isError?: boolean }>((resolve) => {
            const timer = setTimeout(() => {
                chat.calls.delete(callId);
                resolve({ result: 'The studio did not answer in time.', isError: true });
            }, TOOL_CALL_TIMEOUT_MS);
            chat.calls.set(callId, (answer) => {
                clearTimeout(timer);
                chat.calls.delete(callId);
                resolve(answer);
            });
        });
        chat.lastActive = this.now();
        chat.emit({ type: 'tool-call', id: callId, name, input });
        this.deps.log('chat tool called', { chat: id, tool: name });
        return answered;
    }

    /** What the studio gave for a call of a tool; false when no call waits with that id. */
    answerTool(id: string, callId: string, answer: { result?: unknown; isError?: boolean }): boolean {
        const resolve = this.chats.get(id)?.calls.get(callId);
        if (!resolve) return false;
        resolve(answer);
        return true;
    }

    async close(id: string): Promise<boolean> {
        const chat = this.chats.get(id);
        if (!chat) return false;
        this.chats.delete(id);
        await this.deps.host.remove(chat.container);
        this.deps.log('chat closed', { chat: id });
        return true;
    }

    /** Closes the chats no one wrote to for a while. */
    async sweep(): Promise<void> {
        for (const chat of [...this.chats.values()]) {
            if (!chat.busy && this.now() - chat.lastActive > CHAT_IDLE_MS) await this.close(chat.id);
        }
    }
}
