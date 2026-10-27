import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GitHubApi } from './github.ts';
import type { Log } from './dispatcher.ts';

// The design sessions of a company: a person and the design agent (opencode with the design skills)
// talk on a project, the agent writes documents, and at the end the dispatcher puts them in a pull
// request as a source (`sources/conversations/<name>/`). One container per session, reached over HTTP with
// a password of its own. A session left alone is paused (its container stopped, opencode keeps the
// conversation on disk) and wakes up at the next message; after some days it is removed.

/** What the dispatcher needs of Docker for the sessions. */
export interface DesignHost {
    /** Starts the container of a session; resolves with the address of its opencode. */
    start(spec: { name: string; image: string; env: Record<string, string> }): Promise<string>;
    /** Starts a stopped container again; resolves with its address. */
    wake(name: string): Promise<string>;
    pause(name: string): Promise<void>;
    remove(name: string): Promise<void>;
    /** The documents the session wrote (`playbook-design-files` in the container). */
    files(name: string): Promise<DesignFile[]>;
    /** The last lines the container printed, to say why a session did not start. */
    logs(name: string): Promise<string>;
}

/** A document of a session: added in the clone (`new`) or changed (`modified`). */
export type DesignFile = { path: string; content: string; status?: 'new' | 'modified' };

export type DesignStatus = 'starting' | 'active' | 'paused' | 'finished' | 'cancelled' | 'failed';

interface DesignRecord {
    id: string;
    /**
     * Its name, given at the start: `<date>-<topic>-<method>`, the same for its page in the studio, its
     * folder in `sources/conversations/` and its branch. Unique among the sessions of the repository.
     */
    name?: string;
    repository: string;
    topic: string;
    /** The kit of the session (its method): the image it runs and the skill it starts with. */
    kit?: string;
    model?: string;
    status: DesignStatus;
    createdAt: string;
    lastActive: string;
    container: string;
    password: string;
    address?: string;
    session?: string;
    /** The first message has run the skill: the next ones are plain messages. */
    opened?: boolean;
    /**
     * The commands the person ran with "/" after the first message, as typed and when: opencode keeps
     * the text of the skill as the message, the conversation shows what the person wrote.
     */
    commands?: Array<{ at: number; text: string }>;
    pullRequest?: { number: number; url: string; branch: string };
    error?: string;
    /** Taken off the lists by the person: kept in the data, never shown again. */
    archived?: boolean;
    /** Seconds the agent worked (busy), every turn together. */
    workSeconds?: number;
    /** When the turn running now started, while it runs. */
    busySince?: string;
}

/** A session as the studio sees it: no container, no password. */
export type DesignView = Pick<DesignRecord, 'id' | 'name' | 'repository' | 'topic' | 'kit' | 'model' | 'status' | 'createdAt' | 'lastActive' | 'pullRequest' | 'error' | 'workSeconds'>;

/** A message of the conversation, for the studio. */
/**
 * A part of a reply of the agent, in the order it came: its reasoning (with how long it took), its
 * text, a step, the questions it asked with the question tool (with the answers, once given).
 */
export type DesignMessagePart =
    | { type: 'reasoning'; id: string; text: string; seconds?: number }
    | { type: 'text'; id: string; text: string }
    | { type: 'tool'; id: string; tool: string; title: string }
    | { type: 'questions'; id: string; questions: Question[]; answers?: string[][] };

/** What a reply of the agent cost, as opencode counts it: its tokens, its price in dollars, how long it took. */
export type DesignUsage = { model?: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; seconds?: number; at?: string };

/**
 * A message of a session; `parts` (from 0.12.8) is the reply as it came, `text` and `tools` what an
 * older studio reads, `usage` (from 0.12.9) what the reply cost.
 */
export type DesignMessage = { id: string; role: 'user' | 'assistant'; text: string; tools: Array<{ tool: string; title: string }>; parts?: DesignMessagePart[]; usage?: DesignUsage };

/** What happens in a session, as it happens. */
export type DesignEvent =
    | { type: 'delta'; message: string; part: string; text: string }
    | { type: 'text'; message: string; part: string; text: string }
    | { type: 'tool'; message: string; part: string; tool: string; status: string; title: string }
    /** The reasoning of the model: a delta, or whole (with how long it took, once it is over). */
    | { type: 'reasoning'; message: string; part: string; text: string; delta?: boolean; seconds?: number }
    /** The agent asked with its question tool and waits: the next message answers. */
    | { type: 'questions'; message: string; part: string; questions: Question[] }
    | { type: 'busy'; busy: boolean }
    | { type: 'error'; message: string }
    | { type: 'status'; design: DesignView };

export class DesignError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/** Sessions running at once on the machine, every company together; by session, so taking twice counts once. */
export interface DesignSlots {
    take(key: string): boolean;
    release(key: string): void;
}

export function designSlots(limit: number): DesignSlots {
    const used = new Set<string>();
    return {
        take: (key) => (used.has(key) || used.size < limit ? (used.add(key), true) : false),
        release: (key) => {
            used.delete(key);
        },
    };
}

