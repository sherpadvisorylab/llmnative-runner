import { readLegacyCompany, readCompanyConfig, readMachineConfig } from './config.ts';
import { appJwt, retryingFetch } from './github.ts';
import { readCompanyFiles } from './tenants.ts';

// Points the webhook of the App of a company at this runner, with its secret:
//   node src/setWebhook.ts <company> https://<runner>/<company>/webhook
// It reads the .env of that company on the machine, so the secret never leaves it. GitHub sets the
// URL and the secret through the API; "Active" and the events (Issues, Push) are ticked once in the
// settings of an App created without its webhook.

async function main() {
    const [company, url] = process.argv.slice(2);
    if (!company || !url || !/^https:\/\/[^/]+(\/[a-z0-9-]+)?\/webhook$/.test(url)) {
        console.error('Usage: node src/setWebhook.ts <company> https://<runner>/<company>/webhook');
        process.exit(64);
    }
    const file = readCompanyFiles(readMachineConfig().companiesDir).find((item) => item.id === company);
    const legacy = readLegacyCompany();
    const config = file ? readCompanyConfig(company, file.vars) : legacy?.id === company ? legacy : null;
    if (!config) {
        console.error(`No .env of ${company} on this runner`);
        process.exit(64);
    }
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
