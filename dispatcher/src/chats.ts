import { spawn } from 'node:child_process';
import type { GitHubApi } from './github.ts';
import { CLAUDE_CODE, candidateEnv, connectedAccounts, type Candidate } from './providers.ts';

// The chats of the studio with a harness on the server (docs/playbook-model.md §8.7): Agentico talks to Claude
// Code (with the subscription of the organization) or to opencode (with its keys) running here, next to the
// repository of a project, read only. One container per chat, the repository cloned once; each message runs
// the harness in it, continuing the conversation of the one before, and its reply goes to the studio as it
// comes: text, the tools it uses, its end.

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
    | { type: 'error'; message: string };

/** Where a chat runs: the provider of the organization and the model its engine is given. */
export type ChatModel = { provider: string; model: string; variant?: string; name?: string };

export interface ChatHost {
    /** Starts the container of a chat, idle until a message. */
    start(name: string, image: string, owner: string): Promise<void>;
    /** Runs a command in it with these variables; its output as it comes. */
    exec(name: string, command: string, env: Record<string, string>, onOutput: (chunk: string) => void): Promise<number>;
    remove(name: string): Promise<void>;
}

/** The containers of the chats, through the Docker socket; the values of the variables never on a command line. */
export function dockerChatHost(command = 'docker'): ChatHost {
    const run = (args: string[], env: Record<string, string> = {}, onOutput?: (chunk: string) => void) => new Promise<number>((resolve) => {
        const child = spawn(command, args, { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => onOutput?.(chunk.toString('utf8')));
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code ?? 1));
    });
    return {
        async start(name, image, owner) {
            const code = await run(['run', '-d', '--name', name, '--label', `${CHAT_LABEL}=${owner}`, '--entrypoint', 'sleep', image, 'infinity']);
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

/** The harness, on the message in PLAYBOOK_PROMPT; read only: no tool that writes or runs commands. */
export function chatScript(engine: 'claude-code' | 'opencode', continued: boolean): string {
    if (engine === 'claude-code') {
        // The subscription, never an API key; the prompt from stdin (the list of tools would take it).
        return `cd /work/repo && printf '%s' "$PLAYBOOK_PROMPT" | env -u ANTHROPIC_API_KEY DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose --include-partial-messages --model "$PLAYBOOK_MODEL"${continued ? ' --continue' : ''} --disallowedTools Edit Write NotebookEdit Bash`;
    }
    return `cd /work/repo && OPENCODE_CONFIG_CONTENT='{"permission":{"edit":"deny","bash":"deny"}}' opencode run --model "$PLAYBOOK_MODEL"\${PLAYBOOK_VARIANT:+ --variant "$PLAYBOOK_VARIANT"}${continued ? ' --continue' : ''} "$PLAYBOOK_PROMPT"`;
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

type Chat = { id: string; name: string; repository: string; container: string; messages: number; busy: boolean; lastActive: number };

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
    async start(id: string, repository: string): Promise<{ id: string }> {
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
        this.chats.set(id, { id, name: id, repository, container, messages: 0, busy: false, lastActive: this.now() });
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
        chat.lastActive = this.now();
        let tail = '';
        const reader = chatReader(engine, emit);
        try {
            const code = await this.deps.host.exec(chat.container, chatScript(engine, chat.messages > 0), { ...keys, PLAYBOOK_PROMPT: text }, (chunk) => {
                tail = (tail + chunk).slice(-4000);
                reader.push(chunk);
            });
            reader.end(code, tail);
            chat.messages += 1;
        } finally {
            chat.busy = false;
            chat.lastActive = this.now();
        }
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