export interface DesignOptions {
    company: string;
    github: GitHubApi;
    host: DesignHost;
    slots: DesignSlots;
    /** The JSON file of the sessions of the company. */
    file: string;
    /** The keys of the model providers, as for the turns. */
    agentEnv: Record<string, string>;
    log: Log;
    /** Minutes without a message before a session is paused. */
    idleMinutes: number;
    /** Days a paused session is kept before it is removed. */
    keepDays: number;
    /** The design agents of the runner by kit: the image and the skill a session starts with. None: no design sessions here. */
    kits: Record<string, { image: string; command: string }>;
    fetch?: typeof fetch;
    now?: () => number;
    /** How long to wait for opencode to answer after a start, in ms. */
    readyTimeout?: number;
}

// Owner and name start with a letter or a digit: never `.` or `..`.
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// The id of a model may hold slashes and @ itself: openrouter/deepseek/…, cloudflare-workers-ai/@cf/….
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9@._:+/-]+$/;
const LIVE: DesignStatus[] = ['starting', 'active', 'paused'];

export const designSlug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'design';

const view = ({ id, name, repository, topic, kit, model, status, createdAt, lastActive, pullRequest, error, workSeconds }: DesignRecord): DesignView => ({ id, ...(name ? { name } : {}), repository, topic, ...(kit ? { kit } : {}), model, status, createdAt, lastActive, workSeconds: Math.round(workSeconds ?? 0), ...(pullRequest ? { pullRequest } : {}), ...(error ? { error } : {}) });

export class DesignSessions {
    private readonly records = new Map<string, DesignRecord>();
    private readonly listeners = new Map<string, Set<(event: DesignEvent) => void>>();
    private readonly upstream = new Map<string, AbortController>();
    private readonly options: DesignOptions;
    private readonly fetch: typeof fetch;
    private readonly now: () => number;

    constructor(options: DesignOptions) {
        this.options = options;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        try {
            for (const record of JSON.parse(readFileSync(options.file, 'utf8')) as DesignRecord[]) this.records.set(record.id, record);
        } catch {
            // First start.
        }
        // A session active before a restart holds its slot again.
        for (const record of this.records.values()) if (record.status === 'active' || record.status === 'starting') this.options.slots.take(this.slot(record));
    }

    list(): DesignView[] {
        return [...this.records.values()].filter((record) => !record.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view);
    }

    get(id: string): DesignView | undefined {
        const record = this.records.get(id);
        return record && view(record);
    }

    /** Starts a session on a repository of the company, with what it is about; `id` may come from the studio (8 hex). */
    async start(input: { id?: unknown; repository?: unknown; topic?: unknown; model?: unknown; kit?: unknown }): Promise<DesignView> {
        const repository = String(input.repository ?? '');
        const topic = String(input.topic ?? '').trim();
        const model = input.model ? String(input.model) : undefined;
        const kits = Object.keys(this.options.kits);
        if (!kits.length) throw new DesignError('this runner has no design agent', 404);
        // The kit asked for, or the only one of the runner.
        const kit = input.kit ? String(input.kit) : kits.length === 1 ? kits[0] : '';
        if (!this.options.kits[kit]) throw new DesignError(`kit must be one of ${kits.join(', ')}`, 400);
        if (!REPOSITORY.test(repository)) throw new DesignError('repository must be owner/name', 400);
        if (!topic) throw new DesignError('topic is required', 400);
        if (model && !MODEL.test(model)) throw new DesignError('model must be provider/model', 400);
        // The studio may choose the id, to tie its chat to the session before it exists.
        const wanted = typeof input.id === 'string' ? input.id : '';
        if (wanted && (!/^[a-f0-9]{8}$/.test(wanted) || this.records.has(wanted))) throw new DesignError('id must be 8 hex digits, not taken', 400);
        const id = wanted || randomBytes(4).toString('hex');
        if (!(await this.takeSlot(`${this.options.company}/${id}`, id))) throw new DesignError('too many design sessions on this runner: try again later', 429);
        const at = new Date(this.now()).toISOString();
        const record: DesignRecord = {
            id, name: this.nameFor(repository, topic, kit, at), repository, topic, kit, model, status: 'starting', createdAt: at, lastActive: at,
            container: `playbook-design-${this.options.company}-${id}`,
            password: randomBytes(24).toString('base64url'),
        };
        this.records.set(id, record);
        this.save();
        try {
            // The clone only: contents read, this repository, an hour.
            const token = await this.options.github.turnToken(repository, { contents: 'read', metadata: 'read' });
            record.address = await this.options.host.start({
                name: record.container,
                image: this.options.kits[kit].image,
                env: { ...this.options.agentEnv, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, OPENCODE_SERVER_PASSWORD: record.password },
            });
            await this.ready(record);
            record.session = (await this.call<{ id: string }>(record, 'POST', '/session', { title: topic.slice(0, 80) })).id;
            record.status = 'active';
            this.save();
            this.options.log('design started', { design: id, repository });
            // The first round starts with the first message (send): the studio follows the events
            // before it, so nothing of the reply is missed.
            return view(record);
        } catch (error) {
            record.status = 'failed';
            record.error = (error as Error).message;
            this.options.slots.release(this.slot(record));
            this.save();
            const logs = await this.options.host.logs(record.container).catch(() => '');
            await this.options.host.remove(record.container).catch(() => undefined);
            this.options.log('design failed to start', { design: id, error: record.error, logs: logs.slice(-2000) });
            throw new DesignError(`the design session did not start: ${record.error}`, 502);
        }
    }

