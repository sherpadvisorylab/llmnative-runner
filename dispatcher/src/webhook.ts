import { createHmac, timingSafeEqual } from 'node:crypto';

// The webhook of the App: signed with its secret, each delivery handled once.

export function validSignature(secret: string, body: string, signature: string | undefined): boolean {
    if (!signature?.startsWith('sha256=')) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The deliveries already seen, the most recent ones only. */
export class Deliveries {
    private readonly seen = new Set<string>();
    private readonly limit: number;
    constructor(limit = 2000) {
        this.limit = limit;
    }
    /** True the first time a delivery id is given. */
    first(id: string | undefined): boolean {
        if (!id) return true;
        if (this.seen.has(id)) return false;
        this.seen.add(id);
        if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value!);
        return true;
    }
}

export type WebhookAction =
    | { kind: 'issue'; repository: string; number: number }
    | { kind: 'repository'; repository: string; sources?: string[] }
    /** A new comment on an issue: maybe a person's answer. */
    | { kind: 'comment'; repository: string; number: number; comment: { body: string; user: { login: string; type: string } } }
    | { kind: 'none' };

/**
 * The sources a push brings to the default branch: the folders of `sources/` with files added, e.g.
 * `sources/conversations/2026-10-25-crm-bmad` (a file right under a kind, as a note, is its own source).
 */
export function sourcesOf(payload: { ref?: string; repository?: { default_branch?: string }; commits?: Array<{ added?: string[] }> }): string[] {
    if (!payload.repository?.default_branch || payload.ref !== `refs/heads/${payload.repository.default_branch}`) return [];
    const folders = new Set<string>();
    for (const path of (payload.commits ?? []).flatMap((commit) => commit.added ?? [])) {
        const parts = path.split('/');
        if (parts[0] !== 'sources' || parts.length < 3) continue;
        folders.add(parts.length >= 4 ? parts.slice(0, 3).join('/') : path);
    }
    return [...folders].sort();
}

/** What an event asks of the dispatcher. */
export function actionOf(event: string | undefined, payload: { action?: string; issue?: { number: number; pull_request?: unknown }; comment?: { body?: string; user?: { login?: string; type?: string } }; repository?: { full_name: string; default_branch?: string }; ref?: string; commits?: Array<{ added?: string[] }> }): WebhookAction {
    const repository = payload.repository?.full_name;
    if (!repository) return { kind: 'none' };
    if (event === 'issues' && payload.issue && !payload.issue.pull_request) {
        // A closed issue may unblock others: the whole repository is looked at again.
        if (payload.action === 'closed') return { kind: 'repository', repository };
        if (['opened', 'reopened', 'labeled', 'unlabeled', 'edited'].includes(payload.action ?? '')) return { kind: 'issue', repository, number: payload.issue.number };
    }
    if (event === 'issue_comment' && payload.action === 'created' && payload.issue && !payload.issue.pull_request && payload.comment) {
        const { body = '', user = {} } = payload.comment;
        return { kind: 'comment', repository, number: payload.issue.number, comment: { body, user: { login: user.login ?? '', type: user.type ?? '' } } };
    }
    // A new version of the workflow, or a pause, comes with a push; a source merged too.
    if (event === 'push') {
        const sources = sourcesOf(payload);
        return { kind: 'repository', repository, ...(sources.length ? { sources } : {}) };
    }
    return { kind: 'none' };
}
