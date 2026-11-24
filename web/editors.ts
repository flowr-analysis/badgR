/** The two editors of the page: R code, and the YAML policy with completion and checking. */
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, foldGutter } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult, completeAnyWord } from '@codemirror/autocomplete';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { yaml } from '@codemirror/lang-yaml';
import { classHighlighter } from '@lezer/highlight';
import { highlighter, rLanguage } from './highlight';
import { FileRoles, Shipped, parsePolicy, PolicyError } from '../src/policy-core';
import type { PolicyVocabulary } from './protocol';

/* the page's content security policy admits CodeMirror's style sheet by this nonce only */
export const StyleNonce = 'badger';

function base(onChange: (text: string) => void): Extension[] {
	return [
		EditorView.cspNonce.of(StyleNonce),
		lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), foldGutter(),
		indentOnInput(), bracketMatching(), closeBrackets(), syntaxHighlighting(highlighter), syntaxHighlighting(classHighlighter),
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
		EditorView.updateListener.of(u => {
			if(u.docChanged) {
				onChange(u.state.doc.toString());
			}
		})
	];
}

/* functions a security review of R code meets most, offered next to the words of the document */
const RWords = ['system', 'system2', 'shell', 'eval', 'parse', 'source', 'download.file', 'readline', 'readRDS', 'saveRDS', 'unlink',
	'file.remove', 'read.csv', 'write.csv', 'library', 'require', 'function', 'shinyApp', 'fluidPage', 'renderText', 'renderPlot',
	'reactive', 'observeEvent', 'paste', 'paste0', 'sprintf', 'Sys.getenv', 'Sys.setenv', 'setwd', 'options'].map(label => ({ label, type: 'function' }));

export function rEditor(parent: HTMLElement, doc: string, onChange: (text: string) => void, onRun: () => void): EditorView {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc,
			extensions: [
				base(onChange), rLanguage, placeholder('R code, e.g. system(readline())'),
				autocompletion({ override: [completeAnyWord, (c: CompletionContext) => {
					const w = c.matchBefore(/[\w.]+/);
					return w && (w.from < w.to || c.explicit) ? { from: w.from, options: RWords } : null;
				}] }),
				keymap.of([{ key: 'Mod-Enter', run: () => {
					onRun();
					return true;
				} }])
			]
		})
	});
}

/* ---------------------------------------------------------------- policy completion */

const TopKeys = ['name', 'version', 'description', 'origins', 'fallbackOrigin', 'capabilities', 'trusted', 'allow', 'shipped', 'report', 'lintTimeout', 'lintReadTimeout', 'timeout', 'tiers', 'fallbackTier'];
const CapabilityKeys = ['class', 'description', 'tags', 'callProps', 'functions', 'exclude', 'unlessCallProps', 'unlessArgProps', 'unlessOrigins', 'dynamic', 'withArgument'];
const TierKeys = ['name', 'color', 'summary', 'review', 'description', 'forbid', 'lint'];
const RuleKeys = ['classes', 'capabilities', 'origins', 'via', 'files', 'reason'];
const Docs: Record<string, string> = {
	origins: 'who controls a value: origin classes of flowR input types', fallbackOrigin: 'the origin class of unlisted input types',
	capabilities: 'what a call can do, grouped into sink classes', trusted: 'package functions whose internal sinks do not count',
	report: 'extra flowR linting rules, reported only', allow: 'calls that never become findings (regular expressions on pkg::fn)',
	shipped: 'flowR file roles that ship: source, test, vignette, install, startup', files: 'file roles the rule applies to, or shipped (default)', lintTimeout: 'seconds one linting rule may run',
	lintReadTimeout: 'seconds a linting worker may take to read the code', timeout: 'seconds the whole analysis may run; none: no limit', tiers: 'strictest first; the first tier no rule blocks is assigned',
	class: 'the sink class of the capability', tags: 'flowR semantic call tags', callProps: 'flowR call properties',
	functions: 'regular expressions; with :: matched against pkg::fn', exclude: 'regular expressions removing matches again',
	unlessCallProps: 'a call with one of these properties does not count', unlessArgProps: 'a call with a parameter of these properties does not count',
	forbid: 'a finding matching one of these rules blocks the tier', lint: 'flowR linting rules that must report nothing',
	classes: 'sink classes the rule matches', via: 'direct: the app\'s own call; package: inside a package', reason: 'shown when the rule blocks the tier',
	name: 'the name of the policy, or of a tier', version: 'the version of the policy, a number', description: 'what the policy, a capability, or a tier is about',
	color: 'the badge color of the tier, e.g. #d4aa32', summary: 'one line for lists and tooltips', review: 'what a person still has to review at this tier',
	fallbackTier: 'the tier of code that meets no tier, or that flowR could not analyze',
	unlessOrigins: 'a call whose values all come from these origin classes does not count',
	withArgument: 'calls that count only when they get this argument, e.g. file: [cat] for cat(x, file = path); argument name to function regexes',
	dynamic: 'true: the capability of calls the analysis cannot resolve to a function (one capability at most)'
};

