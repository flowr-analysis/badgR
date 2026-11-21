import * as path from 'node:path';
import type { Report } from './core';
import type { Finding } from './tiers';

function where(f: Finding, root: string): string {
	const file = f.file ? path.relative(root, f.file) || path.basename(f.file) : '';
	const loc = f.loc ? `${f.loc[0]}:${f.loc[1]}` : '?';
	return file ? `${file}:${loc}` : loc;
}

function rootOf(r: Report): string {
	return r.files.length === 1 ? path.dirname(r.files[0]) : r.target;
}

/** a few lines for the terminal */
export function textReport(r: Report): string {
	const root = rootOf(r);
	const lines = [
		`badgR ${r.toolVersion} (flowR ${r.flowrVersion}, sigdb ${r.sigdb.tag ?? '?'}${r.sigdb.present ? '' : ' MISSING'}), policy ${r.policy.name}`,
		`${r.target}: ${r.tier.tier.toUpperCase()}  (review: ${r.tier.review})`
	];
	if(!r.analyzed) {
		lines.push(`  not analyzed: ${r.error}`);
	}
	for(const c of r.tier.checks) {
		lines.push(`  ${c.met ? '✓' : '✗'} ${c.tier}`);
		for(const v of c.violations) {
			lines.push(`      ${v.reason}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}`);
		}
	}
	if(r.findings.length > 0) {
		lines.push(`  findings:`);
		for(const f of r.findings) {
			lines.push(`    ${where(f, root)}  ${f.call}  ${f.capability} [${f.class}, ${f.via}${f.through ? ` via ${f.through}` : ''}]  origins: ${f.origins.join(', ') || '-'}${f.review ? `  reviewed: ${f.review.state}${f.review.note ? ` (${f.review.note})` : ''}` : ''}`);
		}
	}
	const lint = r.lint.filter(l => l.count > 0 || l.error);
	if(lint.length > 0) {
		lines.push(`  lint: ${lint.map(l => l.error ? `${l.rule} (failed)` : `${l.rule} ${l.count}`).join(', ')}`);
	}
	lines.push(`  ${r.files.length} file(s), ${r.ms} ms`);
	return lines.join('\n');
}

/** text for a Markdown table cell: no line breaks, pipes, or HTML */
function cell(text: string): string {
	return text.replace(/\r?\n|\r/g, ' ').replace(/[\\|*_[\]`<>&]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : `\\${c}`);
}

/** inline code that a backtick in the text cannot end; pipes still escaped for tables */
function code(text: string): string {
	const t = text.replace(/\r?\n|\r/g, ' ');
	const run = Math.max(0, ...(t.match(/`+/g) ?? []).map(m => m.length)) + 1;
	const fence = '`'.repeat(run);
	const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${t.replace(/\|/g, '\\|')}${pad}${fence}`;
}

/** a Markdown report, for a pull request comment or a CI summary */
export function markdownReport(r: Report): string {
	const root = rootOf(r);
	const out = [
		`# badgR: ${cell(r.tier.tier)}`,
		'',
		`**${cell(path.basename(r.target))}** reaches the tier **${cell(r.tier.tier)}** of the policy ${code(r.policy.name)}.`,
		`Human review still needed: ${cell(r.tier.review)}.`,
		''
	];
	if(!r.analyzed) {
		out.push(`> flowR could not analyze the artifact: ${cell(r.error ?? '')}`, '');
	}
	out.push('| Tier | Met | Why not |', '|---|---|---|');
	for(const c of r.tier.checks) {
		out.push(`| ${cell(c.tier)} | ${c.met ? 'yes' : 'no'} | ${c.violations.map(v => cell(v.reason) + (v.findings.length ? ` (${v.findings.length})` : '')).join('; ') || ''} |`);
	}
	out.push('');
	if(r.findings.length > 0) {
		const reviewed = r.findings.some(f => f.review);
		out.push('## Findings', '', `| Where | Call | Capability | Class | Via | Origins |${reviewed ? ' Review |' : ''}`, `|---|---|---|---|---|---|${reviewed ? '---|' : ''}`);
		for(const f of r.findings) {
			const review = reviewed ? ` ${f.review ? `${f.review.state}${f.review.note ? `: ${cell(f.review.note)}` : ''}` : ''} |` : '';
			out.push(`| ${cell(where(f, root))} | ${code(f.call)} | ${cell(f.capability)} | ${f.class} | ${f.via}${f.through ? ` (${code(f.through)})` : ''} | ${f.origins.join(', ')} |${review}`);
		}
		out.push('');
	}
	if(r.lint.length > 0) {
		out.push('## Linting rules', '', '| Rule | Results |', '|---|---|');
		for(const l of r.lint) {
			out.push(`| [${cell(l.rule)}](${(l.docs ?? 'https://github.com/flowr-analysis/flowr/wiki/Linter').replace(/[()\s]/g, encodeURIComponent)}) | ${l.error ? `failed: ${cell(l.error)}` : l.count} |`);
		}
		out.push('');
	}
	out.push(`<sub>badgR ${r.toolVersion}, flowR ${r.flowrVersion}, signature database ${r.sigdb.tag ?? '?'}, policy hash ${r.policy.hash.slice(0, 12)}, ${r.generatedAt}</sub>`, '');
	return out.join('\n');
}