    /**
     * A message of the person; a paused session wakes up first. The first one runs the skill with
     * the message as its argument (usually the topic), the next ones are plain messages.
     */
    async send(id: string, input: { text?: unknown; model?: unknown; answers?: unknown }): Promise<void> {
        const text = String(input.text ?? '').trim();
        // The answers to the questions of the agent as the person chose them, one list per question.
        const answers = Array.isArray(input.answers) && input.answers.every((answer) => Array.isArray(answer))
            ? (input.answers as unknown[][]).map((answer) => answer.map(String))
            : undefined;
        if (!text) throw new DesignError('text is required', 400);
        const model = input.model ? String(input.model) : undefined;
        if (model && !MODEL.test(model)) throw new DesignError('model must be provider/model', 400);
        const record = await this.awake(id);
        record.lastActive = new Date(this.now()).toISOString();
        // A model picked with a message is the model of the session from then on.
        if (model) record.model = model;
        if (!record.opened) {
            record.opened = true;
            this.save();
            // opencode answers this call when the round is over: a wait longer than fetch allows for
            // the headers is no failure, the round goes on and its events arrive.
            void this.call(record, 'POST', `/session/${record.session}/command`, {
                command: this.commandOf(record),
                arguments: text,
                ...(record.model ? { model: record.model } : {}),
            }, { timeout: 0 }).catch((error: Error & { cause?: { code?: string } }) => {
                if (error.cause?.code !== 'UND_ERR_HEADERS_TIMEOUT') this.emit(id, { type: 'error', message: error.message });
            });
            return;
        }
        this.save();
        // The agent asked with its question tool (choices, BMAD does): the message is the answer.
        const asked = await this.pendingQuestion(record);
        if (asked) {
            const chosen = answers?.length === asked.questions.length ? answers : answersOf(asked.questions, text);
            await this.call(record, 'POST', `/question/${asked.id}/reply`, { answers: chosen });
            return;
        }
        // "/to-spec …": a command of opencode (a skill the method leaves to the person), when it has one by that name.
        const command = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
        if (command && (await this.commandNames(record)).includes(command[1])) {
            record.commands = [...(record.commands ?? []), { at: this.now(), text }];
            this.save();
            void this.call(record, 'POST', `/session/${record.session}/command`, {
                command: command[1],
                arguments: command[2] ?? '',
                ...(record.model ? { model: record.model } : {}),
            }, { timeout: 0 }).catch((error: Error & { cause?: { code?: string } }) => {
                if (error.cause?.code !== 'UND_ERR_HEADERS_TIMEOUT') this.emit(id, { type: 'error', message: error.message });
            });
            return;
        }
        await this.call(record, 'POST', `/session/${record.session}/prompt_async`, {
            parts: [{ type: 'text', text }],
            ...(record.model ? { model: { providerID: record.model.split('/')[0], modelID: record.model.slice(record.model.indexOf('/') + 1) } } : {}),
        });
    }

    /** `<date>-<topic>-<method>`, with `-2`, `-3`… when the repository has it already. */
    private nameFor(repository: string, topic: string, kit: string, at: string): string {
        const base = `${at.slice(0, 10)}-${((slug) => (slug.length > 40 ? slug.slice(0, 41).replace(/-[^-]*$/, '') : slug))(designSlug(topic))}-${kit}`;
        const taken = new Set([...this.records.values()].filter((record) => record.repository === repository).map((record) => record.name));
        let name = base;
        for (let next = 2; taken.has(name); next += 1) name = `${base}-${next}`;
        return name;
    }

    /**
     * The documents of a session as they are now: read from its container while it is active, else the
     * last ones read (a paused session is not woken up for this, a finished one keeps its own).
     */
    async files(id: string): Promise<{ files: DesignFile[]; live: boolean; at?: string }> {
        const record = this.find(id);
        if (record.status === 'active') {
            try {
                const files = await this.options.host.files(record.container);
                return { files, live: true, at: this.keepFiles(record, files) };
            } catch {
                // Busy writing, or just stopped: the last ones read.
            }
        }
        try {
            const kept = JSON.parse(readFileSync(this.filesOf(record), 'utf8')) as { files: DesignFile[]; at: string };
            return { files: kept.files, live: false, at: kept.at };
        } catch {
            return { files: [], live: false };
        }
    }

    private filesOf(record: DesignRecord) {
        return `${this.options.file.replace(/\.json$/, '')}-files/${record.id}.json`;
    }

    /** Keeps the documents last read, for when the container is stopped or gone; says when. */
    private keepFiles(record: DesignRecord, files: DesignFile[]): string {
        const at = new Date(this.now()).toISOString();
        try {
            mkdirSync(this.filesOf(record).replace(/\/[^/]+$/, ''), { recursive: true });
            writeFileSync(this.filesOf(record), JSON.stringify({ at, files }));
        } catch {
            // A copy only: the documents are in the container.
        }
        return at;
    }

