import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GitHubApi } from './github.ts';
import type { Log } from './dispatcher.ts';

// The design sessions of a company: a person and the design agent (opencode with the design skills)
// talk on a project, the agent writes documents, and at the end the dispatcher puts them in a pull
// request as a source (`sources/<date>-<slug>/`). One container per session, reached over HTTP with
// a password of its own. A session left alone is paused (its container stopped, opencode keeps the
// conversation on disk) and wakes up at the next message; after some days it is removed.

/** What the dispatcher needs of Docker for the sessions. */
export interface DesignHost {
    /** Starts the container of a session; resolves with the address of its opencode. */
    start(spec: { name: string; env: Record<string, string> }): Promise<string>;
    /** Starts a stopped container again; resolves with its address. */
    wake(name: string): Promise<string>;
    pause(name: string): Promise<void>;
    remove(name: string): Promise<void>;
    /** The documents the session wrote (`playbook-design-files` in the container). */
    files(name: string): Promise<DesignFile[]>;
    /** The last lines the container printed, to say why a session did not start. */
    logs(name: string): Promise<string>;
}

export type DesignFile = { path: string; content: string };

export type DesignStatus = 'starting' | 'active' | 'paused' | 'finished' | 'cancelled' | 'failed';

interface DesignRecord {
    id: string;
    repository: string;
    topic: string;
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
    pullRequest?: { number: number; url: string; branch: string };
    error?: string;
}

/** A session as the studio sees it: no container, no password. */
export type DesignView = Pick<DesignRecord, 'id' | 'repository' | 'topic' | 'model' | 'status' | 'createdAt' | 'lastActive' | 'pullRequest' | 'error'>;

/** A message of the conversation, for the studio. */
export type DesignMessage = { id: string; role: 'user' | 'assistant'; text: string; tools: Array<{ tool: string; title: string }> };

/** What happens in a session, as it happens. */
export type DesignEvent =
    | { type: 'delta'; message: string; part: string; text: string }
    | { type: 'text'; message: string; part: string; text: string }
    | { type: 'tool'; message: string; part: string; tool: string; status: string; title: string }
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
    /** The skill the session starts with. */
    command?: string;
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