/* what a file role is, for the completion of `shipped` and `files` */
const RoleDocs: Record<string, string> = {
	source: 'package and app sources (R/, app scripts)', test: 'tests (tests/)', vignette: 'vignettes (vignettes/, inst/doc/)',
	install: 'files installed as they are (inst/)', startup: 'startup files (.Rprofile)', [Shipped]: 'the roles the policy lists in shipped'
};

interface Line { indent: number, key?: string, item: boolean }

function lineInfo(text: string): Line {
	const m = /^(\s*)(- )?\s*([\w-]+)?\s*(:)?/.exec(text) as RegExpExecArray;
	const item = m[2] !== undefined;
	return { indent: m[1].length + (item ? 2 : 0), key: m[4] ? m[3] : undefined, item };
}

/** the keys that lead to the line, from the indentation of the lines above */
function pathAt(lines: readonly string[], at: number, indent: number): string[] {
	const path: string[] = [];
	let limit = indent;
	for(let i = at - 1; i >= 0 && limit > 0; i--) {
		if(/^\s*(#.*)?$/.test(lines[i])) {
			continue;
		}
		const l = lineInfo(lines[i]);
		const own = l.item ? l.indent - 2 : l.indent;
		if(l.key !== undefined && l.indent < limit) {
			path.unshift(l.key);
			limit = own;
		} else if(l.item && own < limit) {
			limit = own;
		}
	}
	return path;
}

function keysFor(path: readonly string[]): string[] | undefined {
	const [first] = path;
	if(path.length === 0) {
		return TopKeys;
	}
	if(first === 'capabilities' && path.length === 2) {
		return CapabilityKeys;
	}
	if(first === 'tiers') {
		return path.at(-1) === 'forbid' ? RuleKeys : TierKeys;
	}
	if(first === 'fallbackTier') {
		return ['name', 'color', 'review'];
	}
	return undefined;
}

function valuesFor(key: string, path: readonly string[], v: PolicyVocabulary, current: string): Completion[] {
	let policy: ReturnType<typeof parsePolicy> | undefined;
	try {
		policy = parsePolicy(current, 'policy', '');
	} catch{ /* incomplete while typing */ }
	const originNames = policy ? Object.keys(policy.origins) : ['author', 'system', 'parameter', 'unknown', 'outside'];
	const classes = policy ? [...new Set(Object.values(policy.capabilities).map(c => c.class))] : ['severe', 'outward', 'other'];
	const list = (xs: readonly string[], type: string, info?: (x: string) => string | undefined) => xs.map(label => ({ label, type, info: info?.(label) }));
	if(path[0] === 'origins') {
		return list(v.inputTypes, 'enum');
	}
	switch(key) {
		case 'tags': return list(v.tags, 'enum');
		case 'callProps': case 'unlessCallProps': return list(v.callProps, 'enum');
		case 'unlessArgProps': return list(v.argProps, 'enum');
		case 'lint': case 'report': return v.lintRules.map(r => ({ label: r.name, type: 'function', detail: r.title, info: r.about }));
		case 'origins': case 'fallbackOrigin': case 'unlessOrigins': return list(originNames, 'variable');
		case 'dynamic': return list(['true', 'false'], 'keyword');
		case 'classes': case 'class': return list(classes, 'type');
		case 'capabilities': return list(policy ? Object.keys(policy.capabilities) : [], 'variable');
		case 'via': return list(['direct', 'package', 'any'], 'keyword', x => ({ direct: 'the app\'s own call', package: 'a call inside a package', any: 'both' } as Record<string, string>)[x]);
		case 'shipped': return list(FileRoles, 'enum', x => RoleDocs[x]);
		case 'files': return list([...FileRoles, Shipped], 'enum', x => RoleDocs[x]);
		case 'fallbackTier': return [];
		case 'color': return list(['\'#d4aa32\'', '\'#aaacb2\'', '\'#b06e3c\'', '\'#6b6b6b\''], 'constant');
		case 'trusted': case 'allow': return list(['\'^pkg::fn$\'', '\'^pkg::\'', '\'^shiny::render\\w+$\''], 'text', () => 'a regular expression on pkg::fn');
		default: return [];
	}
}

function policyCompletion(vocabulary: () => PolicyVocabulary | undefined) {
	return (c: CompletionContext): CompletionResult | null => {
		const v = vocabulary();
		const line = c.state.doc.lineAt(c.pos);
		const before = line.text.slice(0, c.pos - line.from);
		const word = c.matchBefore(/[\w.-]*/);
		if(word === null || /^\s*#/.test(before)) {
			return null;
		}
		const lines = c.state.doc.toString().split('\n');
		const index = line.number - 1;
		/* a value: after `key:` (also inside `[...]`), or a list item below `key:` */
		const valueOf = /^\s*(?:- )?([\w-]+):\s*(?:\[[^\]]*)?[\w.-]*$/.exec(before);
		const item = /^(\s*)- [\w.-]*$/.exec(before);
		if(valueOf !== null && v !== undefined) {
			const path = pathAt(lines, index, lineInfo(line.text).indent);
			return { from: word.from, options: valuesFor(valueOf[1], path, v, c.state.doc.toString()), validFor: /^[\w.-]*$/ };
		}
		if(item !== null && v !== undefined) {
			const path = pathAt(lines, index, item[1].length);
			const options = [...valuesFor(path.at(-1) ?? '', path, v, c.state.doc.toString()),
				...(keysFor(path)?.map(k => ({ label: k + ': ', displayLabel: k, type: 'property', info: Docs[k] })) ?? [])];
			return options.length > 0 ? { from: word.from, options, validFor: /^[\w.-]*$/ } : null;
		}
		/* a key */
		if(/^\s*[\w-]*$/.test(before)) {
			const keys = keysFor(pathAt(lines, index, before.length - (word.to - word.from)));
			return keys ? { from: word.from, options: keys.map(k => ({ label: k + ': ', displayLabel: k, type: 'property', info: Docs[k] })), validFor: /^[\w-]*$/ } : null;
		}
		return null;
	};
}

function policyLinter(view: EditorView): Diagnostic[] {
	const text = view.state.doc.toString();
	try {
		parsePolicy(text, 'policy', '');
		return [];
	} catch(e) {
		const msg = e instanceof Error ? e.message.replace(/^policy: /, '') : String(e);
		/* the YAML parser names a line; badger's own checks name a key, which is looked up */
		const lineNo = /line (\d+)/.exec(msg)?.[1];
		const key = /^([\w.\[\]-]+)/.exec(msg)?.[1]?.split(/[.[\]]/).filter(Boolean).at(-1);
		let from = 0;
		let to = Math.min(text.length, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
		if(lineNo !== undefined && Number(lineNo) <= view.state.doc.lines) {
			const l = view.state.doc.line(Number(lineNo));
			from = l.from;
			to = l.to;
		} else if(key !== undefined && !/^\d+$/.test(key)) {
			const at = new RegExp(`^\\s*(- )?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').exec(text);
			if(at) {
				from = at.index;
				to = text.indexOf('\n', from) < 0 ? text.length : text.indexOf('\n', from);
			}
		}
		return [{ from, to, severity: 'error', message: e instanceof PolicyError || e instanceof Error ? msg : String(e) }];
	}
}

export function policyEditor(parent: HTMLElement, doc: string, onChange: (text: string) => void, vocabulary: () => PolicyVocabulary | undefined): EditorView {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc,
			extensions: [
				base(onChange), yaml(), lintGutter(), linter(policyLinter, { delay: 300 }),
				autocompletion({ override: [policyCompletion(vocabulary)], activateOnTyping: true })
			]
		})
	});
}

export function setText(view: EditorView, text: string): void {
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
