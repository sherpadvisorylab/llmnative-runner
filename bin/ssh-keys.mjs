// The SSH key of this computer for a host: the IdentityFile of ~/.ssh/config for it (as ssh would use), then the
// usual default keys. Read only here, sent to nobody: the installer connects from this computer.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sshConfigFor } from '../dist/setup.mjs';

export function localSshFor(host) {
    const home = homedir();
    const configFile = join(home, '.ssh', 'config');
    const config = existsSync(configFile) ? sshConfigFor(readFileSync(configFile, 'utf8'), host) : { identityFiles: [] };
    const files = [...config.identityFiles.map((file) => file.replace(/^~(?=$|[\\/])/, home)), ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map((name) => join(home, '.ssh', name))];
    const file = files.find((candidate) => existsSync(candidate));
    return { ...(config.user ? { user: config.user } : {}), ...(file ? { file, privateKey: readFileSync(file, 'utf8') } : {}) };
}
