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
    | { kind: 'repository'; repository: string }
    | { kind: 'none' };

/** What an event asks of the dispatcher. */
export function actionOf(event: string | undefined, payload: { action?: string; issue?: { number: number; pull_request?: unknown }; repository?: { full_name: string } }): WebhookAction {
    const repository = payload.repository?.full_name;
    if (!repository) return { kind: 'none' };
    if (event === 'issues' && payload.issue && !payload.issue.pull_request) {
        // A closed issue may unblock others: the whole repository is looked at again.
        if (payload.action === 'closed') return { kind: 'repository', repository };
        if (['opened', 'reopened', 'labeled', 'unlabeled', 'edited'].includes(payload.action ?? '')) return { kind: 'issue', repository, number: payload.issue.number };
    }
    // A new version of the workflow, or a pause, comes with a push.
    if (event === 'push') return { kind: 'repository', repository };
    return { kind: 'none' };
}