const view = ({ id, repository, topic, model, status, createdAt, lastActive, pullRequest, error }: DesignRecord): DesignView => ({ id, repository, topic, model, status, createdAt, lastActive, ...(pullRequest ? { pullRequest } : {}), ...(error ? { error } : {}) });

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
        return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view);
    }

    get(id: string): DesignView | undefined {
        const record = this.records.get(id);
        return record && view(record);
    }

    /** Starts a session on a repository of the company, with what it is about. */
    async start(input: { repository?: unknown; topic?: unknown; model?: unknown }): Promise<DesignView> {
        const repository = String(input.repository ?? '');
        const topic = String(input.topic ?? '').trim();
        const model = input.model ? String(input.model) : undefined;
        if (!REPOSITORY.test(repository)) throw new DesignError('repository must be owner/name', 400);
        if (!topic) throw new DesignError('topic is required', 400);
        if (model && !MODEL.test(model)) throw new DesignError('model must be provider/model', 400);
        const id = randomBytes(4).toString('hex');
        if (!this.options.slots.take(`${this.options.company}/${id}`)) throw new DesignError('too many design sessions on this runner: try again later', 429);
        const at = new Date(this.now()).toISOString();
        const record: DesignRecord = {
            id, repository, topic, model, status: 'starting', createdAt: at, lastActive: at,
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
    async send(id: string, input: { text?: unknown }): Promise<void> {
        const text = String(input.text ?? '').trim();
        if (!text) throw new DesignError('text is required', 400);
        const record = await this.awake(id);
        record.lastActive = new Date(this.now()).toISOString();
        if (!record.opened) {
            record.opened = true;
            this.save();
            // opencode answers this call when the round is over: a wait longer than fetch allows for
            // the headers is no failure, the round goes on and its events arrive.
            void this.call(record, 'POST', `/session/${record.session}/command`, {
                command: this.options.command ?? 'grill-with-docs',
                arguments: text,
                ...(record.model ? { model: record.model } : {}),
            }, { timeout: 0 }).catch((error: Error & { cause?: { code?: string } }) => {
                if (error.cause?.code !== 'UND_ERR_HEADERS_TIMEOUT') this.emit(id, { type: 'error', message: error.message });
            });
            return;
        }
        this.save();
        await this.call(record, 'POST', `/session/${record.session}/prompt_async`, {
            parts: [{ type: 'text', text }],
            ...(record.model ? { model: { providerID: record.model.split('/')[0], modelID: record.model.slice(record.model.indexOf('/') + 1) } } : {}),
        });
    }

    /** The conversation so far, from opencode; the first message of the person is the topic. */
    async messages(id: string): Promise<DesignMessage[]> {
        const record = this.find(id);
        if (record.status !== 'active') return [];
        type Part = { id: string; type: string; text?: string; synthetic?: boolean; tool?: string; state?: { input?: Record<string, unknown>; title?: string } };
        const raw = await this.call<Array<{ info: { id: string; role: 'user' | 'assistant' }; parts: Part[] }>>(record, 'GET', `/session/${record.session}/message`);
        return raw.map((message, index) => ({
            id: message.info.id,
            role: message.info.role,
            text: message.info.role === 'user' && index === 0
                ? record.topic
                : message.parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join('\n\n').trim(),
            tools: message.parts.filter((part) => part.type === 'tool').map((part) => ({ tool: part.tool ?? '', title: toolTitle(part.state) })),
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
        const files = await this.options.host.files(record.container);
        if (!files.length) throw new DesignError('the session has not written any document yet', 409);
        const { github } = this.options;
        const repo = `/repos/${record.repository}`;
        const date = new Date(this.now()).toISOString().slice(0, 10);
        const name = `${date}-${designSlug(title)}`;
        const folder = `sources/${name}`;
        const base = (await github.request<{ default_branch: string }>('GET', repo)).default_branch;
        const head = (await github.request<{ object: { sha: string } }>('GET', `${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
        const baseTree = (await github.request<{ tree: { sha: string } }>('GET', `${repo}/git/commits/${head}`)).tree.sha;
        const tree = await github.request<{ sha: string }>('POST', `${repo}/git/trees`, {
            base_tree: baseTree,
            tree: files.map((file) => ({ path: `${folder}/${file.path}`, mode: '100644', type: 'blob', content: file.content })),
        });
        const commit = await github.request<{ sha: string }>('POST', `${repo}/git/commits`, { message: `Design: ${title}`, tree: tree.sha, parents: [head] });
        const branch = `design/${name}-${record.id}`;
        await github.request('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        const pull = await github.request<{ number: number; html_url: string }>('POST', `${repo}/pulls`, {
            title: `Design: ${title}`,
            head: branch,
            base,
            body: [
                `Documents written in a design session on "${record.topic}".`,
                '',
                `They go to \`${folder}/\` as a **source**: read only, archived as they are. Once merged, the analyst turns them into Epics with their user stories, and what is decided goes to the memory of the company.`,
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

    /** Pauses the sessions left alone and removes the ones paused for too long. */
    async sweep(): Promise<void> {
        const now = this.now();
        for (const record of this.records.values()) {
            const idle = now - Date.parse(record.lastActive);
            if (record.status === 'active' && idle > this.options.idleMinutes * 60_000 && !(await this.busy(record))) {
                this.upstream.get(record.id)?.abort();
                this.upstream.delete(record.id);
                await this.options.host.pause(record.container);
                record.status = 'paused';
                this.options.slots.release(this.slot(record));
                this.save();
                this.emit(record.id, { type: 'status', design: view(record) });
                this.options.log('design paused', { design: record.id });
            } else if (record.status === 'paused' && idle > this.options.keepDays * 86_400_000) {
                await this.close(record, 'cancelled');
                this.options.log('design removed after its days', { design: record.id });
            }
        }
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
            if (!this.options.slots.take(this.slot(record))) throw new DesignError('too many design sessions on this runner: try again later', 429);
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
                        const event = designEventOf(JSON.parse(data), record.session ?? '', roles);
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

/** A short line for what a tool did: the file it wrote, the command it ran. */
function toolTitle(state?: { input?: Record<string, unknown>; title?: string }): string {
    const input = state?.input ?? {};
    return String(state?.title || input.filePath || input.path || input.command || input.pattern || input.name || '').slice(0, 160);
}

type OpencodeEvent = { type: string; properties?: Record<string, unknown> };

/** An event of opencode as the studio sees it, when it is about this session; otherwise undefined. */
export function designEventOf(event: OpencodeEvent, session: string, roles: Map<string, string>): DesignEvent | undefined {
    const properties = (event.properties ?? {}) as Record<string, any>;
    switch (event.type) {
        case 'message.updated': {
            const info = properties.info;
            if (info?.sessionID === session) roles.set(info.id, info.role);
            return undefined;
        }
        case 'message.part.delta':
            if (properties.sessionID !== session || properties.field !== 'text' || roles.get(properties.messageID) === 'user') return undefined;
            return { type: 'delta', message: properties.messageID, part: properties.partID, text: String(properties.delta ?? '') };
        case 'message.part.updated': {
            const part = properties.part;
            if (part?.sessionID !== session || roles.get(part.messageID) === 'user') return undefined;
            if (part.type === 'text' && !part.synthetic) return { type: 'text', message: part.messageID, part: part.id, text: String(part.text ?? '') };
            if (part.type === 'tool') return { type: 'tool', message: part.messageID, part: part.id, tool: String(part.tool ?? ''), status: String(part.state?.status ?? ''), title: toolTitle(part.state) };
            return undefined;
        }
        case 'session.status':
            return properties.sessionID === session ? { type: 'busy', busy: properties.status?.type === 'busy' } : undefined;
        case 'session.idle':
            return properties.sessionID === session ? { type: 'busy', busy: false } : undefined;
        case 'session.error':
            return properties.sessionID === session ? { type: 'error', message: String(properties.error?.data?.message ?? properties.error?.name ?? 'error') } : undefined;
        default:
            return undefined;
    }
}
