import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJson } from './accounts.ts';

// The tenants of the runner, its keys and its pairing codes, in one JSON file of its data (0600). Keys are kept
// as their hash only: a key is seen once, when it is made.
//   - platform key (`rk_platform_…`): whoever connected the runner (a CMS, a studio): tenants and their keys;
//   - project key (`rk_…`): one tenant, with its permissions (complete, chat, accounts…, act-as-user).
// A pairing code (8 characters, 15 minutes, used once) gives a platform key: the installer prints one.
// A pairing request is the same done from the platform (a device flow): it asks, the admin of the runner approves
// in the console (the code shown on both sides), and the platform, asking again with its secret, gets the key.

export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PERMISSIONS = ['complete', 'chat', 'chat:tools', 'accounts', 'accounts:tenant', 'act-as-user', 'keys'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PAIRING_TTL_MS = 15 * 60_000;
/** Wrong codes in a row after which pairing waits: a code of 8 characters is not guessed in these. */
export const PAIRING_MAX_FAILURES = 10;
const PAIRING_LOCK_MS = 15 * 60_000;
export const PAIR_REQUEST_TTL_MS = 10 * 60_000;
/** Requests waiting at once, and made in ten minutes: anyone may ask, so asking is bounded. */
export const PAIR_REQUEST_MAX_PENDING = 20;
export const PAIR_REQUEST_MAX_RECENT = 60;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type TenantRecord = { id: string; name: string; createdAt: string };
export type KeyRecord = {
    id: string;
    kind: 'platform' | 'project';
    tenant?: string;
    name: string;
    hash: string;
    permissions: Permission[];
    createdAt: string;
    expiresAt: string | null;
};
/** A key as answers show it: never its hash. */
export type KeyView = Omit<KeyRecord, 'hash'>;
type State = { tenants: TenantRecord[]; keys: KeyRecord[]; pairing: Array<{ hash: string; expiresAt: string }> };

/** A pairing request as the admin sees it: never its secret. */
export type PairRequestView = { code: string; name: string; from?: string; createdAt: string; expiresAt: string };
type PairRequest = PairRequestView & { hash: string; status: 'pending' | 'approved' | 'denied' };
export type PairPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; key: string; record: KeyView };

export class RegistryError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export const hashOf = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const keyView = ({ hash: _hash, ...view }: KeyRecord): KeyView => view;

