import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { screenOf } from './screen.ts';

// The Claude subscriptions of an account scope (a person, or a whole tenant): their tokens live on this runner
// only, the one that uses them. The client starts the sign-in and passes the code of the person; the CLI itself,
// `claude setup-token`, runs here in the image of the harnesses, prints the page of Anthropic and the token, and
// the token is kept in a file of the scope (0600) no client ever reads. Clients know each subscription by its id,
// label and date.

/** The link of Anthropic `claude setup-token` prints, in its OSC 8 hyperlink or as text. */
const AUTHORIZE = /https:\/\/claude\.(?:com|ai)\/cai\/oauth\/authorize\?[^\s\u0007\u001b\]"']+/;
/** The long-lived token it prints once the code is accepted. */
export const CLAUDE_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
/** What the terminal adds around the text: colours, cursor moves, hyperlinks. */
const ESCAPES = /\u001b\][^\u0007]*\u0007|\u001b\]8;[^\u001b]*\u001b\\|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>]|\r/g;
/** How long after the code its Enter goes: in one write with a long code, the CLI takes it as pasted text, not as Enter. */
const ENTER_AFTER_MS = 500;

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LINK_WAIT_MS = 90_000;
const TOKEN_WAIT_MS = 60_000;
/** The id of a subscription. */
export const ACCOUNT_ID = /^[a-z0-9]{1,16}$/;

/** `refused`: Anthropic said no; `no-token`: the CLI printed no token in time (what it printed is the detail). */
export type LoginError = 'busy' | 'no-link' | 'no-session' | 'refused' | 'no-token';

/** Anything that may be a token or a code: never shown, whatever the screen looks like. */
const SECRET_LIKE = /sk-ant\S*|[A-Za-z0-9_\-#]{24,}/g;

/**
 * The last lines of the screen of the CLI, as a person reads them (the screen played as a terminal would):
 * what may be a token or a code masked, spinners and stars left out.
 */
export function cliSaid(output: string): string {
    // Lines with words only: the drawings of the welcome screen left out.
    return screenOf(output).filter((line) => /[A-Za-z]{3,}/.test(line)).slice(-4).join(' ')
        .replace(SECRET_LIKE, '***').replace(/\*{4,}\S*/g, '***').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-400);
}

/** The token on the screen of the CLI, as a person would read it (never in its bytes: the CLI skips cells already drawn). */
export const tokenOnScreen = (output: string): string | undefined => CLAUDE_TOKEN.exec(screenOf(output).join('\n'))?.[0];

type Session = { child: ChildProcess; output: string; done: boolean; timer: NodeJS.Timeout };
type Saved = Record<string, { token: string; at: string; label?: string }>;

/** The arguments of `docker` that run `claude setup-token` in a pseudo terminal, wide enough for its token on one line. */
export const setupTokenArgs = (image: string) =>
    ['run', '--rm', '-i', '-e', 'COLUMNS=1000', '-e', 'LINES=50', '--entrypoint', 'script', image, '-qfec', 'stty cols 1000 rows 50 2>/dev/null; claude setup-token', '/dev/null'];

/** Waits until `test` finds something in the output of the session, or `ms` pass, or the CLI exits. */
function waitFor(session: Session, test: (text: string) => string | undefined, ms: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        const found = test(session.output);
        if (found || session.done) return resolve(found);
        const check = () => {
            const value = test(session.output);
            if (value || session.done) finish(value);
        };
        const finish = (value: string | undefined) => {
            clearTimeout(timer);
            session.child.stdout?.off('data', check);
            session.child.off('exit', onExit);
            resolve(value);
        };
        const onExit = () => finish(test(session.output));
        const timer = setTimeout(() => finish(undefined), ms);
        session.child.stdout?.on('data', check);
        session.child.on('exit', onExit);
    });
}

export class ClaudeAccounts {
    private session?: Session;

    /**
     * `file`: where the tokens of the scope are kept (readable by the dispatcher only). `open`:
     * `claude setup-token` in a pseudo terminal; by default in a container of the image of the agents.
     */
    private readonly file: string;
    private readonly open: () => ChildProcess;
    private readonly now: () => Date;

