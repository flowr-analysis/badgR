import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixes, unifiedDiff } from '../web/patch';

const code = 'library(DBI)\nname <- readline()\nsystem(paste("ls", name))\nx <- 1\ny <- 2\nz <- 3\ndbGetQuery(con, paste0("SELECT ", name))\n';
const fixes = [
	{ description: 'shQuote', loc: [3, 20, 3, 23] as const, replacement: 'shQuote(name)' },
	{ description: 'quote', loc: [7, 35, 7, 38] as const, replacement: 'DBI::dbQuoteLiteral(con, name)' }
];

describe('quick fixes as a patch', () => {
	test('applies every fix at its place', () => {
		expect(applyFixes(code, fixes)).toBe(code.replace('"ls", name', '"ls", shQuote(name)').replace('"SELECT ", name', '"SELECT ", DBI::dbQuoteLiteral(con, name)'));
	});

	test('leaves out a fix that overlaps an earlier one', () => {
		expect(applyFixes(code, [fixes[0], { description: 'x', loc: [3, 21, 3, 22], replacement: 'X' }])).toBe(applyFixes(code, [fixes[0]]));
	});

	test('writes a diff that git apply accepts and that gives the fixed code', () => {
		const diff = unifiedDiff('app.R', code, fixes);
		expect(diff).toContain('-system(paste("ls", name))\n+system(paste("ls", shQuote(name)))');
		expect(diff.match(/^@@/gm)).toHaveLength(2);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badgr-patch-'));
		fs.writeFileSync(path.join(dir, 'app.R'), code);
		fs.writeFileSync(path.join(dir, 'fix.patch'), diff);
		execFileSync('git', ['apply', 'fix.patch'], { cwd: dir });
		expect(fs.readFileSync(path.join(dir, 'app.R'), 'utf-8')).toBe(applyFixes(code, fixes));
	});
});