/** `ABCD-EFGH`, read aloud or typed without confusing 0/O or 1/I. */
export function newPairingCode(): string {
    const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
const normalCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class Registry {
    private state: State;
    private readonly file: string;
    private readonly now: () => number;
    private failures = 0;
    private lockedUntil = 0;
    /** Pairing requests live in memory: a restart drops them, the platform asks again. */
    private requests: PairRequest[] = [];
    private recent: number[] = [];

    constructor(file: string, now = () => Date.now()) {
        this.file = file;
        this.now = now;
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        let saved: Partial<State> = {};
        try {
            if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
        } catch {
            // A broken file: started empty, the old one overwritten at the first change.
        }
        this.state = { tenants: saved.tenants ?? [], keys: saved.keys ?? [], pairing: saved.pairing ?? [] };
    }

    private save() {
        writeJson(this.file, this.state);
    }

    tenants(): TenantRecord[] {
        return [...this.state.tenants];
    }

    tenant(id: string): TenantRecord | undefined {
        return this.state.tenants.find((tenant) => tenant.id === id);
    }

    createTenant(id: string, name?: string): TenantRecord {
        if (!TENANT_ID.test(id)) throw new RegistryError('invalid', 400);
        if (this.tenant(id)) throw new RegistryError('exists', 409);
        const tenant = { id, name: (name ?? '').trim().slice(0, 100) || id, createdAt: new Date(this.now()).toISOString() };
        this.state.tenants.push(tenant);
        this.save();
        return tenant;
    }

    /** Takes a tenant off, with its keys. */
    removeTenant(id: string): boolean {
        const before = this.state.tenants.length;
        this.state.tenants = this.state.tenants.filter((tenant) => tenant.id !== id);
        if (this.state.tenants.length === before) return false;
        this.state.keys = this.state.keys.filter((key) => key.tenant !== id);
        this.save();
        return true;
    }

    /** A new key: its record, and the key itself, shown this once. */
    createKey(input: { kind: 'platform' | 'project'; tenant?: string; name?: string; permissions?: Permission[]; expiresAt?: string | null }): { key: string; record: KeyView } {
        if (input.kind === 'project' && (!input.tenant || !this.tenant(input.tenant))) throw new RegistryError('no-tenant', 404);
        const permissions: Permission[] = input.kind === 'platform' ? [] : [...new Set<Permission>(input.permissions ?? ['complete', 'chat'])];
        if (!permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission))) throw new RegistryError('invalid', 400);
        if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw new RegistryError('invalid', 400);
        const key = `${input.kind === 'platform' ? 'rk_platform_' : 'rk_'}${token()}`;
        const record: KeyRecord = {
            id: token(6),
            kind: input.kind,
            ...(input.kind === 'project' ? { tenant: input.tenant } : {}),
            name: (input.name ?? '').trim().slice(0, 100) || (input.kind === 'platform' ? 'platform' : 'project'),
            hash: hashOf(key),
            permissions,
            createdAt: new Date(this.now()).toISOString(),
            expiresAt: input.expiresAt ?? null,
        };
        this.state.keys.push(record);
        this.save();
        return { key, record: keyView(record) };
    }

    keys(filter: { kind?: 'platform' | 'project'; tenant?: string } = {}): KeyView[] {
        return this.state.keys.filter((key) => (!filter.kind || key.kind === filter.kind) && (!filter.tenant || key.tenant === filter.tenant)).map(keyView);
    }

    revokeKey(id: string, tenant?: string): boolean {
        const before = this.state.keys.length;
        this.state.keys = this.state.keys.filter((key) => !(key.id === id && (!tenant || key.tenant === tenant)));
        if (this.state.keys.length === before) return false;
        this.save();
        return true;
    }

    /** The key of a request, by its bearer: its record, `expired`, or nothing (unknown and none look the same). */
    authenticate(bearer: string): KeyRecord | 'expired' | undefined {
        if (!/^rk_[A-Za-z0-9_-]{20,80}$/.test(bearer)) return undefined;
        const given = Buffer.from(hashOf(bearer), 'hex');
        const found = this.state.keys.find((key) => {
            const expected = Buffer.from(key.hash, 'hex');
            return expected.length === given.length && timingSafeEqual(expected, given);
        });
        if (!found) return undefined;
        if (found.expiresAt && Date.parse(found.expiresAt) <= this.now()) return 'expired';
        return found;
    }

    /** A pairing code, valid for 15 minutes and once. */
    createPairing(): { code: string; expiresAt: string } {
        const code = newPairingCode();
        const expiresAt = new Date(this.now() + PAIRING_TTL_MS).toISOString();
        this.state.pairing = [...this.state.pairing.filter((entry) => Date.parse(entry.expiresAt) > this.now()), { hash: hashOf(normalCode(code)), expiresAt }];
        this.save();
        return { code, expiresAt };
    }

    /** A pairing code given back: a new platform key, or why not. */
    pair(code: string, name?: string): { key: string; record: KeyView } {
        if (this.now() < this.lockedUntil) throw new RegistryError('locked', 429);
        const hash = hashOf(normalCode(code));
        const entry = this.state.pairing.find((item) => item.hash === hash && Date.parse(item.expiresAt) > this.now());
        if (!entry) {
            this.failures += 1;
            if (this.failures >= PAIRING_MAX_FAILURES) {
                this.lockedUntil = this.now() + PAIRING_LOCK_MS;
                this.failures = 0;
            }
            throw new RegistryError('bad code', 401);
        }
        this.failures = 0;
        this.state.pairing = this.state.pairing.filter((item) => item !== entry);
        return this.createKey({ kind: 'platform', name: name || 'paired' });
    }

    private liveRequests(): PairRequest[] {
        this.requests = this.requests.filter((item) => Date.parse(item.expiresAt) > this.now());
        return this.requests;
    }

    /** A platform asks to connect: a secret for it (to ask again), a code to show on both sides. */
    requestPairing(name: string, from?: string): { request: string; code: string; expiresAt: string } {
        const at = this.now();
        this.recent = this.recent.filter((time) => time > at - PAIR_REQUEST_TTL_MS);
        if (this.liveRequests().filter((item) => item.status === 'pending').length >= PAIR_REQUEST_MAX_PENDING || this.recent.length >= PAIR_REQUEST_MAX_RECENT) throw new RegistryError('busy', 429);
        this.recent.push(at);
        const request = `pr_${token(32)}`;
        const code = newPairingCode();
        const expiresAt = new Date(at + PAIR_REQUEST_TTL_MS).toISOString();
        this.requests.push({
            hash: hashOf(request),
            code,
            name: name.trim().slice(0, 80) || 'platform',
            ...(from ? { from: from.slice(0, 64) } : {}),
            createdAt: new Date(at).toISOString(),
            expiresAt,
            status: 'pending',
        });
        return { request, code, expiresAt };
    }

    /** The requests waiting for the admin. */
    pairingRequests(): PairRequestView[] {
        return this.liveRequests().filter((item) => item.status === 'pending').map(({ code, name, from, createdAt, expiresAt }) => ({ code, name, ...(from ? { from } : {}), createdAt, expiresAt }));
    }

    /** The admin answers a request, found by its code. */
    answerPairing(code: string, approve: boolean): PairRequestView {
        const wanted = normalCode(code);
        const found = this.liveRequests().find((item) => item.status === 'pending' && normalCode(item.code) === wanted);
        if (!found) throw new RegistryError('not found', 404);
        found.status = approve ? 'approved' : 'denied';
        return { code: found.code, name: found.name, ...(found.from ? { from: found.from } : {}), createdAt: found.createdAt, expiresAt: found.expiresAt };
    }

    /** The platform asks again with its secret: approved, the key, once. */
    pollPairing(request: string): PairPoll {
        const hash = hashOf(request);
        const found = this.liveRequests().find((item) => timingSafeEqual(Buffer.from(item.hash), Buffer.from(hash)));
        if (!found) return { status: 'expired' };
        if (found.status === 'pending') return { status: 'pending' };
        this.requests = this.requests.filter((item) => item !== found);
        if (found.status === 'denied') return { status: 'denied' };
        return { status: 'approved', ...this.createKey({ kind: 'platform', name: found.name }) };
    }
}
