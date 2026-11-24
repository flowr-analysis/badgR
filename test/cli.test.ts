import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const root = path.join(__dirname, '..');
function cli(...args: string[]) {
	return spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, encoding: 'utf-8', maxBuffer: 1 << 28 });
}
/* from another folder: the linting threads must still find tsx, or every tier that needs a rule fails */
function cliElsewhere(...args: string[]) {
	return spawnSync(path.join(root, 'node_modules', '.bin', 'tsx'), [path.join(root, 'src', 'cli.ts'), ...args], { cwd: os.tmpdir(), encoding: 'utf-8', maxBuffer: 1 << 28 });
}

describe('the command line', () => {
	test('the README of the Docker image shows the current --help', () => {
		const r = cli('--help');
		expect(r.status).toBe(0);
		const readme = fs.readFileSync(path.join(root, 'docker', 'README.md'), 'utf-8');
		expect(/```text\n([\s\S]*)```\s*$/.exec(readme)?.[1]).toBe(r.stdout);
	});

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
		expect(r.stdout.startsWith('# badger')).toBe(true);
		expect(r.stdout).toContain('https://github.com/flowr-analysis/flowr/wiki/');
		expect(r.stdout).not.toContain('✗ gold');
	}, 300_000);

	test('--review marks a finding as reviewed and leaves the tier alone', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-review-'));
		const review = path.join(dir, 'review.json');
		fs.writeFileSync(review, JSON.stringify({ badgerReview: 1, entries: [
			{ key: 'app.R|glue::glue|code-execution|package|output$t <- renderText(glue(input$template))', state: 'tolerated', note: 'a fixed template' }
		] }));
		const r = cli('--json', '--quiet', '--review', review, path.join(root, 'test', 'fixtures', 'bronze'));
		expect(r.status).toBe(0);
		const report = JSON.parse(r.stdout) as { tier: { tier: string }, findings: { review?: { state: string, note?: string } }[] };
		expect(report.tier.tier).toBe('bronze');
		expect(report.findings[0].review).toEqual({ state: 'tolerated', note: 'a fixed template' });
	}, 300_000);

	test('runs from another folder with its linting rules', () => {
		const r = cliElsewhere('--json', '--quiet', path.join(root, 'test', 'fixtures', 'gold'));
		expect(r.status).toBe(0);
		const report = JSON.parse(r.stdout) as { tier: { tier: string }, lint: { error?: string }[] };
		expect(report.lint.filter(l => l.error)).toEqual([]);
		expect(report.tier.tier).toBe('gold');
	}, 300_000);

	test('an unknown tier for --min-tier is an error', () => {
		expect(cli('--min-tier', 'platinum', path.join(root, 'test', 'fixtures', 'gold')).status).toBe(1);
	}, 120_000);

	test('--sarif writes SARIF with stable fingerprints, and the badge marks a complete review and a custom policy', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-sarif-'));
		const review = path.join(dir, 'review.json');
		fs.writeFileSync(review, JSON.stringify({ badgerReview: 1, entries: [
			{ key: 'app.R|glue::glue|code-execution|package|output$t <- renderText(glue(input$template))', state: 'false-positive', note: 'a fixed template' }
		] }));
		const target = path.join(root, 'test', 'fixtures', 'bronze');
		const r = cli('--quiet', '--review', review, '--sarif', path.join(dir, 'out.sarif'), '--badge', path.join(dir, 'badge.svg'), target);
		expect(r.status).toBe(0);
		const sarif = JSON.parse(fs.readFileSync(path.join(dir, 'out.sarif'), 'utf-8')) as { version: string, runs: { results: Record<string, unknown>[], properties: Record<string, unknown> }[] };
		expect(sarif.version).toBe('2.1.0');
		const [result] = sarif.runs[0].results.filter(x => x.ruleId === 'badger/code-execution');
		expect(result).toEqual(expect.objectContaining({
			level:               'error',
			locations:           [{ physicalLocation: { artifactLocation: { uri: 'app.R', uriBaseId: 'SRCROOT' }, region: expect.objectContaining({ startLine: expect.any(Number) }) } }],
			partialFingerprints: { 'badgerFinding/v1': expect.stringMatching(/^[0-9a-f]{16}$/) },
			suppressions:        [{ kind: 'external', status: 'accepted', justification: 'a fixed template' }]
		}));
		expect(sarif.runs[0].properties).toEqual(expect.objectContaining({ tier: 'bronze', reviewed: { total: 1, decided: 1, toFix: 0, complete: true } }));
		const badge = fs.readFileSync(path.join(dir, 'badge.svg'), 'utf-8');
		expect(badge).toContain('aria-label="badger: bronze, all findings reviewed"');
		expect(badge).not.toContain('bronze*');

		/* the same policy under another name is still the default; a changed one is custom */
		const custom = path.join(dir, 'custom.yaml');
		fs.writeFileSync(custom, fs.readFileSync(path.join(root, 'policies', 'default.yaml'), 'utf-8').replace('lintTimeout: 120', 'lintTimeout: 100'));
		expect(cli('--quiet', '--policy', custom, '--badge', path.join(dir, 'custom.svg'), target).status).toBe(0);
		const marked = fs.readFileSync(path.join(dir, 'custom.svg'), 'utf-8');
		expect(marked).toContain('bronze*');
		expect(marked).toContain('custom policy');
		expect(marked).not.toContain('all findings reviewed');
	}, 300_000);

	test('a package: DESCRIPTION and NAMESPACE are read, and the report says which files it read', () => {
		const r = cli('--json', '--quiet', path.join(root, 'test', 'fixtures', 'pkg'));
		expect(r.status).toBe(0);
		const report = JSON.parse(r.stdout) as { files: string[], analyzed: boolean };
		expect(report.analyzed).toBe(true);
		expect(report.files.map(f => path.basename(f))).toEqual(expect.arrayContaining(['DESCRIPTION', 'NAMESPACE', '.Rprofile']));
	}, 300_000);
});

describe('the command line, arguments', () => {
	test('two outputs to stdout are refused, not mixed', () => {
		const r = cli('--json', '--sarif', '-', '--quiet', path.join(root, 'test', 'fixtures', 'bronze'));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('stdout');
		expect(r.stdout).toBe('');
	});

	test('an unknown flag or a bad timeout is a line, not a stack', () => {
		const a = cli('--nope', 'x');
		expect(a.status).toBe(1);
		expect(a.stderr).not.toContain('    at ');
		expect(cli('--timeout', 'abc', path.join(root, 'test', 'fixtures', 'bronze')).stderr).toContain('--timeout');
	});

	test('the default policy with other layout and key order is not custom, a changed one is', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-marks-'));
		const text = fs.readFileSync(path.join(root, 'policies', 'default.yaml'), 'utf-8');
		const reordered = path.join(dir, 'reordered.yaml');
		/* same content, other layout: a comment, and the document as JSON with its keys reversed */
		const doc = (require('yaml') as typeof import('yaml')).parse(text) as Record<string, unknown>;
		fs.writeFileSync(reordered, '# mine\n' + JSON.stringify(Object.fromEntries(Object.entries(doc).reverse())));
		const badge = path.join(dir, 'b.svg');
		expect(cli('--quiet', '--policy', reordered, '--badge', badge, path.join(root, 'test', 'fixtures', 'bronze')).status).toBe(0);
		expect(fs.readFileSync(badge, 'utf-8')).not.toContain('custom policy');
	}, 300_000);
});
