import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CLAUDE_CODE, accountKey, candidateEnv, connectedAccounts, outOfCredit, type Candidate } from './providers.ts';

// The chats of a client with a harness on the runner: Claude Code or opencode, with the accounts of the person (or
// of the tenant). One container per chat; each message runs the harness in it, continuing the conversation of the
// one before, and its reply goes to the client as it comes: text, reasoning, the tools it uses, its end. The tools
// of the client reach the harness as an MCP server in the container (agent/tools-mcp.mjs): each call comes here
// with the token of the chat, goes to the client as an event of the reply (the person approves what needs it, the
// client runs it) and its answer goes back. The harness itself changes nothing: no tool that writes or runs.

export const CHAT_LABEL = 'llmnative.runner.chat';
/** A chat no one wrote to for this long is closed (its container removed). */
export const CHAT_IDLE_MS = 30 * 60_000;
export const CHAT_ID = /^[a-f0-9]{8}$/;
const MESSAGE_MAX = 20_000;

/** What a chat says to the client as it answers, one JSON line each. */
export type ChatEvent =
    | { type: 'text'; text: string }
    /** The reasoning of the model as it is written. */
    | { type: 'reasoning'; text: string }
    | { type: 'step'; id: string; label: string; status: 'running' | 'done' }
    | { type: 'done' }
    | { type: 'error'; message: string }
    | { type: 'tool-call'; id: string; name: string; input: Record<string, unknown> };

/**
 * A tool of the client the harness may call (the MCP Tool format). `endsTurn`: once the client answered it, the
 * message ends (what the tool gave says it all, e.g. a draft shown as a card).
 */
export type ChatTool = { name: string; description: string; inputSchema: Record<string, unknown>; endsTurn?: boolean };

/** How long a harness may go on after a tool that ends its message, before the message is ended for it. */
export const ENDS_TURN_GRACE_MS = 15_000;
/** How long a call of a tool waits for the client (the approval of the person included). */
export const TOOL_CALL_TIMEOUT_MS = 14 * 60_000;
/**
 * How long a harness may say nothing while it answers, no call of the client waiting: then it is stuck and
 * stopped (Claude Code writes as it reasons and as each tool ends; a call waits for the person on its own).
 */
export const CHAT_SILENCE_MS = 10 * 60_000;
const MCP_SCRIPT = '/usr/local/lib/runner/tools-mcp.mjs';
/** Where the harness of a chat works: an empty folder of its container. */
export const CHAT_WORK_DIR = '/work/chat';

/**
 * The files the person sends with a message (a screenshot, a PDF, a log): at most CHAT_FILES_MAX, each up to
 * CHAT_FILE_MAX_BYTES and all together up to CHAT_FILES_MAX_BYTES, images, PDF, JSON and text only. Written in the
 * container, gone with it.
 */
export const CHAT_FILES_MAX = 5;
export const CHAT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_FILES_MAX_BYTES = 15 * 1024 * 1024;
const CHAT_FILE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|json)|text\/[a-z0-9.+-]{1,40})$/;
export const CHAT_FILES_DIR = '/work/attachments';
export type ChatFile = { name: string; mimeType: string; data: Buffer };