    /** The question the agent of the session is waiting on, if any (an older opencode has none). */
    private async pendingQuestion(record: DesignRecord): Promise<QuestionRequest | undefined> {
        const pending = await this.call<QuestionRequest[]>(record, 'GET', '/question').catch(() => []);
        return (Array.isArray(pending) ? pending : []).find((request) => request.sessionID === record.session);
    }

    /**
     * The conversation so far, from opencode while the session is active (kept as a copy); the last copy
     * once it is paused or ended, never waking it up. The first message of the person is the topic.
     */
    async messages(id: string): Promise<DesignMessage[]> {
        const record = this.find(id);
        if (record.status !== 'active') {
            try {
                return JSON.parse(readFileSync(this.messagesOf(record), 'utf8')) as DesignMessage[];
            } catch {
                return [];
            }
        }
        const messages = await this.liveMessages(record);
        try {
            mkdirSync(this.messagesOf(record).replace(/\/[^/]+$/, ''), { recursive: true });
            writeFileSync(this.messagesOf(record), JSON.stringify(messages));
        } catch {
            // A copy only: the conversation is in the container.
        }
        return messages;
    }

    private messagesOf(record: DesignRecord) {
        return `${this.options.file.replace(/\.json$/, '')}-files/${record.id}.messages.json`;
    }

    /** Before its container stops or goes: its documents and conversation kept, to be read without it. */
    private async keepCopies(record: DesignRecord) {
        if (record.status !== 'active') return;
        await this.messages(record.id).catch(() => undefined);
        await this.options.host.files(record.container).then((files) => this.keepFiles(record, files)).catch(() => undefined);
    }

    private async liveMessages(record: DesignRecord): Promise<DesignMessage[]> {
        type Part = {
            id: string; type: string; text?: string; synthetic?: boolean; tool?: string; time?: { start?: number; end?: number };
            state?: { status?: string; input?: Record<string, unknown>; title?: string; metadata?: { answers?: unknown } };
        };
        type Info = {
            id: string; role: 'user' | 'assistant'; error?: { name?: string; data?: { message?: string } };
            cost?: number; time?: { created?: number; completed?: number };
            tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        };
        const raw = await this.call<Array<{ info: Info; parts: Part[] }>>(record, 'GET', `/session/${record.session}/message`);
        // A command after the first message reads as the person typed it: the first message of the
        // person from when it was sent on (opencode answers in a moment).
        const commands = [...(record.commands ?? [])];
        const typed = (message: { info: Info }) => {
            const created = message.info.time?.created;
            if (message.info.role !== 'user' || typeof created !== 'number' || !commands.length || created < commands[0].at - 5_000) return undefined;
            return commands.shift()!.text;
        };
        return raw.map((message, index) => ({
            id: message.info.id,
            role: message.info.role,
            text: message.info.role === 'user' && index === 0
                ? record.topic
                : (index > 0 && typed(message)) || message.parts
                    // A question asked with the tool reads as the agent wrote it, with its choices.
                    .map((part) => (part.type === 'text' && !part.synthetic ? part.text ?? '' : part.type === 'tool' && part.tool === 'question' ? questionText((part.state?.input?.questions ?? []) as Question[]) : ''))
                    .filter(Boolean).join('\n\n').trim()
                    // A reply that failed says why.
                    || (message.info.error ? `⚠ ${errorText(message.info.error)}` : ''),
            tools: message.parts.filter((part) => part.type === 'tool').map((part) => ({ tool: part.tool ?? '', title: toolTitle(part.state) })),
            ...(message.info.role === 'assistant' ? { parts: message.parts.flatMap((part) => messagePartOf(part)), ...(message.info.tokens ? { usage: usageOf(message.info) } : {}) } : {}),
        }));
    }

    /** Follows a session: its status, then what opencode does, as it happens. Returns the way to stop. */
    follow(id: string, listener: (event: DesignEvent) => void): () => void {
        const record = this.find(id);
        const set = this.listeners.get(id) ?? new Set();
        set.add(listener);
        this.listeners.set(id, set);
        listener({ type: 'status', design: view(record) });
        if (record.status === 'active') this.listen(record);
        return () => {
            set.delete(listener);
            if (!set.size) {
                this.listeners.delete(id);
                this.upstream.get(id)?.abort();
                this.upstream.delete(id);
            }
        };
    }

