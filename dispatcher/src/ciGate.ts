// The CI gate (docs/playbook-model.md §8.2): an item handed over through a route that passes the gate
// waits (`needs:ci`) for the CI on the commit it was handed over with, which the command wrote in the
// marker of the move. The dispatcher reads the runs of GitHub Actions on that commit and moves it: on to
// the agent of the route when they passed, back to the agent that left when one failed (with the lines
// that failed), to a person when none arrives in time. A repository without Actions passes the gate.

const MARKER = /<!-- playbook (\{[^\n]*?\}) -->/;

export type GateComment = { body?: string | null; created_at?: string };

/** The move into the gate an item waits on: its route, who left it, where it goes, the commit and when. */
export type PendingGate = { route: string; from: string; to: string; status: string; sha: string; at: number };

const markerOf = (body: string | null | undefined): Record<string, unknown> | null => {
    const data = MARKER.exec(body ?? '')?.[1];
    if (!data) return null;
    try {
        return JSON.parse(data) as Record<string, unknown>;
    } catch {
        return null;
    }
};

/** The last move of the item when it is a hand-over into the gate not settled yet; null otherwise. */
export function pendingGate(comments: readonly GateComment[]): PendingGate | null {
    for (let index = comments.length - 1; index >= 0; index -= 1) {
        const marker = markerOf(comments[index]!.body);
        if (!marker || typeof marker.event !== 'string') continue;
        if (marker.event === 'note' || marker.event === 'report') continue;
        if (marker.event !== 'leave' || marker.gate !== 'ci' || typeof marker.sha !== 'string') return null;
        return {
            route: String(marker.route ?? ''),
            from: String(marker.agent ?? ''),
            to: String(marker.to ?? ''),
            status: String(marker.status ?? ''),
            sha: marker.sha,
            at: Date.parse(comments[index]!.created_at ?? '') || 0,
        };
    }
    return null;
}

/** A run of GitHub Actions on a commit, as its API gives it. */
export type WorkflowRun = { id: number; name?: string | null; status?: string | null; conclusion?: string | null; html_url?: string };
/** A job of a run, its steps and when it ran. */
export type RunJob = { id: number; name?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; html_url?: string; steps?: Array<{ name?: string; conclusion?: string | null }> };

export type GateVerdict = 'wait' | 'passed' | 'failed' | 'none' | 'timeout';

/** What failed: a run that ended badly. Success, neutral and skipped pass. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/**
 * Where the gate stands: no Actions in the repository (`none`), runs still going or not started yet
 * (`wait`, until the timeout), every run ended well (`passed`), one ended badly (`failed`).
 */
export function gateVerdict(runs: readonly WorkflowRun[], workflows: number, waitedMs: number, timeoutMinutes: number): GateVerdict {
    if (!runs.length) {
        if (workflows === 0) return 'none';
        return waitedMs > timeoutMinutes * 60_000 ? 'timeout' : 'wait';
    }
    if (runs.some((run) => run.status !== 'completed')) return waitedMs > timeoutMinutes * 60_000 ? 'timeout' : 'wait';
    return runs.some((run) => FAILED.has(String(run.conclusion))) ? 'failed' : 'passed';
}

/** The minutes GitHub counts for the jobs: each rounded up to the minute. */
export function billedMinutes(jobs: readonly RunJob[]): number {
    return jobs.reduce((total, job) => {
        const started = Date.parse(job.started_at ?? '');
        const completed = Date.parse(job.completed_at ?? '');
        if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return total;
        return total + Math.max(1, Math.ceil((completed - started) / 60_000));
    }, 0);
}

/** The lines of a log that say what failed: the errors and failures, without the timestamps; the last ones. */
export function failingLines(log: string, limit = 25): string[] {
    const lines = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(/\u001b\[[0-9;]*m/g, '').trim());
    const wanted = lines.filter((line) => /##\[error\]|\berror\b|\bfail(ed|ure|ing)?\b|✗|✖|×|AssertionError|Expected|Received|exit code [1-9]/i.test(line) && !/^##\[group\]/.test(line));
    return (wanted.length ? wanted : lines.filter(Boolean)).slice(-limit).map((line) => line.replace(/^##\[error\]/, '').slice(0, 300));
}

/** What a failed CI says to the agent: each job that failed, its step, its lines, its link. */
export function failureReport(failed: ReadonlyArray<{ job: RunJob; lines: string[] }>): string {
    if (!failed.length) return 'The CI failed, but no job says why: open its run on GitHub.';
    return failed.map(({ job, lines }) => {
        const step = job.steps?.find((candidate) => FAILED.has(String(candidate.conclusion)))?.name;
        return [
            `**${job.name ?? 'job'}**${step ? ` · step "${step}"` : ''}${job.html_url ? ` · [log](${job.html_url})` : ''}`,
            ...(lines.length ? ['', '```', ...lines, '```'] : []),
        ].join('\n');
    }).join('\n\n');
}