/** The files of a message as the client sends them (name, mimeType, base64): none, the list, or null when one is not allowed. */
export function chatFilesOf(value: unknown): ChatFile[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > CHAT_FILES_MAX) return null;
    let total = 0;
    const names = new Set<string>();
    const files: ChatFile[] = [];
    for (const item of value as Array<Record<string, unknown>>) {
        const mimeType = String(item?.mimeType ?? '').toLowerCase();
        const base64 = String(item?.base64 ?? '');
        if (!CHAT_FILE_TYPES.test(mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
        const data = Buffer.from(base64, 'base64');
        total += data.length;
        if (!data.length || data.length > CHAT_FILE_MAX_BYTES || total > CHAT_FILES_MAX_BYTES) return null;
        // Its own name, made safe for a path; twice the same: numbered.
        const base = (String(item?.name ?? '').split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'file';
        let name = base;
        for (let index = 2; names.has(name); index += 1) name = `${index}-${base}`;
        names.add(name);
        files.push({ name, mimeType, data });
    }
    return files;
}

/** What the harness is told of the files of a message: where they are, to read them with its tools. */
export function chatFilesNote(paths: Array<{ path: string; mimeType: string; bytes: number }>): string {
    if (!paths.length) return '';
    const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
    return [
        '',
        '---',
        'Files the person attached to this message: read each one with your tools before answering (images and PDF too).',
        ...paths.map((file) => `- ${file.path} (${file.mimeType}, ${size(file.bytes)})`),
    ].join('\n');
}

/** Where a chat runs: the provider and the model its harness is given. */
export type ChatModel = { provider: string; model: string; variant?: string; name?: string; effort?: string };

export interface ChatHost {
    /** Starts a container, idle until a message; on the network of the runner, when it has one. */
    start(name: string, image: string, owner: string): Promise<void>;
    /** Runs a command in it with these variables; its output as it comes. */
    exec(name: string, command: string, env: Record<string, string>, onOutput: (chunk: string) => void): Promise<number>;
    /** Stops the harness answering in it (a message stopped by the person, or stuck): its exec then ends. */
    interrupt?(name: string): Promise<void>;
    /** Writes a file in it (the files of a message, a long prompt); its folder made first. */
    write?(name: string, path: string, data: Buffer): Promise<void>;
    remove(name: string): Promise<void>;
}

/** The containers of the chats, through the Docker socket; the values of the variables never on a command line. */
export function dockerChatHost(command = 'docker', network?: string, limits: { memory?: string; cpus?: number } = {}): ChatHost {
    const run = (args: string[], env: Record<string, string> = {}, onOutput?: (chunk: string) => void) => new Promise<number>((resolve) => {
        const child = spawn(command, args, { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code ?? 1));
    });
    return {
        async start(name, image, owner) {
            const code = await run([
                'run', '-d', '--name', name, '--label', `${CHAT_LABEL}=${owner}`,
                ...(network ? ['--network', network] : []),
                ...(limits.memory ? ['--memory', limits.memory] : []),
                ...(limits.cpus ? ['--cpus', String(limits.cpus)] : []),
                '--entrypoint', 'sleep', image, 'infinity',
            ]);
            if (code !== 0) throw new Error('the container did not start');
        },
        exec: (name, script, env, onOutput) => run(['exec', ...Object.keys(env).flatMap((key) => ['-e', key]), name, 'bash', '-lc', script], env, onOutput),
        // The harness and what it started (the MCP server of the tools); the container stays for the next message.
        async interrupt(name) {
            // Every process of the container but its first (sleep infinity). No pkill nor ps in the image: kill -1 is in every shell.
            await run(['exec', name, 'sh', '-c', 'kill -TERM -1 2>/dev/null; sleep 2; kill -KILL -1 2>/dev/null; true']);
        },
        async remove(name) {
            await run(['rm', '-f', name]);
        },
        // Through the standard input of the exec: a file of some MB fits no variable; the path an argument, never code.
        write: (name, path, data) => new Promise<void>((resolve, reject) => {
            const child = spawn(command, ['exec', '-i', name, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path], { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST }, stdio: ['pipe', 'ignore', 'ignore'] });
            child.on('error', reject);
            child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('the file could not be written'))));
            child.stdin.end(data);
        }),
    };
}

/**
 * The harness, on the message in RUNNER_PROMPT; no tool that writes or runs commands. With the tools of the
 * client, its MCP server: for Claude Code a file written from RUNNER_MCP (the token of the chat never on a command
 * line), for opencode its configuration in OPENCODE_CONFIG_CONTENT.
 */
