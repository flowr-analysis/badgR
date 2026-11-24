/**
 * The playground in a real (headless) browser: it must give the same tiers as the command line, and it
 * must stay local: every request it makes is recorded, and the test fails if one leaves the page's own
 * site (other than the GitHub hosts of a repository it was asked to fetch), or if any request carries a body.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Playground } from '@eagleoutice/flowr/util/text/playground-link';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';
import { deflateSync, strToU8 } from 'fflate';
import { parse as parseYaml } from 'yaml';

const root = path.join(__dirname, '..');
const dist = path.join(root, 'web-dist');
const fixtures = path.join(__dirname, 'fixtures');
const Types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };

let server: http.Server;
let origin: string;
let browser: Browser;

beforeAll(async() => {
	const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
	execFileSync(tsx, [path.join(root, 'scripts', 'build-web.ts')], { cwd: root, stdio: 'ignore' });
	if(!fs.existsSync(path.join(dist, 'pkgs', 'glue.json'))) {
		execFileSync(tsx, [path.join(root, 'scripts', 'gen-web-data.ts'), path.join(dist, 'pkgs'), '--only', 'shiny,glue,httr,processx'], { cwd: root, stdio: 'ignore' });
	}
	server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		const file = path.join(dist, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
		if(!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'Content-Type': Types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await chromium.launch({ args: ['--disable-gpu'] });
}, 600_000);

afterAll(async() => {
	await browser?.close();
	server?.close();
});

interface Session { page: Page, requests: Request[], errors: string[] }

async function open(): Promise<Session> {
	const page = await browser.newPage();
	const requests: Request[] = [];
	const errors: string[] = [];
	page.on('request', r => requests.push(r));
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', m => m.type() === 'error' && errors.push(m.text()));
	await page.goto(origin + '/');
	return { page, requests, errors };
}

async function tierOf(page: Page): Promise<string> {
	/* a partial report (`.partial`) shows while linting rules still run: its tier is final only once the analysis is done */
	await page.waitForSelector('body:not(.busy) #result:not([hidden]):not(.partial), #error:not([hidden])', { timeout: 120_000 });
	const error = await page.locator('#error:not([hidden])').count();
	if(error > 0) {
		throw new Error(await page.locator('#error').innerText());
	}
	return (await page.locator('#verdict-title span').textContent() ?? '').trim();
}

/**
 * types code into the editor like a user: a key per character and Enter per line. Playwright's fill()
 * inserts newlines through the browser's own editing, which copies the color of the token before the
 * cursor into an inline style that the page's content security policy rejects. Real typing and pasting
 * go through CodeMirror and never do that.
 */
async function setCode(page: Page, code: string): Promise<void> {
	await page.locator('#code .cm-content').click();
	await page.keyboard.press('Control+A');
	await page.keyboard.press('Delete');
	for(const line of code.replace(/\n$/, '').split('\n')) {
		await page.keyboard.type(line);
		await page.keyboard.press('Enter');
	}
	/* closing brackets that the editor inserted and the typing stepped over leave nothing behind */
	await page.locator('#code .cm-content', { hasText: code.split('\n')[0] }).waitFor();
}

/** loads an example from the menu */
async function pickExample(page: Page, label: string): Promise<void> {
	await page.click('[data-tab="paste"]');
	await page.click('#examples-label');
	await page.click(`#examples button[data-label="${label}"]`);
}

/** every request stays on the page's site, except the hosts allowed, and none sends data */
function expectLocal(requests: readonly Request[], allowedHosts: readonly string[] = []): void {
	const outside = requests.filter(r => {
		const u = new URL(r.url());
		return u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== origin && !allowedHosts.includes(u.host);
	});
	expect(outside.map(r => r.url())).toEqual([]);
	expect(requests.filter(r => r.method() !== 'GET').map(r => `${r.method()} ${r.url()}`)).toEqual([]);
	expect(requests.filter(r => r.postData() !== null).map(r => r.url())).toEqual([]);
}