    /** The end of a session: its documents go to a branch with a pull request, its container goes away. */
    async finish(id: string, input: { title?: unknown }): Promise<DesignView> {
        const title = String(input.title ?? '').trim();
        if (!title) throw new DesignError('title is required', 400);
        const record = await this.awake(id);
        // The conversation as it went is a source too, next to what the agent wrote.
        const messages = await this.messages(id);
        if (!messages.some((message) => message.role === 'assistant' && message.text)) throw new DesignError('the agent has not answered yet', 409);
        const written = await this.options.host.files(record.container);
        this.keepFiles(record, written);
        const { github } = this.options;
        const repo = `/repos/${record.repository}`;
        const date = new Date(this.now()).toISOString().slice(0, 10);
        const method = record.kit ?? 'design';
        // The name given at the start; a session started before names had one from its title.
        const name = record.name ?? `${date}-${designSlug(title)}-${method}`;
        // sources/ is the raw archive of the project: one folder per conversation, only ever added to.
        const folder = `sources/conversations/${name}`;
        const files = [{ path: 'transcript.md', content: transcriptOf(record, messages, title, new Date(this.now()).toISOString()) }, ...written.filter((file) => file.path !== 'transcript.md')];
        const base = (await github.request<{ default_branch: string }>('GET', repo)).default_branch;
        const head = (await github.request<{ object: { sha: string } }>('GET', `${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
        const baseTree = (await github.request<{ tree: { sha: string } }>('GET', `${repo}/git/commits/${head}`)).tree.sha;
        const tree = await github.request<{ sha: string }>('POST', `${repo}/git/trees`, {
            base_tree: baseTree,
            tree: files.map((file) => ({ path: `${folder}/${file.path}`, mode: '100644', type: 'blob', content: file.content })),
        });
        const commit = await github.request<{ sha: string }>('POST', `${repo}/git/commits`, { message: `Design: ${title}`, tree: tree.sha, parents: [head] });
        const branch = record.name ? `design/${name}` : `design/${name}-${record.id}`;
        await github.request('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        const pull = await github.request<{ number: number; html_url: string }>('POST', `${repo}/pulls`, {
            title: `Design: ${title}`,
            head: branch,
            base,
            body: [
                `A design session (${method}) on "${record.topic}": its whole conversation (\`transcript.md\`) and the documents it wrote.`,
                '',
                `They go to \`${folder}/\` as a **source**: raw, never changed, only added to. Once merged, other sessions can read them, the analyst turns them into Epics with their user stories, and what is decided goes, refined, to the memory of the company.`,
                '',
                ...files.map((file) => `- \`${folder}/${file.path}\``),
            ].join('\n'),
        });
        record.pullRequest = { number: pull.number, url: pull.html_url, branch };
        await this.close(record, 'finished');
        this.options.log('design finished', { design: id, pullRequest: pull.number, files: files.length });
        return view(record);
    }

    /** Stops a session without a pull request. */
    async cancel(id: string): Promise<DesignView> {
        const record = this.find(id);
        if (LIVE.includes(record.status)) await this.close(record, 'cancelled');
        return view(record);
    }

    /** Takes a session off the lists: a live one is closed first, without a pull request. */
    async archive(id: string): Promise<DesignView> {
        const record = this.find(id);
        if (LIVE.includes(record.status)) await this.close(record, 'cancelled');
        record.archived = true;
        this.save();
        return view(record);
    }

    /** Pauses the sessions left alone and removes the ones paused for too long. */
    async sweep(): Promise<void> {
        const now = this.now();
        for (const record of this.records.values()) {
            const idle = now - Date.parse(record.lastActive);
            if (record.status === 'active' && idle > this.options.idleMinutes * 60_000 && !(await this.busy(record))) {
                await this.pause(record);
                this.options.log('design paused', { design: record.id });
            } else if (record.status === 'paused' && idle > this.options.keepDays * 86_400_000) {
                await this.close(record, 'cancelled');
                this.options.log('design removed after its days', { design: record.id });
            }
        }
    }

    /** Stops the container of a session and frees its slot: opencode keeps the conversation, a message wakes it up. */
    private async pause(record: DesignRecord) {
        this.upstream.get(record.id)?.abort();
        this.upstream.delete(record.id);
        await this.keepCopies(record);
        await this.options.host.pause(record.container);
        record.status = 'paused';
        this.options.slots.release(this.slot(record));
        this.save();
        this.emit(record.id, { type: 'status', design: view(record) });
    }

    /**
     * A slot for a session; when the runner is full, the session of this company left alone the
     * longest (not working) is paused to make room. Sessions of other companies are never touched.
     */
    private async takeSlot(slot: string, except: string): Promise<boolean> {
        if (this.options.slots.take(slot)) return true;
        const idle = [...this.records.values()]
            .filter((record) => record.status === 'active' && record.id !== except)
            .sort((a, b) => Date.parse(a.lastActive) - Date.parse(b.lastActive));
        for (const record of idle) {
            if (await this.busy(record)) continue;
            await this.pause(record);
            this.options.log('design paused to make room', { design: record.id, for: except });
            return this.options.slots.take(slot);
        }
        return false;
    }

    /** The skill a session starts with: the command of its kit (a session made before kits: the only one). */
    /** The commands opencode of the session knows (its own and one per skill). */
    private async commandNames(record: DesignRecord): Promise<string[]> {
        const commands = await this.call<Array<{ name?: string }>>(record, 'GET', '/command').catch(() => []);
        return (Array.isArray(commands) ? commands : []).map((command) => String(command.name ?? ''));
    }

    private commandOf(record: DesignRecord): string {
        const kit = this.options.kits[record.kit ?? ''] ?? Object.values(this.options.kits)[0];
        if (!kit) throw new DesignError('this runner has no design agent', 404);
        return kit.command;
    }

    /** The time the agent works: from busy to idle, added to the session. */
    private count(record: DesignRecord, busy: boolean) {
        const now = this.now();
        if (busy && !record.busySince) record.busySince = new Date(now).toISOString();
        else if (!busy && record.busySince) {
            record.workSeconds = (record.workSeconds ?? 0) + Math.max(0, now - Date.parse(record.busySince)) / 1000;
            delete record.busySince;
        } else return;
        this.save();
    }