export function chatScript(engine: 'claude-code' | 'opencode', continued: boolean, tools = false): string {
    if (engine === 'claude-code') {
        // The subscription, never an API key; the prompt from stdin (the list of tools would take it).
        const mcp = tools ? `umask 077 && printf '%s' "$RUNNER_MCP" > /tmp/tools-mcp.json && ` : '';
        const allow = tools ? ' --mcp-config /tmp/tools-mcp.json --allowedTools mcp__tools' : '';
        // The files of the messages are outside the folder of the chat: Claude Code reads only where it is let (--add-dir).
        return `mkdir -p ${CHAT_FILES_DIR} ${CHAT_WORK_DIR} && cd ${CHAT_WORK_DIR} && ${mcp}printf '%s' "$RUNNER_PROMPT" | env -u ANTHROPIC_API_KEY -u RUNNER_MCP DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose --include-partial-messages --model "$RUNNER_MODEL"\${RUNNER_EFFORT:+ --effort "$RUNNER_EFFORT"}${continued ? ' --continue' : ''}${allow} --add-dir ${CHAT_FILES_DIR} --disallowedTools Edit Write NotebookEdit Bash`;
    }
    return `mkdir -p ${CHAT_WORK_DIR} && cd ${CHAT_WORK_DIR} && opencode run --model "$RUNNER_MODEL"\${RUNNER_VARIANT:+ --variant "$RUNNER_VARIANT"}${continued ? ' --continue' : ''} "$RUNNER_PROMPT"`;
}

/** The variables of a message that give the harness its permissions and, with tools, the MCP server of the client. */
export function chatConfig(engine: 'claude-code' | 'opencode', tools: { list: ChatTool[]; url: string; token: string } | undefined): Record<string, string> {
    // The harness sees the tools as MCP has them; what the runner keeps of them (endsTurn) stays here.
    const environment = tools ? { RUNNER_TOOLS: JSON.stringify(tools.list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))), RUNNER_TOOLS_URL: tools.url, RUNNER_TOOLS_TOKEN: tools.token } : undefined;
    if (engine === 'claude-code') {
        return environment ? { RUNNER_MCP: JSON.stringify({ mcpServers: { tools: { command: 'node', args: [MCP_SCRIPT], env: environment } } }) } : {};
    }
    return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: { edit: 'deny', bash: 'deny' },
            ...(environment ? { mcp: { tools: { type: 'local', command: ['node', MCP_SCRIPT], environment } } } : {}),
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
 * Reads the output of a harness as events for the client: the stream-json of Claude Code (its text as it is
 * written, its tools, its end), or the text of opencode as it comes.
 */