const b64url = (text: string) => Buffer.from(deflateSync(strToU8(text), { level: 9 })).toString('base64url');
const defaultPolicy = fs.readFileSync(path.join(root, 'policies', 'default.yaml'), 'utf-8');
/* a policy that differs from the default only in a time limit, so its tiers are the same */
const customPolicy = defaultPolicy.replace('lintTimeout: 120', 'lintTimeout: 110');

describe('links, exports, and the policy', () => {
	test('a link carries a custom policy, the badge marks it, and Reset goes back to the default with an undo', async() => {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(`${origin}/#z=${b64url('system(readline())\n')}&p=${b64url(customPolicy)}`);
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#badge img').getAttribute('alt')).toBe('badger: none, custom policy');
		await page.locator('#notice:not([hidden])', { hasText: 'its own policy' }).waitFor();
		/* the link the page writes names the policy again, in the same order */
		expect(page.url()).toMatch(/#z=[^&]+&p=[^&]+&tier=none&n=1$/);
		await page.click('[data-tab="policy"]');
		expect(await page.locator('#policy-status').innerText()).toContain('custom policy');
		await page.click('#policy-reset');
		await page.locator('#policy-status', { hasText: 'default policy' }).waitFor();
		expect(await page.locator('#policy-reset').isDisabled()).toBe(true);
		await page.locator('#policy-note button', { hasText: 'Undo' }).click();
		await page.locator('#policy-status', { hasText: 'custom policy' }).waitFor();
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('a link without a policy uses the default, so it shows the tier it was shared with', async() => {
		const page = await browser.newPage();
		await page.goto(`${origin}/#p=${b64url(customPolicy)}`);
		await page.click('[data-tab="policy"]');
		await page.locator('#policy-status', { hasText: 'custom policy' }).waitFor();
		/* the bare page keeps the policy of this browser */
		await page.goto(`${origin}/`);
		await page.reload();
		await page.click('[data-tab="policy"]');
		await page.locator('#policy-status', { hasText: 'custom policy' }).waitFor();
		await page.goto(`${origin}/#z=${b64url('x <- 1\n')}&tier=gold&n=0`);
		await page.reload();
		expect(await tierOf(page)).toBe('gold');
		await page.click('[data-tab="policy"]');
		await page.locator('#policy-status', { hasText: 'default policy' }).waitFor();
		await page.close();
	}, 180_000);

	test('export=sarif downloads SARIF once the analysis is done, with links back to each result', async() => {
		const page = await browser.newPage();
		const download = page.waitForEvent('download', { timeout: 120_000 });
		await page.goto(`${origin}/#z=${b64url('x <- readline()\nsystem(x)\n')}&export=sarif`);
		const file = await download;
		expect(file.suggestedFilename()).toBe('report.sarif');
		const sarif = JSON.parse(fs.readFileSync(await file.path(), 'utf-8')) as { version: string, runs: { results: { ruleId: string, hostedViewerUri?: string }[], properties: { tier: string } }[] };
		expect(sarif.version).toBe('2.1.0');
		expect(sarif.runs[0].properties.tier).toBe('none');
		const shell = sarif.runs[0].results.find(r => r.ruleId === 'badger/shell');
		expect(shell?.hostedViewerUri).toMatch(/#z=[^&]+&tier=none&n=1&at=f%3Ascript.R%3A2%3Abase%253A%253Asystem$/);
		/* the result's link selects the finding */
		const again = await browser.newPage();
		await again.goto(shell?.hostedViewerUri ?? '');
		expect(await tierOf(again)).toBe('none');
		await again.locator('#findings tr.sel').waitFor({ timeout: 10_000 });
		await again.close();
		await page.close();
	}, 180_000);

	test('copy link is a menu with a SARIF link, which opens as the SARIF only, analyzed again', async() => {
		const page = await browser.newPage();
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
		await page.goto(`${origin}/#z=${b64url('x <- readline()\nsystem(x)\n')}`);
		expect(await tierOf(page)).toBe('none');
		/* the menus hold what they say: links to copy, and files to download; the review sits by the findings */
		await page.locator('#share-menu > summary').click();
		const items = await page.locator('#share-menu .menu-list > *').allTextContents();
		expect(items).toEqual(['link to this result', 'SARIF link', 'SARIF download link', 'Markdown report']);
		const downloads = await page.locator('#downloads details.menu:not(#share-menu) .menu-list > *').allTextContents();
		expect(downloads).not.toContain('import review');
		expect(downloads.filter(d => d !== 'fixes.patch')).toEqual(['badge.svg', 'report.json', 'report.md', 'report.sarif']);
		expect(await page.locator('#review-actions').textContent()).toContain('import review');
		await page.locator('#share-menu button', { hasText: 'SARIF link' }).first().click();
		const link = await page.evaluate(() => navigator.clipboard.readText());
		expect(link).toMatch(/&view=sarif$/);
		const raw = await browser.newPage();
		await raw.goto(link);
		await raw.locator('#raw[data-state="done"]').waitFor({ timeout: 120_000 });
		/* nothing but the SARIF is visible */
		expect(await raw.locator('main, header, footer').evaluateAll(es => es.filter(e => (e as HTMLElement).offsetParent !== null).length)).toBe(0);
		const sarif = JSON.parse(await raw.locator('#raw').textContent() ?? '') as { version: string, runs: { properties: { tier: string } }[] };
		expect(sarif.version).toBe('2.1.0');
		expect(sarif.runs[0].properties.tier).toBe('none');
		expect(await raw.title()).toBe('report.sarif');
		/* the address stays, so a reload shows the SARIF again */
		expect(raw.url()).toBe(link);
		await raw.close();
		await page.close();
	}, 180_000);

	test('the badge marks a review that decided every finding and left none to fix', async() => {
		const page = await browser.newPage();
		await page.goto(`${origin}/#z=${b64url('system(readline())\n')}`);
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#badge img').getAttribute('alt')).toBe('badger: none');
		await page.locator('#findings tbody tr .rv-to-fix').first().click();
		await page.locator('#badge img[alt="badger: none"]').waitFor();
		await page.locator('#findings tbody tr .rv-tolerated').first().click();
		await page.locator('#badge img[alt="badger: none, all findings reviewed"]').waitFor();
		/* the review goes into the link, which brings the mark back */
		expect(page.url()).toContain('&rv=');
		const again = await browser.newPage();
		await again.goto(page.url());
		expect(await tierOf(again)).toBe('none');
		await again.locator('#badge img[alt="badger: none, all findings reviewed"]').waitFor();
		await again.close();
		await page.close();
	}, 180_000);

	test('the URL field suggests CRAN packages and says what a bare name means', async() => {
		const page = await browser.newPage();
		await page.goto(`${origin}/`);
		await page.click('[data-tab="url"]');
		await page.fill('#url-input', 'gl');
		await page.locator('#url-packages option[value="glue"]').waitFor({ state: 'attached' });
		await page.fill('#url-input', 'glue@1.8.0');
		await page.locator('#url-note', { hasText: 'CRAN package glue 1.8.0' }).waitFor();
		await page.close();
	}, 60_000);

	test('the policy grid edits more than the tiers, and each changed part resets on its own', async() => {
		const page = await browser.newPage();
		/* the analysis tests run beside it and slow the page down */
		page.setDefaultTimeout(120_000);
		await page.goto(`${origin}/`);
		await page.click('[data-tab="policy"]');
		await page.locator('.vsettings summary').click();
		expect(await page.locator('.vsettings .vreset').count()).toBe(0);
		const name = page.locator('.vsettings .vblock').first().locator('input').first();
		await name.fill('my policy');
		await name.press('Tab');
		await page.locator('#policy-status', { hasText: 'custom policy' }).waitFor();
		await page.locator('.vsettings .vreset').first().waitFor();
		await page.locator('.vsettings .vreset').first().click();
		await page.locator('#policy-status', { hasText: 'default policy' }).waitFor();
		/* functions of a capability: a regular expression that does not compile is refused */
		const fn = page.locator('.vcap-fns input').first();
		await fn.fill('^(broken$');
		await fn.press('Enter');
		await page.locator('#policy-status', { hasText: 'default policy' }).waitFor();
		/* the grid may still redraw after the refusal and drop a key pressed meanwhile: enter it again until it lands */
		for(let tries = 0; ; tries++) {
			await fn.fill('^my_eval$');
			await fn.press('Enter');
			try {
				await page.locator('#policy-status', { hasText: 'custom policy' }).waitFor({ timeout: 5_000 });
				break;
			} catch(e) {
				if(tries >= 20) {
					throw e;
				}
			}
		}
		await page.locator('.vcap-fns .chip', { hasText: '^my_eval$' }).waitFor();
		await page.close();
	}, 180_000);
});

describe('the playground', () => {
	test.each([
		['gold', 'gold/app.R'],
		['silver', 'silver/app.R'],
		['bronze', 'bronze/app.R'],
		['none', 'none/app.R'],
		['bronze', 'param/helper.R']
	])('gives %s for an upload of %s, as the command line does, and stays local', async(tier, file) => {
		const { page, requests, errors } = await open();
		await page.setInputFiles('#file-input', path.join(fixtures, file));
		expect(await tierOf(page)).toBe(tier);
		expectLocal(requests);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('analyzes two uploads of the same name as two files', async() => {
		const { page, requests, errors } = await open();
		await page.setInputFiles('#file-input', ['bronze/app.R', 'none/app.R'].map(f => path.join(fixtures, f)));
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#findings tbody tr').count()).toBe(2);
		expect(await page.locator('#file-tabs button').count()).toBe(2);
		expectLocal(requests);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('analyzes a pasted script and an example', async() => {
		const { page, requests, errors } = await open();
		await page.click('[data-tab="paste"]');
		await setCode(page, 'x <- readline()\nsystem(x)\n');
		await page.click('#analyze-code');
		expect(await tierOf(page)).toBe('none');
		await pickExample(page, 'bronze');
		await page.click('#analyze-code');
		/* a locator, not waitForFunction: the page's content security policy forbids the eval the latter needs */
		await page.locator('#verdict-title', { hasText: 'example: bronze' }).waitFor({ timeout: 120_000 });
		expect(await tierOf(page)).toBe('bronze');
		expect(await page.locator('#findings tbody tr').count()).toBe(1);
		expectLocal(requests);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('a link dropped on the page is fetched and analyzed', async() => {
		const { page, requests, errors } = await open();
		const link = `${origin}/#code=${encodeURIComponent('x <- readline()\nsystem(x)\n')}`;
		const data = await page.evaluateHandle(url => {
			const d = new DataTransfer();
			d.setData('text/uri-list', url);
			return d;
		}, link);
		await page.dispatchEvent('#empty', 'dragover', { dataTransfer: data });
		await page.dispatchEvent('#empty', 'drop', { dataTransfer: data });
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#url-input').inputValue()).toBe(link);
		expectLocal(requests);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('live analysis is on by default: an edit analyzes again', async() => {
		const { page, errors } = await open();
		expect(await page.locator('#live').getAttribute('aria-pressed')).toBe('true');
		await pickExample(page, 'bronze');
		expect(await tierOf(page)).toBe('bronze');
		await setCode(page, 'x <- readline()\nsystem(x)\n');
		await page.locator('#verdict-title', { hasText: 'pasted code' }).waitFor({ timeout: 120_000 });
		expect(await tierOf(page)).toBe('none');
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('switching examples does not run the analysis again, it shows the earlier result', async() => {
		const { page, errors } = await open();
		await page.click('[data-tab="paste"]');
		/* without live analysis, which would analyze each example as it loads */
		await page.click('#live');
		expect(await page.locator('#live').getAttribute('aria-pressed')).toBe('false');
		await pickExample(page, 'none');
		await page.click('#analyze-code');
		expect(await tierOf(page)).toBe('none');
		await pickExample(page, 'gold');
		/* not analyzed yet: the old result stays, marked as stale, and nothing runs */
		expect(await page.locator('#result.stale').count()).toBe(1);
		expect(await page.locator('#progress:not([hidden])').count()).toBe(0);
		await pickExample(page, 'none');
		await page.locator('#result:not(.stale)').waitFor({ timeout: 5_000 });
		expect(await page.locator('#progress:not([hidden])').count()).toBe(0);
		expect(await tierOf(page)).toBe('none');
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('a link brings back the code, the tier, and the selected finding', async() => {
		const { page, errors } = await open();
		await page.click('[data-tab="paste"]');
		await setCode(page, 'x <- readline()\nsystem(x)\n');
		await page.click('#analyze-code');
		expect(await tierOf(page)).toBe('none');
		await page.locator('#findings tbody tr').first().click();
		const link = page.url();
		expect(link).toMatch(/#z=.*&tier=none&n=1&at=f/);
		const again = await browser.newPage();
		await again.goto(link);
		expect(await tierOf(again)).toBe('none');
		/* the selection comes back marked, without opening its details over the page */
		await again.locator('#findings tr.sel').waitFor({ timeout: 10_000 });
		expect(await again.locator('#popover:not([hidden])').count()).toBe(0);
		expect(await again.locator('#code .cm-content').innerText()).toContain('system(x)');
		expect(errors).toEqual([]);
		await again.close();
		await page.close();
	}, 180_000);

	test('analyzes a flowR playground link without any request, and links back to the playground', async() => {
		const { page, requests, errors } = await open();
		await page.click('[data-tab="url"]');
		await page.fill('#url-input', Playground.link({ code: 'library(shiny)\nx <- readline()\nsystem(x)\n', name: 'app.R' }));
		await page.locator('#url-note', { hasText: 'flowR playground' }).waitFor();
		await page.click('#url-form button');
		expect(await tierOf(page)).toBe('none');
		const back = await page.locator('#downloads a', { hasText: 'flowR playground' }).getAttribute('href');
		expect(back).toMatch(/^https:\/\/flowr-analysis\.github\.io\/flowr\/wiki\/playground\/#c=/);
		expectLocal(requests);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('the badger version and the footer link to the releases', async() => {
		const { page, errors } = await open();
		/* the versions show once, in the footer */
		expect(await page.locator('#footer #v-badger').getAttribute('href')).toBe('https://github.com/flowr-analysis/badgR/releases');
		expect(await page.locator('header .ver').count()).toBe(0);
		expect(await page.locator('#footer a', { hasText: 'source' }).getAttribute('href')).toBe('https://github.com/flowr-analysis/badgR');
		expect(errors).toEqual([]);
		await page.close();
	});

	test('the theme switch steps through auto, light, and dark, and keeps the choice', async() => {
		const { page, errors } = await open();
		const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
		expect(await theme()).toBe('auto');
		await page.click('#theme');
		expect(await theme()).toBe('light');
		await page.click('#theme');
		expect(await theme()).toBe('dark');
		await page.reload();
		expect(await theme()).toBe('dark');
		expect(errors).toEqual([]);
		await page.close();
	}, 60_000);

	test('stops a linting rule over the time limit of the policy, and no tier that needs the rule is reached', async() => {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		const policy = fs.readFileSync(path.join(__dirname, '..', 'policies', 'default.yaml'), 'utf-8').replace(/^lintTimeout:.*$/m, 'lintTimeout: 0.001');
		await page.addInitScript(text => localStorage.setItem('badger.policy', text), policy);
		await page.goto(origin + '/');
		await page.setInputFiles('#file-input', path.join(fixtures, 'gold/app.R'));
		expect(await tierOf(page)).not.toBe('gold');
		expect(await page.locator('#lint', { hasText: 'took longer than' }).count()).toBe(1);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('groups many findings and keeps the report in place while it analyzes', async() => {
		const { page, errors } = await open();
		await page.setInputFiles('#file-input', path.join(fixtures, 'bronze/app.R'));
		expect(await tierOf(page)).toBe('bronze');
		const top = () => page.locator('#verdict-title').evaluate(e => e.getBoundingClientRect().top);
		const before = await top();
		await page.setInputFiles('#file-input', path.join(fixtures, 'large/app.R'));
		await page.locator('body.busy').waitFor();
		expect(await top()).toBe(before);
		await page.locator('body:not(.busy)').waitFor({ timeout: 280_000 });
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#findings tr.group').count()).toBe(1);
		expect(await page.locator('#findings tr[data-id]').count()).toBe(10);
		await page.locator('#findings tr.more-row button').click();
		expect(await page.locator('#findings tr[data-id]').count()).toBe(1500);
		expect(errors).toEqual([]);
		await page.close();
	}, 300_000);

	test('marks a finding as tolerated without changing the tier, and the link carries the review', async() => {
		const { page, errors } = await open();
		await page.click('[data-tab="paste"]');
		await setCode(page, 'x <- readline()\nsystem(x)\n');
		await page.click('#analyze-code');
		expect(await tierOf(page)).toBe('none');
		await page.locator('#findings tr[data-id] .rv-tolerated').first().click();
		await page.locator('#findings tr.reviewed').first().waitFor();
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('.stat', { hasText: '1 of 1 reviewed' }).count()).toBe(1);
		const link = page.url();
		expect(link).toContain('rv=');
		const again = await browser.newPage();
		await again.addInitScript(() => localStorage.clear());
		await again.goto(link);
		expect(await tierOf(again)).toBe('none');
		await again.locator('#findings tr.reviewed').first().waitFor();
		expect(errors).toEqual([]);
		await again.close();
		await page.close();
	}, 180_000);

	test('applies a flowR quick fix to the code in the editor', async() => {
		const { page, errors } = await open();
		await page.click('[data-tab="paste"]');
		await setCode(page, 'x <- readline()\nsystem(paste("ls", x))\n');
		await page.click('#analyze-code');
		expect(await tierOf(page)).toBe('none');
		const fix = page.locator('#lint .fix button', { hasText: 'apply' }).first();
		await fix.click();
		await page.locator('#code .cm-content', { hasText: 'shQuote(x)' }).waitFor({ timeout: 5_000 });
		expect(await page.locator('#lint a.rule', { hasText: 'unescaped-arguments' }).getAttribute('href')).toContain('Unescaped-Arguments');
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('fetches a GitHub repository only from GitHub, and only downloads', async() => {
		const { page, requests, errors } = await open();
		/* GitHub is served from the fixtures, so the test needs no network and sees exactly what the page asks for */
		await page.route('https://api.github.com/**', route => {
			const u = new URL(route.request().url());
			const body = u.pathname.endsWith('/repos/someone/app') ? { default_branch: 'main' }
				: { truncated: false, tree: [{ path: 'R/helper.R', type: 'blob' }, { path: 'app.R', type: 'blob' }, { path: 'README.md', type: 'blob' }] };
			return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
		});
		await page.route('https://raw.githubusercontent.com/**', route => {
			const file = route.request().url().endsWith('app.R') ? 'none/app.R' : 'param/helper.R';
			return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(fixtures, file), 'utf-8') });
		});
		await page.click('[data-tab="url"]');
		await page.fill('#url-input', 'https://github.com/someone/app');
		await page.click('#url-form button');
		expect(await tierOf(page)).toBe('none');
		expect(await page.locator('#file-tabs button').count()).toBe(2);
		expectLocal(requests, ['api.github.com', 'raw.githubusercontent.com']);
		/* the README is not downloaded: only R files are */
		expect(requests.some(r => r.url().includes('README'))).toBe(false);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('a link made with the default policy in another key order is not custom, and a hostile tier or count is not shown', async() => {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		const doc = parseYaml(fs.readFileSync(path.join(root, 'policies', 'default.yaml'), 'utf-8')) as Record<string, unknown>;
		const reordered = '# the same policy\n' + JSON.stringify(Object.fromEntries(Object.entries(doc).reverse()));
		await page.goto(`${origin}/#z=${b64url('x <- 1\n')}&p=${b64url(reordered)}&tier=${encodeURIComponent('<img src=x onerror=alert(1)>')}&n=abc`);
		expect(await tierOf(page)).toBe('gold');
		expect(await page.locator('#badge img').getAttribute('alt')).toBe('badger: gold');
		expect(page.url()).not.toContain('&p=');
		expect(await page.locator('#shared').innerText()).not.toMatch(/NaN|onerror/);
		expect(errors).toEqual([]);
		await page.close();
	}, 180_000);

	test('the content security policy forbids scripts from elsewhere and form submissions', async() => {
		const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf-8');
		const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain('unsafe-inline');
	});
});
