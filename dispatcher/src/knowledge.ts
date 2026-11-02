// The knowledge of a project follows its CRs (docs/playbook-model.md §7): an entry an agent proposes in a
// CR is in force once that CR is closed done (its decision is in the code by then), refused once it is
// discarded; one digested from a design source (sources/…) is in force at once. Proposals are documents
// of the memory of the company (supermemory v5), next to the truth they change: the truth takes the CRs
// of the entry it changes as its origins, and the entry it changes stays in the history.

export type MemoryAccess = { url: string; apiKey: string };
type Metadata = Record<string, unknown>;
type MemoryDocument = { id: string; content?: string | null; metadata?: Metadata | null };
export type IssueState = 'open' | 'done' | 'discarded';

/** A namespace of supermemory v5 takes letters, digits, _ : and - only. */
const ns = (tag: string) => `/ns/${encodeURIComponent(tag.replace(/[^a-zA-Z0-9_:-]/g, '-'))}`;
const text = (metadata: Metadata | null | undefined, name: string) => (typeof metadata?.[name] === 'string' ? metadata[name] as string : undefined);
const keyOf = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'entry';
const stamp = (at: string) => at.replace(/[^0-9]/g, '').slice(0, 14);

/** CR numbers from a list (`38,97`). */
export const numbersOf = (value: string | undefined) => [...new Set((value ?? '').match(/\d+/g)?.map(Number).filter((n) => n > 0) ?? [])];

/** The CRs of a proposal: written on it, else named in its source (`issue #38`), never a path of a file. */
export const issuesOfProposal = (metadata: Metadata | null | undefined) => {
    const written = numbersOf(text(metadata, 'issues'));
    return written.length ? written : numbersOf((text(metadata, 'source') ?? '').match(/#\d+/g)?.join(','));
};

/** What becomes of a proposal: in force once its CRs are done, refused once one is discarded, else it waits. */
export function outcomeOf(metadata: Metadata | null | undefined, stateOf: (issue: number) => IssueState | undefined): 'confirm' | 'reject' | 'wait' {
    if (/^sources\//.test(text(metadata, 'source') ?? '') && !numbersOf(text(metadata, 'issues')).length) return 'confirm';
    const issues = issuesOfProposal(metadata);
    if (!issues.length) return 'wait';
    const states = issues.map(stateOf);
    if (states.includes('discarded')) return 'reject';
    return states.every((state) => state === 'done') ? 'confirm' : 'wait';
}

export function knowledgeKeeper(memory: MemoryAccess, fetchMemory: typeof fetch = fetch, now = () => new Date().toISOString()) {
    const base = memory.url.replace(/\/+$/, '');
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetchMemory(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memory.apiKey}`, 'x-api-key': memory.apiKey },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw Object.assign(new Error(`the memory answered ${response.status}`), { status: response.status });
        const raw = await response.text();
        return (raw ? JSON.parse(raw) : {}) as T;
    };
    const filter = (fields: Record<string, string>) => ({ operator: 'and', operands: Object.entries(fields).map(([field, value]) => ({ field, operator: 'eq', value })) });
    const list = async (namespace: string, fields: Record<string, string>) => {
        const found: MemoryDocument[] = [];
        for (let page = 1; page <= 20; page += 1) {
            const answer = await call<{ documents?: MemoryDocument[]; pagination?: { totalPages?: number } }>('POST', `${ns(namespace)}/list/documents?page=${page}&limit=100`, { filter: filter({ playbook: 'knowledge', ...fields }) });
            found.push(...(answer.documents ?? []));
            if (!answer.documents?.length || page >= (answer.pagination?.totalPages ?? 1)) break;
        }
        return found;
    };
    const read = (namespace: string, id: string) => call<MemoryDocument>('GET', `${ns(namespace)}/document/${encodeURIComponent(id)}`);
    const namespacesOf = (document: MemoryDocument, fallback: string) => {
        const named = document.metadata?.namespaces;
        return Array.isArray(named) && named.length ? named.map(String) : [fallback];
    };
    /** The document under this id in every namespace: an update where it exists, else a new one. */
    const write = async (id: string, content: string, metadata: Metadata, namespaces: string[]) => {
        await Promise.all(namespaces.map(async (namespace) => {
            try {
                await call('PATCH', `${ns(namespace)}/document/${encodeURIComponent(id)}`, { content, metadata });
            } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
                await call('POST', `${ns(namespace)}/document`, { content, metadata, id });
            }
        }));
    };
    const remove = (id: string, namespaces: string[]) => Promise.all(namespaces.map((namespace) => call('DELETE', `${ns(namespace)}/document`, { ids: [id] })));

    /** A proposal in force: its truth written, the entry it changes kept as superseded, the proposal removed. */
    const confirm = async (namespace: string, proposal: MemoryDocument) => {
        const metadata = proposal.metadata ?? {};
        const namespaces = namespacesOf(proposal, namespace);
        const kind = text(metadata, 'kind') ?? '';
        const key = text(metadata, 'key') ?? keyOf(text(metadata, 'title') ?? '');
        const project = text(metadata, 'project') ?? namespace;
        const id = `knowledge-${keyOf(project)}-${kind}-${key}`;
        const at = now();
        const [listed] = await list(namespace, { kind, key: text(metadata, 'replaces') ?? key, status: 'in_force' });
        const old = listed && await read(namespace, listed.id);
        const issues = [...new Set([...numbersOf(text(old?.metadata, 'issues')), ...issuesOfProposal(metadata)])];
        if (old) {
            // Under the same id the new truth takes its place: the old one is kept as a copy of its own.
            const kept = old.id === id ? `${id}-superseded-${stamp(at)}` : old.id;
            await write(kept, old.content ?? '', { ...old.metadata, status: 'superseded', at }, namespacesOf(old, namespace));
        }
        await write(id, proposal.content ?? '', { ...metadata, status: 'in_force', at, ...(issues.length ? { issues: issues.join(',') } : {}) }, namespaces);
        await remove(proposal.id, namespaces);
    };

    return {
        /**
         * The proposals of a project brought to what their CRs say: in force, refused, or left waiting.
         * `stateOf` reads a CR on GitHub (once per CR); what changed is told back.
         */
        async settle(namespace: string, stateOf: (issue: number) => Promise<IssueState | undefined>): Promise<{ confirmed: string[]; rejected: string[] }> {
            const proposals = await list(namespace, { status: 'proposed' });
            const states = new Map<number, IssueState | undefined>();
            const confirmed: string[] = [];
            const rejected: string[] = [];
            for (const listed of proposals) {
                const proposal = listed.metadata?.kind ? listed : await read(namespace, listed.id);
                for (const issue of issuesOfProposal(proposal.metadata)) if (!states.has(issue)) states.set(issue, await stateOf(issue));
                const outcome = outcomeOf(proposal.metadata, (issue) => states.get(issue));
                if (outcome === 'wait') continue;
                const full = proposal.content === undefined ? await read(namespace, proposal.id) : proposal;
                if (outcome === 'confirm') {
                    await confirm(namespace, full);
                    confirmed.push(full.id);
                } else {
                    await write(full.id, full.content ?? '', { ...full.metadata, status: 'rejected', at: now() }, namespacesOf(full, namespace));
                    rejected.push(full.id);
                }
            }
            return { confirmed, rejected };
        },
    };
}