    constructor(file: string, open: () => ChildProcess, now = () => new Date()) {
        this.file = file;
        this.open = open;
        this.now = now;
    }

    static docker(file: string, image: string, command = 'docker') {
        return new ClaudeAccounts(file, () => spawn(command, setupTokenArgs(image), { stdio: ['pipe', 'pipe', 'pipe'] }));
    }

    private read(): Saved {
        try {
            return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Saved : {};
        } catch {
            return {};
        }
    }

    private write(saved: Saved) {
        writeFileSync(`${this.file}.tmp`, JSON.stringify(saved, null, 2), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
    }

    /** The subscriptions kept here: their id and when; never their token. */
    list(): Array<{ id: string; at: string; label?: string }> {
        return Object.entries(this.read()).map(([id, { at, label }]) => ({ id, at, ...(label ? { label } : {}) }));
    }

    /** The token of each subscription, by id: for the harnesses, and to mask. */
    tokens(): Record<string, string> {
        return Object.fromEntries(Object.entries(this.read()).map(([id, { token }]) => [id, token]));
    }

    /** A token given by the person (run elsewhere): kept under its id. False when it is not one. */
    set(id: string, token: string, label?: string): boolean {
        if (!ACCOUNT_ID.test(id) || !new RegExp(`^${CLAUDE_TOKEN.source}$`).test(token.trim())) return false;
        const name = label?.trim().slice(0, 60);
        this.write({ ...this.read(), [id]: { token: token.trim(), at: this.now().toISOString(), ...(name ? { label: name } : {}) } });
        return true;
    }

    remove(id: string): boolean {
        const saved = this.read();
        if (!saved[id]) return false;
        delete saved[id];
        this.write(saved);
        return true;
    }

    private close() {
        const session = this.session;
        if (!session) return;
        this.session = undefined;
        clearTimeout(session.timer);
        if (!session.done) session.child.kill();
    }

    /** Starts the sign-in: the link of Anthropic the CLI printed, or why not. One at a time; a new one ends the last. */
    async start(): Promise<{ url: string } | { error: LoginError }> {
        this.close();
        const child = this.open();
        const session: Session = { child, output: '', done: false, timer: setTimeout(() => this.close(), LOGIN_TIMEOUT_MS) };
        this.session = session;
        const keep = (chunk: Buffer) => {
            session.output = (session.output + chunk.toString('utf8')).slice(-200_000);
        };
        child.stdout?.on('data', keep);
        child.stderr?.on('data', keep);
        child.on('exit', () => {
            session.done = true;
        });
        child.on('error', () => {
            session.done = true;
        });
        const url = await waitFor(session, (text) => AUTHORIZE.exec(text)?.[0], LINK_WAIT_MS);
        if (!url) {
            this.close();
            return { error: 'no-link' };
        }
        return { url };
    }

    /** The code the person got from Anthropic: written to the CLI, the token it prints kept as `id`; why not, else. */
    async code(id: string, code: string, label?: string): Promise<{ connected: true } | { error: LoginError; detail?: string }> {
        const session = this.session;
        if (!session || session.done) return { error: 'no-session' };
        if (!ACCOUNT_ID.test(id)) return { error: 'refused' };
        session.child.stdin?.write(code.trim());
        await new Promise((resolve) => setTimeout(resolve, ENTER_AFTER_MS));
        session.child.stdin?.write('\r');
        // The terminal is 1000 columns wide: the token is on one line, ended by a space or its line.
        const token = await waitFor(session, tokenOnScreen, TOKEN_WAIT_MS);
        const said = cliSaid(session.output);
        this.close();
        // What the CLI answered, for the person: Anthropic refusing the code, or something else.
        if (!token) return { error: /oauth error|wasn.t accepted|invalid|expired/i.test(said) ? 'refused' : 'no-token', ...(said ? { detail: said } : {}) };
        this.set(id, token, label);
        return { connected: true };
    }
}
