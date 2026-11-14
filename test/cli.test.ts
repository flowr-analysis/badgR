import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const root = path.join(__dirname, '..');
function cli(...args: string[]) {
	return spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf-8', maxBuffer: 1 << 28 });
}

describe('the command line', () => {
	test('a report larger than the pipe buffer reaches stdout complete', () => {
		const r = cli('--json', path.join(root, 'test', 'fixtures', 'large'));
		expect(r.status).toBe(0);
		expect(r.stdout.length).toBeGreaterThan(1 << 16);
		const report = JSON.parse(r.stdout) as { tier: { tier: string }, findings: unknown[] };
		expect(report.tier.tier).toBe('none');
		expect(report.findings).toHaveLength(1500);
	}, 300_000);

	test('--min-tier fails below the tier', () => {
		expect(cli('--min-tier', 'silver', path.join(root, 'test', 'fixtures', 'bronze')).status).toBe(2);
		expect(cli('--min-tier', 'bronze', path.join(root, 'test', 'fixtures', 'bronze')).status).toBe(0);
	}, 300_000);

	test('--md - writes only the Markdown report to stdout, with the rule pages linked', () => {
		const r = cli('--md', '-', '--quiet', path.join(root, 'test', 'fixtures', 'bronze'));
		expect(r.status).toBe(0);
		expect(r.stdout.startsWith('# badgR')).toBe(true);
		expect(r.stdout).toContain('https://github.com/flowr-analysis/flowr/wiki/');
		expect(r.stdout).not.toContain('✗ gold');
	}, 300_000);

	test('--review marks a finding as reviewed and leaves the tier alone', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badgr-review-'));
		const review = path.join(dir, 'review.json');
		fs.writeFileSync(review, JSON.stringify({ badgrReview: 1, entries: [
			{ key: 'app.R|glue::glue|code-execution|package|output$t <- renderText(glue(input$template))', state: 'tolerated', note: 'a fixed template' }
		] }));
		const r = cli('--json', '--quiet', '--review', review, path.join(root, 'test', 'fixtures', 'bronze'));
		expect(r.status).toBe(0);
		const report = JSON.parse(r.stdout) as { tier: { tier: string }, findings: { review?: { state: string, note?: string } }[] };
		expect(report.tier.tier).toBe('bronze');
		expect(report.findings[0].review).toEqual({ state: 'tolerated', note: 'a fixed template' });
	}, 300_000);

	test('an unknown tier for --min-tier is an error', () => {
		expect(cli('--min-tier', 'platinum', path.join(root, 'test', 'fixtures', 'gold')).status).toBe(1);
	}, 120_000);
});