export function chatReader(engine: 'claude-code' | 'opencode', emit: (event: ChatEvent) => void) {
    let buffer = '';
    let ended = false;
    let wrote = false;
    /** The tools said as steps: their end is said too. */
    const shown = new Set<string>();
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
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'thinking_delta') {
            emit({ type: 'reasoning', text: String(event.event.delta.thinking ?? '') });
        } else if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
                // The tools of the client are said by the client as it runs them; looking them up is no step.
                const name = String(block.name ?? '');
                if (block.type !== 'tool_use' || name.startsWith('mcp__tools__') || name === 'ToolSearch') continue;
                shown.add(String(block.id));
                emit({ type: 'step', id: String(block.id), label: toolLabel(name, block.input), status: 'running' });
            }
        } else if (event.type === 'user') {
            for (const block of event.message?.content ?? []) {
                if (block.type === 'tool_result' && shown.has(String(block.tool_use_id))) emit({ type: 'step', id: String(block.tool_use_id), label: '', status: 'done' });
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
    /** The person it belongs to (none: the tenant). */
    user?: string;
    container: string;
    messages: number;
    busy: boolean;
    lastActive: number;
    /** The tools of the client for it, and the token its MCP server calls back with. */
    tools: ChatTool[];
    token: string;
    /** Where the events of the message being answered go; none between messages. */
    emit?: (event: ChatEvent) => void;
    /** The calls of tools waiting for the client. */
    calls: Map<string, (answer: { result?: unknown; isError?: boolean }) => void>;
    /** Why the message being answered was stopped: by the person (or its stream went away), silent too long, or ended after a tool that ends it. */
    stopped?: 'silent' | 'stopped' | 'ended';
};

export type Keys = { env: Record<string, string>; accounts: Record<string, Array<{ id: string; label?: string }>> };

export type ChatDeps = {
    tenant: string;
    image: string;
    host: ChatHost;
    /** The keys a chat of this person runs with (theirs first, then the tenant's), and the accounts of each provider. */
    keys: (user?: string) => Keys;
    log: (line: string, details?: Record<string, unknown>) => void;
    /** The accounts out of credit (`provider#account`), shared with the answers: skipped, and those found out told. */
    credit?: { exhausted: (key: string) => boolean; spent: (key: string, until: number) => void };
    now?: () => number;
    /** Where the MCP server of a chat calls the runner back, from the container; none: no tools. */
    toolsUrl?: (chatId: string) => string;
    /** Chats open at once for this tenant; past them a new one is refused (busy). */
    maxChats?: number;
};

/** The tools of the client as it gives them: a few, named plainly, small. */
const toolsOf = (value: unknown): ChatTool[] => {
    if (!Array.isArray(value) || value.length > 40 || JSON.stringify(value).length > 100_000) return [];
    return value.flatMap((tool) => {
        const entry = tool as Partial<ChatTool>;
        return typeof entry?.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(entry.name) && typeof entry.description === 'string' && entry.inputSchema && typeof entry.inputSchema === 'object'
            ? [{ name: entry.name, description: entry.description.slice(0, 2000), inputSchema: entry.inputSchema, ...(entry.endsTurn === true ? { endsTurn: true } : {}) }]
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

/** The chats of one tenant. */
export class ServerChats {
    private readonly chats = new Map<string, Chat>();
    private readonly deps: ChatDeps;
    private readonly now: () => number;

    constructor(deps: ChatDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }

    /** A chat of a person (or of the tenant): its container started, idle until a message. */
    async start(id: string, user: string | undefined, tools?: unknown): Promise<{ id: string }> {
        if (!CHAT_ID.test(id)) throw new ChatError('invalid', 400);
        const existing = this.chats.get(id);
        if (existing) {
            if (existing.user !== user) throw new ChatError('no-chat', 404);
            return { id };
        }
        if (this.chats.size >= (this.deps.maxChats ?? 6)) throw new ChatError('busy', 429);
        const container = `runner-chat-${this.deps.tenant}-${id}`;
        // One left by a runner before this one (an update, a restart) under the same name: gone first, or Docker
        // refuses the new one. Its conversation is not lost: the client sends the chat again from its start.
        await this.deps.host.remove(container).catch(() => undefined);
        await this.deps.host.start(container, this.deps.image, this.deps.tenant).catch(() => {
            throw new ChatError('failed', 502);
        });
        this.chats.set(id, { id, ...(user ? { user } : {}), container, messages: 0, busy: false, lastActive: this.now(), tools: this.deps.toolsUrl ? toolsOf(tools) : [], token: randomBytes(24).toString('hex'), calls: new Map() });
        this.deps.log('chat started', { tenant: this.deps.tenant, chat: id, ...(user ? { user } : {}) });
        return { id };
    }

    /** Whether a chat is there for this person. */
    has(id: string, user: string | undefined): boolean {
        const chat = this.chats.get(id);
        return !!chat && chat.user === user;
    }

    /** How many chats are open, and how many are answering now. */
    get load(): { open: number; busy: number } {
        const all = [...this.chats.values()];
        return { open: all.length, busy: all.filter((chat) => chat.busy).length };
    }

    /** A message of the person, answered by the harness of `model` in the chat; its events as they come. */
    async send(id: string, text: string, model: ChatModel, emit: (event: ChatEvent) => void, files: ChatFile[] = []): Promise<void> {
        const chat = this.chats.get(id);
        if (!chat) throw new ChatError('no-chat', 404);
        if (chat.busy) throw new ChatError('busy', 409);
        if (!text.trim() || text.length > MESSAGE_MAX) throw new ChatError('invalid', 400);
        if (files.length && !this.deps.host.write) throw new ChatError('no-files', 400);
        const { env, accounts } = this.deps.keys(chat.user);
        const all = connectedAccounts(env, accounts)[model.provider] ?? [];
        if (!all.length) throw new ChatError('no-provider', 409);
        // Its accounts in their order, those out of credit left out: the next one when one runs out.
        const usable = all.filter((account) => !this.deps.credit?.exhausted(accountKey(model.provider, account)));
        if (!usable.length) throw new ChatError('no-credit', 409);
        const engine = model.provider === CLAUDE_CODE ? 'claude-code' : 'opencode';
        // How much Claude Code reasons; opencode by the variant of the model.
        const effort = engine === 'claude-code' && model.effort && /^(low|medium|high|xhigh|max)$/.test(model.effort) ? model.effort : undefined;
        chat.busy = true;
        // The files of the message in the container, each message in a folder of its own; the harness told where.
        if (files.length) {
            const folder = `${CHAT_FILES_DIR}/${chat.messages + 1}`;
            try {
                for (const file of files) await this.deps.host.write!(chat.container, `${folder}/${file.name}`, file.data);
            } catch {
                chat.busy = false;
                throw new ChatError('files', 502);
            }
            text += chatFilesNote(files.map((file) => ({ path: `${folder}/${file.name}`, mimeType: file.mimeType, bytes: file.data.length })));
            this.deps.log('chat files', { tenant: this.deps.tenant, chat: id, files: files.length, bytes: files.reduce((sum, file) => sum + file.data.length, 0) });
        }
        chat.emit = emit;
        chat.lastActive = this.now();
        const tools = chat.tools.length && this.deps.toolsUrl ? { list: chat.tools, url: this.deps.toolsUrl(chat.id), token: chat.token } : undefined;
        // Each message said in the log: where it runs, how it ended and how long it took. Never what it says.
        const began = this.now();
        this.deps.log('chat message', { tenant: this.deps.tenant, chat: id, provider: model.provider, model: model.model, ...(effort ? { effort } : {}), ...(model.variant ? { variant: model.variant } : {}) });
        // A harness that says nothing for long, no call of the client waiting for the person, is stuck: stopped, and said.
        let heard = this.now();
        chat.stopped = undefined;
        const watch = setInterval(() => {
            if (chat.calls.size) heard = this.now();
            else if (!chat.stopped && this.now() - heard > CHAT_SILENCE_MS) void this.interrupt(chat, 'silent');
        }, 30_000);
        try {
            for (const [index, account] of usable.entries()) {
                const candidate: Candidate = { provider: model.provider, model: model.model, ...(model.variant ? { variant: model.variant } : {}), name: model.name ?? model.model, account };
                const keys = candidateEnv(candidate, effort, env);
                let tail = '';
                // Its end (done, error) held back until it is known whether the account ran out of credit: then the
                // message runs again on the next one, the person seeing only the reply.
                let shown = false;
                let ending: ChatEvent | undefined;
                const reader = chatReader(engine, (event) => {
                    if (event.type === 'done' || event.type === 'error') ending = event;
                    else {
                        shown = true;
                        emit(event);
                    }
                });
                const code = await this.deps.host.exec(chat.container, chatScript(engine, chat.messages > 0, !!tools), { ...keys, ...chatConfig(engine, tools), RUNNER_PROMPT: text }, (chunk) => {
                    heard = this.now();
                    tail = (tail + chunk).slice(-4000);
                    reader.push(chunk);
                });
                if (!chat.stopped) reader.end(code, tail);
                const until = !chat.stopped && !shown && ending?.type === 'error' ? outOfCredit(tail, this.now()) : undefined;
                this.deps.log('chat answered', {
                    tenant: this.deps.tenant, chat: id, code, seconds: Math.round((this.now() - began) / 1000), account: account.id,
                    ...(chat.stopped ? { stopped: chat.stopped } : {}),
                    ...(until ? { outOfCreditUntil: new Date(until).toISOString() } : {}),
                    ...(code !== 0 && !chat.stopped ? { tail: tail.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]').slice(-300) } : {}),
                });
                if (until !== undefined) {
                    // Out of credit: this account skipped (by the answers too) until it may have some again; the next one.
                    this.deps.credit?.spent(accountKey(model.provider, account), until);
                    if (index < usable.length - 1) continue;
                    // The last one: the client is told until when, to offer another model.
                    emit({ type: 'error', message: `no-credit:${new Date(until).toISOString()}` });
                    break;
                }
                if (chat.stopped === 'silent') emit({ type: 'error', message: 'silent' });
                else if (chat.stopped === 'stopped' || chat.stopped === 'ended') emit({ type: 'done' });
                else if (ending) emit(ending);
                break;
            }
            chat.messages += 1;
        } finally {
            clearInterval(watch);
            chat.busy = false;
            chat.emit = undefined;
            // The calls still waiting end with the message.
            for (const answer of chat.calls.values()) answer({ result: 'The message ended before the client answered.', isError: true });
            chat.calls.clear();
            chat.lastActive = this.now();
        }
    }

    /** Stops the message a chat is answering (the person stopped it, or its stream went away): its harness ended. */
    async stop(id: string): Promise<boolean> {
        const chat = this.chats.get(id);
        if (!chat?.busy || chat.stopped) return false;
        await this.interrupt(chat, 'stopped');
        return true;
    }

    private async interrupt(chat: { container: string; stopped?: 'silent' | 'stopped' | 'ended' }, why: 'silent' | 'stopped' | 'ended'): Promise<void> {
        chat.stopped = why;
        this.deps.log('chat interrupted', { chat: chat.container, why });
        await this.deps.host.interrupt?.(chat.container).catch(() => undefined);
    }

    /**
     * A call of a tool of the client by the harness of a chat (its MCP server, with the token of the chat): sent
     * to the client with the reply being written, answered when the client says what it gave.
     */
    async callTool(id: string, token: string, name: string, input: Record<string, unknown>): Promise<{ result?: unknown; isError?: boolean }> {
        const chat = this.chats.get(id);
        const expected = Buffer.from(chat?.token ?? '');
        const given = Buffer.from(token);
        if (!chat || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ChatError('bad token', 401);
        if (!chat.tools.some((tool) => tool.name === name)) throw new ChatError('unknown tool', 404);
        if (!chat.emit) throw new ChatError('no message', 409);
        const callId = randomBytes(6).toString('hex');
        const asked = this.now();
        const answered = new Promise<{ result?: unknown; isError?: boolean }>((resolve) => {
            const timer = setTimeout(() => {
                chat.calls.delete(callId);
                resolve({ result: 'The client did not answer in time.', isError: true });
            }, TOOL_CALL_TIMEOUT_MS);
            chat.calls.set(callId, (answer) => {
                clearTimeout(timer);
                chat.calls.delete(callId);
                this.deps.log('chat tool answered', { tenant: this.deps.tenant, chat: id, tool: name, seconds: Math.round((this.now() - asked) / 1000), ...(answer.isError ? { error: true } : {}) });
                resolve(answer);
                // A tool that ends the message (a draft shown as a card): the harness has a moment to close it, then
                // the message is ended for it, what it wrote kept.
                if (!answer.isError && chat.tools.find((tool) => tool.name === name)?.endsTurn) {
                    setTimeout(() => {
                        if (chat.busy && !chat.stopped) void this.interrupt(chat, 'ended');
                    }, ENDS_TURN_GRACE_MS).unref?.();
                }
            });
        });
        chat.lastActive = this.now();
        chat.emit({ type: 'tool-call', id: callId, name, input });
        this.deps.log('chat tool called', { tenant: this.deps.tenant, chat: id, tool: name });
        return answered;
    }

    /** What the client gave for a call of a tool; false when no call waits with that id. */
    answerTool(id: string, user: string | undefined, callId: string, answer: { result?: unknown; isError?: boolean }): boolean {
        if (!this.has(id, user)) return false;
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
        this.deps.log('chat closed', { tenant: this.deps.tenant, chat: id });
        return true;
    }

    /** Closes every chat (the tenant taken off the runner, the runner stopping). */
    async closeAll(): Promise<void> {
        for (const id of [...this.chats.keys()]) await this.close(id);
    }

    /** Closes the chats no one wrote to for a while. */
    async sweep(): Promise<void> {
        for (const chat of [...this.chats.values()]) {
            if (!chat.busy && this.now() - chat.lastActive > CHAT_IDLE_MS) await this.close(chat.id);
        }
    }
}
