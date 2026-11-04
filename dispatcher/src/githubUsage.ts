import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GitHubApi } from './github.ts';

// What the dispatcher of a company asks of GitHub, counted by the hour, repository and item: the studio
// reads it (GET /<company>/usage) and shows it with its own requests and those of the agents (Statistics).
// The tokens of the turns are not counted here: the agents count their requests themselves.

type Bucket = { hour: string; repository: string; issue: number; requests: number };
const WEEK_HOURS = 24 * 7;
const keyOf = (bucket: Pick<Bucket, 'hour' | 'repository' | 'issue'>) => `${bucket.hour}|${bucket.repository}|${bucket.issue}`;

export function githubUsageCounter(file?: string, now = () => Date.now()) {
    const buckets = new Map<string, Bucket>();
    if (file) {
        try {
            for (const bucket of JSON.parse(readFileSync(file, 'utf8')) as Bucket[]) buckets.set(keyOf(bucket), bucket);
        } catch {
            // First start.
        }
    }
    let dirty = false;
    const hourOf = (time: number) => new Date(time).toISOString().slice(0, 13);
    const save = () => {
        if (!file || !dirty) return;
        dirty = false;
        const oldest = hourOf(now() - WEEK_HOURS * 3_600_000);
        for (const [key, bucket] of buckets) if (bucket.hour < oldest) buckets.delete(key);
        try {
            writeFileSync(`${file}.tmp`, JSON.stringify([...buckets.values()]));
            renameSync(`${file}.tmp`, file);
        } catch {
            // A count only.
        }
    };
    if (file) setInterval(save, 60_000).unref();
    return {
        /** One request, by its path (`/repos/owner/name/issues/12/…`). */
        record(path: string) {
            const repo = /^\/repos\/([^/]+\/[^/]+)(?:\/(?:issues|pulls)\/(\d+))?/.exec(path.replace(/^https:\/\/api\.github\.com/, ''));
            const bucket: Bucket = { hour: hourOf(now()), repository: repo?.[1]?.toLowerCase() ?? '', issue: Number(repo?.[2] ?? 0), requests: 0 };
            const key = keyOf(bucket);
            const kept = buckets.get(key) ?? bucket;
            kept.requests += 1;
            buckets.set(key, kept);
            dirty = true;
        },
        /** The requests of the last hours: total, by repository, by item, by hour. */
        summary(hours = 24) {
            const since = hourOf(now() - (hours - 1) * 3_600_000);
            const mine = [...buckets.values()].filter((bucket) => bucket.hour >= since);
            const group = (by: (bucket: Bucket) => string) => {
                const totals = new Map<string, number>();
                for (const bucket of mine) totals.set(by(bucket), (totals.get(by(bucket)) ?? 0) + bucket.requests);
                return [...totals.entries()].filter(([name]) => name).map(([name, requests]) => ({ name, requests })).sort((left, right) => right.requests - left.requests);
            };
            return {
                hours,
                total: mine.reduce((sum, bucket) => sum + bucket.requests, 0),
                byRepository: group((bucket) => bucket.repository),
                byItem: group((bucket) => (bucket.repository && bucket.issue ? `${bucket.repository}#${bucket.issue}` : '')).slice(0, 30),
                byHour: group((bucket) => bucket.hour).sort((left, right) => left.name.localeCompare(right.name)),
            };
        },
        save,
    };
}

export type GitHubUsageCounter = ReturnType<typeof githubUsageCounter>;

/** The GitHub of a company, its requests counted (the tokens of the turns apart: not requests of the dispatcher). */
export function countedGitHub(github: GitHubApi, counter: GitHubUsageCounter): GitHubApi {
    return {
        request: (method, path, body) => {
            counter.record(path);
            return github.request(method, path, body);
        },
        graphql: (query, variables) => {
            counter.record('/graphql');
            return github.graphql(query, variables);
        },
        turnToken: (repository, permissions) => github.turnToken(repository, permissions),
        ...(github.text ? { text: (path: string) => {
            counter.record(path);
            return github.text!(path);
        } } : {}),
    };
}