    private slot(record: DesignRecord) {
        return `${this.options.company}/${record.id}`;
    }

    private find(id: string): DesignRecord {
        const record = this.records.get(id);
        if (!record) throw new DesignError('not found', 404);
        return record;
    }

    private async awake(id: string): Promise<DesignRecord> {
        const record = this.find(id);
        if (record.status === 'paused') {
            if (!(await this.takeSlot(this.slot(record), record.id))) throw new DesignError('too many design sessions on this runner: try again later', 429);
            record.address = await this.options.host.wake(record.container);
            await this.ready(record);
            record.status = 'active';
            record.lastActive = new Date(this.now()).toISOString();
            this.save();
            this.emit(id, { type: 'status', design: view(record) });
            if (this.listeners.has(id)) this.listen(record);
        }
        if (record.status !== 'active' || !record.session) throw new DesignError(`the session is ${record.status}`, 409);
        return record;
    }

    private async close(record: DesignRecord, status: DesignStatus) {
        await this.keepCopies(record);
        if (record.status === 'active' || record.status === 'starting') this.options.slots.release(this.slot(record));
        this.upstream.get(record.id)?.abort();
        this.upstream.delete(record.id);
        await this.options.host.remove(record.container).catch(() => undefined);
        record.status = status;
        this.save();
        this.emit(record.id, { type: 'status', design: view(record) });
    }

    private async busy(record: DesignRecord): Promise<boolean> {
        try {
            const statuses = await this.call<Record<string, { type: string }>>(record, 'GET', '/session/status');
            return statuses[record.session ?? '']?.type === 'busy';
        } catch {
            return false;
        }
    }

    private async ready(record: DesignRecord) {
        const until = this.now() + (this.options.readyTimeout ?? 60_000);
        for (;;) {
            try {
                // While it starts, opencode may take the connection and answer late: a short wait each time.
                await this.call(record, 'GET', '/session', undefined, { timeout: 5000 });
                return;
            } catch (error) {
                if (this.now() > until) throw error;
                await new Promise((done) => setTimeout(done, 1000));
            }
        }
    }

