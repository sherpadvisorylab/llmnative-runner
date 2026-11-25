import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Commands run inside the container of the runner (`docker compose exec runner node src/cli.ts <command>`):
//   pair         a new pairing code (15 minutes, once), to connect a platform or the console
//   admin-token  the admin token of the machine, to sign in to the console
// They talk to the runner on localhost with the admin token, never over the network.

const dataDir = (process.env.DATA_DIR || '/data').replace(/\/+$/, '');
const port = process.env.PORT || '8080';
const token = () => readFileSync(join(dataDir, 'admin-token'), 'utf8').trim();

async function main(command: string | undefined) {
    if (command === 'admin-token') {
        console.log(token());
        return;
    }
    if (command === 'pair') {
        const response = await fetch(`http://127.0.0.1:${port}/v1/admin/pairing`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
        if (!response.ok) throw new Error(`the runner answered ${response.status}`);
        const { code, expiresAt } = await response.json() as { code: string; expiresAt: string };
        // The installer reads this line.
        console.log(`PAIRING_CODE=${code}`);
        console.log(`valid until ${expiresAt}`);
        return;
    }
    console.error('usage: node src/cli.ts pair | admin-token');
    process.exit(64);
}

main(process.argv[2]).catch((error: Error) => {
    console.error(`[runner] ${error.message}`);
    process.exit(1);
});
