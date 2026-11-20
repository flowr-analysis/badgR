import { describe, expect, test } from 'vitest';
import { badgeSvg, badgeTitle } from '../src/badge';
import type { Report } from '../src/core';
import { findingAt, fingerprint, lintAt, parseAt, sarifLog } from '../src/sarif';
import type { Finding } from '../src/tiers';

const finding: Finding = {
	id: '7', file: '/p/app.R', role: 'source', loc: [3, 1, 3, 17], call: 'base::system', capability: 'shell', class: 'severe',
	via: 'direct', origins: ['outside'], inputTypes: ['user']
};

function report(findings: Finding[]): Report {
	return {
		tool: 'badgR', toolVersion: '0.1.0', flowrVersion: '2.17.8', sigdb: { present: true, tag: 'v1' },
		policy: { name: 'p', hash: 'h', source: 'p.yaml', modified: false }, target: '/p', files: ['/p/app.R'],
		generatedAt: '2026-01-01T00:00:00.000Z', analyzed: true,
		tier: { tier: 'none', color: '#6b6b6b', review: 'full', checks: [{ tier: 'gold', met: false, violations: [{ rule: 'gold.forbid[0]', reason: 'r', findings: ['7'] }] }] },
		findings, unresolvedPackages: [], ms: 1,
		lint: [{ rule: 'unescaped-arguments', count: 1, results: [{ file: '/p/app.R', loc: [3, 1, 3, 17], message: 'an argument', quickFix: [{ description: 'quote it', loc: [3, 8, 3, 16], replacement: 'shQuote(x)' }] }] }]
	};
}

const opts = (lines: string[]) => ({ fileOf: (f?: string) => f?.replace('/p/', ''), lineOf: (_: string | undefined, l: number) => lines[l - 1] });

describe('SARIF', () => {
	test('a finding and a linting result, with location, fix, and the tiers the finding blocks', () => {
		const log = sarifLog([report([finding])], opts(['', '', 'system(readline())'])) as { runs: { results: Record<string, unknown>[], tool: { driver: { rules: { id: string }[] } } }[] };
		const [run] = log.runs;
		expect(run.tool.driver.rules.map(r => r.id)).toEqual(['badgr/shell', 'flowr/unescaped-arguments']);
		expect(run.results[0]).toEqual(expect.objectContaining({
			ruleId: 'badgr/shell', ruleIndex: 0, level: 'error',
			locations: [{ physicalLocation: { artifactLocation: { uri: 'app.R', uriBaseId: 'SRCROOT' }, region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 18 } } }],
			properties: expect.objectContaining({ blocks: ['gold'], origins: ['outside'] })
		}));
		expect(run.results[1]).toEqual(expect.objectContaining({
			ruleId: 'flowr/unescaped-arguments', ruleIndex: 1,
			fixes: [{ description: { text: 'quote it' }, artifactChanges: [{ artifactLocation: { uri: 'app.R', uriBaseId: 'SRCROOT' },
				replacements: [{ deletedRegion: { startLine: 3, startColumn: 8, endLine: 3, endColumn: 17 }, insertedContent: { text: 'shQuote(x)' } }] }] }]
		}));
	});

	test('a fingerprint survives the code moving to another line, and changes with the call', () => {
		const fp = (f: Finding, lines: string[]) => ((sarifLog([report([f])], opts(lines)) as { runs: { results: { partialFingerprints: Record<string, string> }[] }[] }).runs[0].results[0].partialFingerprints['badgrFinding/v1']);
		const here = fp(finding, ['', '', 'system(readline())']);
		expect(fp({ ...finding, loc: [9, 1, 9, 17] }, Array(8).fill('# moved').concat('  system(readline())'))).toBe(here);
		expect(fp(finding, ['', '', 'system(other())'])).not.toBe(here);
		expect(fingerprint('a')).toBe(fingerprint('a'));
		expect(fingerprint('a')).toMatch(/^[0-9a-f]{16}$/);
	});

	test('a reviewed finding is suppressed with the note as justification, one to fix is not', () => {
		const res = (state: 'tolerated' | 'false-positive' | 'to-fix') => (sarifLog([report([{ ...finding, review: { state, note: 'why' } }])], opts([])) as { runs: { results: Record<string, unknown>[] }[] }).runs[0].results[0];
		expect(res('tolerated').suppressions).toEqual([{ kind: 'external', status: 'accepted', justification: 'why' }]);
		expect(res('false-positive').suppressions).toHaveLength(1);
		expect(res('to-fix').suppressions).toBeUndefined();
	});

	test('a link to each result when there is one', () => {
		const log = sarifLog([report([finding])], { ...opts([]), linkOf: at => `https://x/#z=1&at=${encodeURIComponent(at)}` }) as { runs: { results: { hostedViewerUri?: string }[] }[] };
		expect(log.runs[0].results[0].hostedViewerUri).toBe(`https://x/#z=1&at=${encodeURIComponent('f:app.R:3:base%3A%3Asystem')}`);
	});
});

describe('the selection in a link', () => {
	test('survives files and calls with colons', () => {
		expect(parseAt(findingAt({ file: 'a:b.R', loc: [3, 1, 3, 2], call: 'base::system' }, 'a:b.R'))).toEqual({ kind: 'f', file: 'a:b.R', line: '3', call: 'base::system' });
		expect(parseAt(lintAt('dead-code', { loc: [5, 1, 5, 2] }, 'R/x:y.R'))).toEqual({ kind: 'l', rule: 'dead-code', file: 'R/x:y.R', line: '5' });
	});

	test('reads links from before the encoding', () => {
		expect(parseAt('f:app.R:2:base::system')).toEqual({ kind: 'f', file: 'app.R', line: '2', call: 'base::system' });
		expect(parseAt('l:dead-code:app.R:4')).toEqual({ kind: 'l', rule: 'dead-code', file: 'app.R', line: '4' });
		expect(parseAt('nonsense')).toBeUndefined();
	});
});

describe('badge marks', () => {
	test('a custom policy adds *, a complete review a check mark, both say so to screen readers', () => {
		const plain = badgeSvg('gold', '#d4aa32');
		const both = badgeSvg('gold', '#d4aa32', { custom: true, reviewed: true });
		expect(plain).toContain('aria-label="badgR: gold"');
		expect(both).toContain('>gold*<');
		expect(both).toContain(`aria-label="${badgeTitle('gold', { custom: true, reviewed: true })}"`);
		expect(badgeTitle('gold', { custom: true, reviewed: true })).toBe('badgR: gold, custom policy, all findings reviewed');
		/* wider for the marks, and ids of their own so marked and plain badges can share a page */
		const width = (svg: string) => Number(/width="(\d+(\.\d+)?)"/.exec(svg)?.[1]);
		expect(width(both)).toBeGreaterThan(width(plain));
		expect(both).not.toContain('id="badgr-gold-s"');
	});
});