    /** A call to the opencode of a session; 30 seconds at most unless said otherwise (0: no limit). */
    private async call<T>(record: DesignRecord, method: string, path: string, body?: unknown, options: { timeout?: number } = {}): Promise<T> {
        const timeout = options.timeout ?? 30_000;
        const response = await this.fetch(`${record.address}${path}`, {
            method,
            signal: timeout ? AbortSignal.timeout(timeout) : undefined,
            headers: { authorization: `Basic ${Buffer.from(`opencode:${record.password}`).toString('base64')}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`opencode answered ${response.status}`);
        return (text ? JSON.parse(text) : undefined) as T;
    }

    /** One stream of opencode events per followed session, turned into the events of the studio. */
    private listen(record: DesignRecord) {
        if (this.upstream.has(record.id)) return;
        const abort = new AbortController();
        this.upstream.set(record.id, abort);
        const roles = new Map<string, string>();
        const kinds = new Map<string, string>();
        void (async () => {
            try {
                const response = await this.fetch(`${record.address}/event`, {
                    signal: abort.signal,
                    headers: { authorization: `Basic ${Buffer.from(`opencode:${record.password}`).toString('base64')}`, accept: 'text/event-stream' },
                });
                if (!response.ok || !response.body) throw new Error(`opencode events answered ${response.status}`);
                const decoder = new TextDecoder();
                let pending = '';
                for await (const chunk of response.body) {
                    pending += decoder.decode(chunk as Uint8Array, { stream: true });
                    let end: number;
                    while ((end = pending.indexOf('\n\n')) >= 0) {
                        const block = pending.slice(0, end);
                        pending = pending.slice(end + 2);
                        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
                        if (!data) continue;
                        const parsed = JSON.parse(data) as OpencodeEvent;
                        const request = parsed.type === 'question.asked' ? parsed.properties as unknown as QuestionRequest : undefined;
                        if (request && request.sessionID === record.session) {
                            // The agent waits on the person: its questions in the chat, and the turn is over
                            // for the studio (the next message answers them). Waiting is no work.
                            this.emit(record.id, { type: 'questions', message: request.tool?.messageID ?? request.id, part: `question-${request.id}`, questions: request.questions });
                            this.count(record, false);
                            this.emit(record.id, { type: 'busy', busy: false });
                            continue;
                        }
                        const event = designEventOf(parsed, record.session ?? '', roles, kinds);
                        if (event?.type === 'busy') this.count(record, event.busy);
                        if (event) this.emit(record.id, event);
                    }
                }
            } catch (error) {
                if (!abort.signal.aborted) this.emit(record.id, { type: 'error', message: (error as Error).message });
            } finally {
                if (this.upstream.get(record.id) === abort) this.upstream.delete(record.id);
            }
        })();
    }

    private emit(id: string, event: DesignEvent) {
        for (const listener of this.listeners.get(id) ?? []) listener(event);
    }

    private save() {
        writeFileSync(`${this.options.file}.tmp`, JSON.stringify([...this.records.values()], null, 2));
        renameSync(`${this.options.file}.tmp`, this.options.file);
    }
}

/** What went wrong, from an error of opencode: its message, without the body of the answer. */
export function errorText(error: { name?: string; data?: { message?: string } } | undefined): string {
    const message = String(error?.data?.message ?? error?.name ?? 'error');
    // Providers wrap their reason in JSON (`Forbidden: {"errors":[{"message":"…"}]}`): the reason is enough.
    const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
    return (inner ? inner.replace(/\\"/g, '"') : message).slice(0, 500);
}

/**
 * The conversation of a session as a source: who asked what, the answers, what the agent did, as it
 * went. The first message of the person is the topic; a question asked with the tool reads with its choices.
 */
export function transcriptOf(record: Pick<DesignRecord, 'id' | 'repository' | 'topic' | 'kit' | 'model' | 'createdAt'>, messages: readonly DesignMessage[], title: string, finishedAt: string): string {
    const lines = [
        `# ${title}`,
        '',
        `- Topic: ${record.topic.replace(/\s+/g, ' ').trim()}`,
        `- Method: ${record.kit ?? 'design'}`,
        ...(record.model ? [`- Model: ${record.model}`] : []),
        `- Repository: ${record.repository}`,
        `- Session: ${record.id}, from ${record.createdAt} to ${finishedAt}`,
        ...usageLine(messages),
        '',
        'The conversation as it went, kept as it is: a source, never changed.',
    ];
    for (const message of messages) {
        if (message.role === 'user') {
            lines.push('', '---', '', '## Person', '', message.text);
            continue;
        }
        if (message.parts) {
            // In order, with the answers the person gave to each question (clicked, never a message).
            const said = message.parts.flatMap((part) => {
                if (part.type === 'text') return [part.text.trim()];
                if (part.type === 'tool') return [`- _${part.tool}_ ${part.title}`.trimEnd()];
                if (part.type === 'questions') return [questionsWithAnswers(part.questions, part.answers)];
                return [];
            }).filter(Boolean);
            if (said.length) lines.push('', '## Agent', '', said.join('\n\n'));
            continue;
        }
        if (!message.text && !message.tools.length) continue;
        lines.push('', '## Agent');
        if (message.tools.length) lines.push('', ...message.tools.map((tool) => `- _${tool.tool}_ ${tool.title}`.trimEnd()));
        if (message.text) lines.push('', message.text);
    }
    return `${lines.join('\n').trim()}\n`;
}

/** The questions asked with the tool, each followed by what the person answered (or that it was not). */
export function questionsWithAnswers(questions: readonly Question[], answers: readonly string[][] | undefined): string {
    return questions.map((question, index) => {
        const answer = answers?.[index];
        return `${questionText([question])}\n\n> **Answer:** ${answer?.length ? answer.join(', ') : '_(not answered)_'}`;
    }).join('\n\n');
}

/** The usage of a reply from what opencode keeps of the message. */
function usageOf(info: { cost?: number; modelID?: string; time?: { created?: number; completed?: number }; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }): DesignUsage {
    const { created, completed } = info.time ?? {};
    return {
        ...(info.modelID ? { model: info.modelID } : {}),
        input: info.tokens?.input ?? 0,
        output: info.tokens?.output ?? 0,
        reasoning: info.tokens?.reasoning ?? 0,
        cacheRead: info.tokens?.cache?.read ?? 0,
        cacheWrite: info.tokens?.cache?.write ?? 0,
        cost: info.cost ?? 0,
        ...(typeof created === 'number' && typeof completed === 'number' ? { seconds: Math.max(0, Math.round((completed - created) / 1000)) } : {}),
        ...(typeof created === 'number' ? { at: new Date(created).toISOString() } : {}),
    };
}

/** The line of the transcript with what the whole session cost, when it is known. */
function usageLine(messages: readonly DesignMessage[]): string[] {
    const used = messages.flatMap((message) => (message.usage ? [message.usage] : []));
    if (!used.length) return [];
    const sum = (key: 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite') => used.reduce((total, usage) => total + usage[key], 0);
    const cost = used.reduce((total, usage) => total + usage.cost, 0);
    return [`- Usage: ${sum('input') + sum('cacheRead') + sum('cacheWrite')} tokens in (${sum('cacheRead')} from the cache), ${sum('output')} out (${sum('reasoning')} reasoning), $${cost.toFixed(2)}`];
}

/** A part of a reply as the studio shows it again; the rest (step marks, empty reasoning) is left out. */
function messagePartOf(part: { id: string; type: string; text?: string; synthetic?: boolean; tool?: string; time?: { start?: number; end?: number }; state?: { input?: Record<string, unknown>; title?: string; metadata?: { answers?: unknown } } }): DesignMessagePart[] {
    if (part.type === 'reasoning') {
        const { start, end } = part.time ?? {};
        return part.text?.trim() ? [{ type: 'reasoning', id: part.id, text: part.text, ...(typeof start === 'number' && typeof end === 'number' ? { seconds: Math.max(0, Math.round((end - start) / 1000)) } : {}) }] : [];
    }
    if (part.type === 'text') return !part.synthetic && part.text?.trim() ? [{ type: 'text', id: part.id, text: part.text }] : [];
    if (part.type !== 'tool') return [];
    if (part.tool === 'question') {
        const answers = part.state?.metadata?.answers;
        return [{
            type: 'questions', id: part.id, questions: (part.state?.input?.questions ?? []) as Question[],
            ...(Array.isArray(answers) && answers.every((answer) => Array.isArray(answer)) ? { answers: (answers as unknown[][]).map((answer) => answer.map(String)) } : {}),
        }];
    }
    return [{ type: 'tool', id: part.id, tool: part.tool ?? '', title: toolTitle(part.state) }];
}

/** A short line for what a tool did: the file it wrote, the command it ran, the question it asked. */
function toolTitle(state?: { input?: Record<string, unknown>; title?: string }): string {
    const input = state?.input ?? {};
    const question = Array.isArray(input.questions) ? (input.questions as Question[])[0]?.header : undefined;
    return String(question || state?.title || input.filePath || input.path || input.command || input.pattern || input.name || '').slice(0, 160);
}

/** A question of the question tool of opencode: its choices, one or several. */
export type Question = { question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean };
type QuestionRequest = { id: string; sessionID: string; questions: Question[]; tool?: { messageID?: string } };

/** The questions as the chat shows them: each with its choices, numbered (an answer may be the number). */
export function questionText(questions: readonly Question[]): string {
    return questions.map((question) => [
        question.header ? `**${question.header}** · ${question.question}` : question.question,
        ...(question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` · ${option.description}` : ''}`),
    ].join('\n')).join('\n\n');
}

/**
 * The answers to the questions from one message: by number ("2", "1, 3" when several may be chosen) or
 * by the label of a choice, otherwise the words of the person as they are. Several questions take one
 * line each when the message has as many lines, else the whole message each.
 */
export function answersOf(questions: readonly Question[], text: string): string[][] {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    return questions.map((question, index) => {
        const said = questions.length > 1 && lines.length === questions.length ? lines[index] : text.trim();
        const options = question.options ?? [];
        const plain = (label: string) => label.toLowerCase().replace(/\s*\(recommended\)\s*$/, '').trim();
        const numbers = said.split(/\s*,\s*|\s+/).filter(Boolean);
        if (numbers.length && numbers.every((value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= options.length)
            && (question.multiple || numbers.length === 1)) {
            return numbers.map((value) => options[Number(value) - 1].label);
        }
        const named = options.find((option) => plain(option.label) === plain(said));
        return [named ? named.label : said];
    });
}

type OpencodeEvent = { type: string; properties?: Record<string, unknown> };

/**
 * An event of opencode as the studio sees it, when it is about this session; otherwise undefined.
 * `kinds` keeps the type of each part as it is announced: the text of the reply and the reasoning of
 * the model stream to the studio each as itself, never one into the other.
 */
export function designEventOf(event: OpencodeEvent, session: string, roles: Map<string, string>, kinds: Map<string, string> = new Map()): DesignEvent | undefined {
    const properties = (event.properties ?? {}) as Record<string, any>;
    switch (event.type) {
        case 'message.updated': {
            const info = properties.info;
            if (info?.sessionID !== session) return undefined;
            roles.set(info.id, info.role);
            // opencode puts the failure of the model (a 403, a quota) on the reply itself.
            return info.role === 'assistant' && info.error ? { type: 'error', message: errorText(info.error) } : undefined;
        }
        case 'message.part.delta':
            if (properties.sessionID !== session || properties.field !== 'text' || roles.get(properties.messageID) === 'user') return undefined;
            // The reasoning streams apart from the reply; a part not announced yet does not stream (its text comes whole when it is updated).
            if (kinds.get(properties.partID) === 'reasoning') return { type: 'reasoning', message: properties.messageID, part: properties.partID, text: String(properties.delta ?? ''), delta: true };
            if (kinds.get(properties.partID) !== 'text') return undefined;
            return { type: 'delta', message: properties.messageID, part: properties.partID, text: String(properties.delta ?? '') };
        case 'message.part.updated': {
            const part = properties.part;
            if (part?.sessionID !== session || roles.get(part.messageID) === 'user') return undefined;
            kinds.set(part.id, part.synthetic ? 'synthetic' : part.type);
            if (part.type === 'text' && !part.synthetic) return { type: 'text', message: part.messageID, part: part.id, text: String(part.text ?? '') };
            if (part.type === 'reasoning') {
                const { start, end } = part.time ?? {};
                return {
                    type: 'reasoning', message: part.messageID, part: part.id, text: String(part.text ?? ''),
                    ...(typeof start === 'number' && typeof end === 'number' ? { seconds: Math.max(0, Math.round((end - start) / 1000)) } : {}),
                };
            }
            if (part.type === 'tool') return { type: 'tool', message: part.messageID, part: part.id, tool: String(part.tool ?? ''), status: String(part.state?.status ?? ''), title: toolTitle(part.state) };
            return undefined;
        }
        case 'session.status':
            return properties.sessionID === session ? { type: 'busy', busy: properties.status?.type === 'busy' } : undefined;
        case 'session.idle':
            return properties.sessionID === session ? { type: 'busy', busy: false } : undefined;
        case 'session.error':
            return properties.sessionID === session ? { type: 'error', message: errorText(properties.error) } : undefined;
        default:
            return undefined;
    }
}
