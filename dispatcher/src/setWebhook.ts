import { readConfig } from './config.ts';
import { appJwt, retryingFetch } from './github.ts';

// Points the webhook of the company App at this dispatcher, with its secret:
//   node src/setWebhook.ts https://<domain>/webhook
// It reads the same settings as the dispatcher (GITHUB_APP_ID, the key, GITHUB_WEBHOOK_SECRET), so the
// secret never leaves the machine. GitHub sets the URL and the secret through the API; "Active" and the
// events (Issues, Push) are ticked once in the settings of the App.

async function main() {
    const url = process.argv[2];
    if (!url || !/^https:\/\/[^/]+\/webhook$/.test(url)) {
        console.error('Usage: node src/setWebhook.ts https://<domain>/webhook');
        process.exit(64);
    }
    const config = readConfig();
    if (!config.webhookSecret) {
        console.error('GITHUB_WEBHOOK_SECRET is missing');
        process.exit(64);
    }
    const response = await retryingFetch(globalThis.fetch)('https://api.github.com/app/hook/config', {
        method: 'PATCH',
        headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'llmnative-playbook-dispatcher',
            authorization: `Bearer ${appJwt(config)}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ url, secret: config.webhookSecret, content_type: 'json', insecure_ssl: '0' }),
    });
    const body = await response.json() as { url?: string; message?: string };
    if (!response.ok) {
        console.error(`GitHub answered ${response.status}: ${body.message ?? ''}`);
        process.exit(1);
    }
    console.log(`Webhook of the App: ${body.url}. Now tick "Active" and the events Issues and Push in the settings of the App.`);
}

void main();
