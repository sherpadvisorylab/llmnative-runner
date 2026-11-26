import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Scope } from './accounts.ts';
import type { ChatHost } from './chats.ts';
import type { RunnerConfig } from './config.ts';
import type { Credit } from './credit.ts';
import type { Log } from './runtime.ts';

// Modules: what a product builds on the runner without forking it (the turns on the issues of Playbook, its design
// sessions). An image `FROM llmnative-runner` adds its modules and names them in RUNNER_MODULES; each one gets the
// runner as it is (tenants, their accounts and credit, the containers) and serves:
//   - /v1/modules/<name>/…  with a key, always for one tenant (a project key, or a platform key of its project with
//     X-Runner-Tenant); a project key needs the permission `modules`;
//   - /hooks/<name>/…       public (a webhook of GitHub): the module checks its own signature.
// A module keeps its data in DATA_DIR/modules/<name>. Nothing of a module reaches the core: a module that fails to
// start is left out, said in the log, and the runner goes on.

export const MODULE_NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** Who a request of a module is for. */
export type ModuleScope = { tenant: string; user?: string; caller: 'admin' | 'platform' | 'project' };

/** What a module gets of the runner. */
export interface ModuleContext {
    readonly name: string;
    /** DATA_DIR/modules/<name>, 0700. */
    readonly dataDir: string;
    readonly config: RunnerConfig;
    readonly log: Log;
    /** The containers of the harnesses (start, exec, write, remove), as the chats use them. */
    readonly host: ChatHost;
    /** The tenants of the runner. */
    tenants(): string[];
    /** The keys of a scope for a harness (those of the person first, then the tenant's), and the accounts in order. */
    keysFor(scope: Scope): { env: Record<string, string>; accounts: Record<string, Array<{ id: string; label?: string }>> };
    /** The accounts out of credit of a tenant, shared with its chats and answers. */
    credit(tenant: string): Credit | undefined;
}

export interface RunnerModule {
    name: string;
    start?(context: ModuleContext): void | Promise<void>;
    stop?(): void | Promise<void>;
    /** A request under /v1/modules/<name><path>; undefined: not found. */
    handle?(request: Request, scope: ModuleScope, path: string): Promise<Response | undefined>;
    /** A public request under /hooks/<name><path>; undefined: not found. */
    hook?(request: Request, path: string): Promise<Response | undefined>;
    /** A tenant taken off the runner: what the module keeps of it goes too. */
    removeTenant?(tenant: string): void | Promise<void>;
}

/** The modules named in RUNNER_MODULES (files or packages), each exporting `default` or `module`. */
export async function loadModules(specs: string[], log: Log): Promise<RunnerModule[]> {
    const modules: RunnerModule[] = [];
    for (const spec of specs) {
        try {
            const target = spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(spec).href : spec;
            const loaded = await import(target) as { default?: RunnerModule; module?: RunnerModule };
            const module = loaded.default ?? loaded.module;
            if (!module || !MODULE_NAME.test(module.name ?? '')) throw new Error('no module exported, or a name that is not one');
            if (modules.some((other) => other.name === module.name)) throw new Error(`a module ${module.name} already`);
            modules.push(module);
        } catch (error) {
            log('module not loaded', { module: spec, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return modules;
}

/** Starts each module with its context; one that fails is left out. */
export async function startModules(modules: RunnerModule[], context: (name: string) => Omit<ModuleContext, 'name' | 'dataDir'>, dataDir: string, log: Log): Promise<RunnerModule[]> {
    const started: RunnerModule[] = [];
    for (const module of modules) {
        const dir = join(dataDir, 'modules', module.name);
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            await module.start?.({ ...context(module.name), name: module.name, dataDir: dir });
            started.push(module);
            log('module started', { module: module.name });
        } catch (error) {
            log('module not started', { module: module.name, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return started;
}

const MAX_MODULE_BODY = 20 * 1024 * 1024;

/** The request of node as a Request of the web, its body read whole (up to 20 MB). */
export async function toWebRequest(request: IncomingMessage, url: URL): Promise<Request> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
    }
    const method = request.method ?? 'GET';
    let body: Buffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
            size += (chunk as Buffer).length;
            if (size > MAX_MODULE_BODY) throw Object.assign(new Error('too large'), { status: 413 });
            chunks.push(chunk as Buffer);
        }
        body = Buffer.concat(chunks);
    }
    const controller = new AbortController();
    request.on('close', () => controller.abort());
    return new Request(url, { method, headers, ...(body && body.length ? { body } : {}), signal: controller.signal });
}

/** A Response of the web sent on the response of node, streamed as it comes. */
export async function sendWebResponse(response: ServerResponse, answer: Response): Promise<void> {
    const headers: Record<string, string> = {};
    answer.headers.forEach((value, name) => { headers[name] = value; });
    response.writeHead(answer.status, headers);
    if (!answer.body) return void response.end();
    const reader = answer.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(Buffer.from(value));
        }
    } catch {
        // The client went away: what came is what it gets.
    }
    response.end();
}
