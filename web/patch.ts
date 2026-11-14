/**
 * flowR's quick fixes as edits of the code and as a unified diff, the form `git apply` and `patch -p1` read.
 * A fix replaces the text at `[line, column, endLine, endColumn]` (1-based, the end inclusive), or removes
 * it when it has no replacement. Fixes that overlap an earlier one are left out rather than guessed at.
 */
import type { QuickFix } from '../src/tiers';

interface Edit { readonly from: number, readonly to: number, readonly text: string, readonly line: number, readonly endLine: number }

function offsets(content: string): number[] {
	const starts = [0];
	for(let i = 0; i < content.length; i++) {
		if(content[i] === '\n') {
			starts.push(i + 1);
		}
	}
	return starts;
}

/** the edits of the fixes, in order, without the ones that overlap an earlier one */
function editsOf(content: string, fixes: readonly QuickFix[]): Edit[] {
	const starts = offsets(content);
	const edits = fixes.flatMap(q => {
		const [l1, c1, l2, c2] = q.loc;
		if(l1 < 1 || l2 > starts.length) {
			return [];
		}
		return [{ from: starts[l1 - 1] + c1 - 1, to: starts[l2 - 1] + c2, text: q.replacement ?? '', line: l1, endLine: l2 }];
	}).sort((a, b) => a.from - b.from);
	const out: Edit[] = [];
	for(const e of edits) {
		if(out.length === 0 || e.from >= out[out.length - 1].to) {
			out.push(e);
		}
	}
	return out;
}

/** the code with all fixes applied */
export function applyFixes(content: string, fixes: readonly QuickFix[]): string {
	let out = content;
	for(const e of editsOf(content, fixes).reverse()) {
		out = out.slice(0, e.from) + e.text + out.slice(e.to);
	}
	return out;
}

/** how many of the fixes apply (the others overlap an earlier one) */
export function applicableFixes(content: string, fixes: readonly QuickFix[]): number {
	return editsOf(content, fixes).length;
}

/**
 * A unified diff of one file: one hunk per group of nearby fixes, with a line of context around it.
 * Empty when nothing changes.
 */
export function unifiedDiff(path: string, content: string, fixes: readonly QuickFix[], context = 1): string {
	const edits = editsOf(content, fixes);
	if(edits.length === 0) {
		return '';
	}
	const lines = content.split('\n');
	/* a final newline ends the last line, it does not start another */
	if(content.endsWith('\n')) {
		lines.pop();
	}
	/* nearby edits share a hunk, so the context lines of one never overlap the changes of the next */
	const groups: Edit[][] = [];
	for(const e of edits) {
		const g = groups[groups.length - 1];
		if(g && e.line - g[g.length - 1].endLine <= 2 * context + 1) {
			g.push(e);
		} else {
			groups.push([e]);
		}
	}
	const starts = offsets(content);
	const out = [`--- a/${path}`, `+++ b/${path}`];
	let delta = 0;
	for(const g of groups) {
		const first = Math.max(1, g[0].line - context);
		const last = Math.min(lines.length, g[g.length - 1].endLine + context);
		const oldText = lines.slice(first - 1, last).join('\n');
		/* the edits, moved to the start of the hunk's text */
		const base = starts[first - 1];
		let newText = oldText;
		for(const e of [...g].reverse()) {
			newText = newText.slice(0, e.from - base) + e.text + newText.slice(e.to - base);
		}
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		out.push(`@@ -${first},${oldLines.length} +${first + delta},${newLines.length} @@`);
		/* lines before and after the change stay context; the ones between are removed and added */
		let pre = 0;
		while(pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) {
			pre++;
		}
		let post = 0;
		while(post < oldLines.length - pre && post < newLines.length - pre && oldLines[oldLines.length - 1 - post] === newLines[newLines.length - 1 - post]) {
			post++;
		}
		out.push(...oldLines.slice(0, pre).map(l => ` ${l}`),
			...oldLines.slice(pre, oldLines.length - post).map(l => `-${l}`),
			...newLines.slice(pre, newLines.length - post).map(l => `+${l}`),
			...oldLines.slice(oldLines.length - post).map(l => ` ${l}`));
		delta += newLines.length - oldLines.length;
	}
	return out.join('\n') + '\n';
}
