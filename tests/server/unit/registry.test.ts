// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAIRING_MAX_FAILURES, Registry, RegistryError, newPairingCode } from '../../../server/src/registry.ts';

const fresh = (now = () => Date.now()) => new Registry(join(mkdtempSync(join(tmpdir(), 'runner-')), 'registry.json'), now);

describe('the registry', () => {
    it('keeps tenants and their keys, by hash only, and finds a key by its bearer', () => {
        const registry = fresh();
        registry.createTenant('acme', 'Acme');
        const { key, record } = registry.createKey({ kind: 'project', tenant: 'acme', permissions: ['complete', 'act-as-user'] });
        expect(key).toMatch(/^rk_[A-Za-z0-9_-]{20,}$/);
        expect(JSON.stringify(registry.keys())).not.toContain(key);
        const found = registry.authenticate(key);
        expect(found && found !== 'expired' ? found.id : null).toBe(record.id);
        expect(registry.authenticate(`${key}x`)).toBeUndefined();
        expect(registry.authenticate('not a key')).toBeUndefined();
    });

    it('a key past its end is expired; a revoked one is unknown; a tenant removed takes its keys', () => {
        let now = Date.parse('2026-11-25T10:00:00Z');
        const registry = fresh(() => now);
        registry.createTenant('acme');
        const ending = registry.createKey({ kind: 'project', tenant: 'acme', expiresAt: '2026-11-25T11:00:00Z' });
        const other = registry.createKey({ kind: 'project', tenant: 'acme' });
        now += 2 * 3600_000;
        expect(registry.authenticate(ending.key)).toBe('expired');
        registry.revokeKey(other.record.id, 'acme');
        expect(registry.authenticate(other.key)).toBeUndefined();
        const third = registry.createKey({ kind: 'project', tenant: 'acme' });
        registry.removeTenant('acme');
        expect(registry.authenticate(third.key)).toBeUndefined();
    });

    it('survives a restart: tenants and keys read back from its file', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'runner-')), 'registry.json');
        const first = new Registry(file);
        first.createTenant('acme');
        const { key } = first.createKey({ kind: 'platform', name: 'cms' });
        const second = new Registry(file);
        expect(second.tenant('acme')?.id).toBe('acme');
        expect(second.authenticate(key)).toMatchObject({ kind: 'platform', name: 'cms' });
    });

    it('refuses wrong tenant ids, a key for an unknown tenant, unknown permissions', () => {
        const registry = fresh();
        expect(() => registry.createTenant('Acme!')).toThrow(RegistryError);
        registry.createTenant('acme');
        expect(() => registry.createTenant('acme')).toThrow('exists');
        expect(() => registry.createKey({ kind: 'project', tenant: 'nobody' })).toThrow('no-tenant');
        expect(() => registry.createKey({ kind: 'project', tenant: 'acme', permissions: ['root' as never] })).toThrow('invalid');
    });

    it('a pairing code gives a platform key once, typed in any case or spacing, within 15 minutes', () => {
        let now = Date.parse('2026-11-25T10:00:00Z');
        const registry = fresh(() => now);
        const { code } = registry.createPairing();
        expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        const paired = registry.pair(` ${code.toLowerCase().replace('-', ' ')} `, 'cms');
        expect(paired.record).toMatchObject({ kind: 'platform', name: 'cms' });
        expect(() => registry.pair(code)).toThrow('bad code');
        const late = registry.createPairing();
        now += 16 * 60_000;
        expect(() => registry.pair(late.code)).toThrow('bad code');
    });

    it('after too many wrong codes pairing waits, even for a right one', () => {
        const registry = fresh();
        const { code } = registry.createPairing();
        for (let index = 0; index < PAIRING_MAX_FAILURES; index += 1) expect(() => registry.pair('AAAA-AAAA')).toThrow();
        expect(() => registry.pair(code)).toThrow('locked');
    });

    it('codes have no characters that read alike', () => {
        for (let index = 0; index < 50; index += 1) expect(newPairingCode()).not.toMatch(/[01OIL]/);
    });
});
