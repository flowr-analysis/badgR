/** The badgR playground: input on the left, report on the right. Nothing here sends data anywhere. */
import type { EditorView } from '@codemirror/view';
import { type BadgeMarks, badgeSvg, badgeTitle, yamlShape } from '../src/badge';
import { findingAt, lintAt, parseAt, sarifLog } from '../src/sarif';
import type { FlowrQueryRecord, Progress, Report } from '../src/core';
import { type Finding, type LintResult, type QuickFix, assignTier } from '../src/tiers';
import { type FileRoleName, type Policy, FileRoles, parsePolicy, PolicyError, lintRulesOf } from '../src/policy-core';
import { markdownReport } from '../src/report';
import { ReviewLabel, ReviewStates, findingKey, reviewCounts, reviewFile, reviewSummary, parseReview, type ReviewEntry, type ReviewState } from '../src/review';
import type { PolicyVocabulary, SourceFile, WorkerRequest, WorkerResponse } from './protocol';
import { SourceError, describeUrl, fromDrop, fromFiles, fromUrl, inflateLimited } from './sources';
import { Playground } from '@eagleoutice/flowr/util/text/playground-link';
import { deflateSync, strFromU8, strToU8 } from 'fflate';
import defaultPolicy from '../policies/default.yaml';
import { Examples } from './examples';
import { highlightLines } from './highlight';
import { applicableFixes, applyFixes, unifiedDiff } from './patch';
import { policyEditor, rEditor, setText } from './editors';
import { renderVisual } from './policy-visual';

declare const BADGR_VERSION: string;
declare const FLOWR_VERSION: string;
declare const BADGR_LIVE: boolean;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag);
	if(cls) {
		e.className = cls;
	}
	if(text !== undefined) {
		e.textContent = text;
	}
	return e;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`;
const link = (href: string, text: string, title?: string) => {
	const a = el('a', '', text);
	a.href = href;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	if(title) {
		a.title = title;
	}
	return a;
};

/* ---------------------------------------------------------------- worker, started at once */

const base = new URL('.', location.href).href;
const worker = new Worker('worker.js');
let vocabulary: PolicyVocabulary | undefined;
let sigdbTag: string | undefined;
let nextId = 0;
let running: { id: number, resolve: (r: Report) => void, reject: (e: Error) => void, onProgress: (p: Progress) => void, onPartial: (r: Report) => void } | undefined;

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
	const m = ev.data;
	if(m.type === 'ready') {
		vocabulary = m.vocabulary;
		sigdbTag = m.sigdb;
		showVersions();
		drawPolicyGrid();
		return;
	}
	if(running === undefined || m.id !== running.id) {
		return;
	}
	if(m.type === 'progress') {
		running.onProgress(m.progress);
	} else if(m.type === 'partial') {
		running.onPartial(m.report);
	} else if(m.type === 'report') {
		running.resolve(m.report);
	} else {
		running.reject(new Error(m.error));
	}
};
worker.postMessage({ type: 'warm', base } satisfies WorkerRequest);

const BadgrReleases = 'https://github.com/flowr-analysis/badgR/releases';
const DockerHub = 'https://hub.docker.com/r/eagleoutice/badgr';

function showVersions(): void {
	const f = $<HTMLAnchorElement>('v-flowr');
	f.querySelector('.v')!.textContent = FLOWR_VERSION;
	f.href = `https://github.com/flowr-analysis/flowr/releases/tag/v${FLOWR_VERSION}`;
	$('v-sigdb').querySelector('.v')!.textContent = sigdbTag ?? '…';
	$('v-badgr').querySelector('.v')!.textContent = BADGR_VERSION;
	const foot = $('footer');
	foot.replaceChildren(link(BadgrReleases, `badgR ${BADGR_VERSION}`), ' (', link('https://github.com/flowr-analysis/badgR', 'source'), ') · ', link(f.href, `flowR ${FLOWR_VERSION}`), ' · ', link(DockerHub, 'Docker image'),
		` · signature database ${sigdbTag ?? '?'}, latest version of each CRAN package (the command line has every version) · GPL-3.0`);
}
showVersions();
if(BADGR_LIVE) {
	/* `npm run web:dev`: reload when a rebuild lands */
	new EventSource('/__live').onmessage = () => location.reload();
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- light, dark, or as the system */

const Themes = ['auto', 'light', 'dark'] as const;
type Theme = typeof Themes[number];
function applyTheme(t: Theme): void {
	if(t === 'auto') {
		document.documentElement.removeAttribute('data-theme');
	} else {
		document.documentElement.dataset.theme = t;
	}
	const b = $('theme');
	b.textContent = t === 'auto' ? 'auto' : t === 'light' ? '☀ light' : '☾ dark';
	b.title = `theme: ${t === 'auto' ? 'as the system' : t}. Click to switch.`;
}
let theme: Theme = (() => {
	try {
		const t = localStorage.getItem('badgr.theme');
		return Themes.includes(t as Theme) ? t as Theme : 'auto';
	} catch{
		return 'auto';
	}
})();
applyTheme(theme);
$('theme').addEventListener('click', () => {
	theme = Themes[(Themes.indexOf(theme) + 1) % Themes.length];
	applyTheme(theme);
	try {
		localStorage.setItem('badgr.theme', theme);
	} catch{ /* private mode: the theme lasts as long as the page */ }
});

/* ---------------------------------------------------------------- tooltips in the page's style */

/* every `title` shows in a tooltip of the page instead of the browser's, also on focus for the keyboard */
const tip = el('div', 'tip');
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);
let tipFor: HTMLElement | undefined;
function showTip(target: HTMLElement): void {
	const text = target.dataset.tip ?? target.title;
	if(!text) {
		return;
	}
	if(target.title) {
		target.dataset.tip = target.title;
		target.removeAttribute('title');
	}
	tipFor = target;
	tip.textContent = text;
	tip.hidden = false;
	const r = target.getBoundingClientRect();
	const w = tip.offsetWidth;
	const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
	const below = r.bottom + 8 + tip.offsetHeight < innerHeight;
	tip.style.left = `${left + scrollX}px`;
	tip.style.top = `${(below ? r.bottom + 6 : r.top - tip.offsetHeight - 6) + scrollY}px`;
}
function hideTip(): void {
	tip.hidden = true;
	tipFor = undefined;
}
const tipTarget = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]') ?? undefined;
document.addEventListener('mouseover', e => {
	const t = tipTarget(e);
	if(t && t !== tipFor && !t.closest('.cm-editor')) {
		showTip(t);
	} else if(!t) {
		hideTip();
	}
});
document.addEventListener('focusin', e => {
	const t = tipTarget(e);
	if(t && !t.closest('.cm-editor')) {
		showTip(t);
	}
});
document.addEventListener('focusout', hideTip);
document.addEventListener('scroll', hideTip, true);

/* the popover of the code closes on Escape and on a click elsewhere */
document.addEventListener('keydown', e => {
	if(e.key === 'Escape') {
		$('popover').hidden = true;
	}
});
document.addEventListener('click', e => {
	const t = e.target as Element;
	/* an open menu closes on a click elsewhere */
	document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach(m => {
		if(!m.contains(t)) {
			m.open = false;
		}
	});
	if(!t.closest('#popover, .code [class^="m-"], .code [class*=" m-"], .fn-link, #findings tr, .jump, .matrix span')) {
		$('popover').hidden = true;
	}
});

/* ---------------------------------------------------------------- tabs */

for(const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
	tab.addEventListener('click', () => {
		for(const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
			t.setAttribute('aria-selected', String(t === tab));
		}
		for(const p of document.querySelectorAll<HTMLElement>('[data-panel]')) {
			p.hidden = p.dataset.panel !== tab.dataset.tab;
		}
	});
}

/* ---------------------------------------------------------------- policy */

/** the same policy, whatever its comments and layout */
function samePolicy(a: string, b: string): boolean {
	const shape = yamlShape(a);
	return a === b || (shape !== undefined && shape === yamlShape(b));
}
const defaultShape = yamlShape(defaultPolicy);
/** whether a policy is the default one, in content */
function isDefault(text: string): boolean {
	if(text === defaultPolicy) {
		return true;
	}
	return yamlShape(text) === defaultShape;
}

const PolicyKey = 'badgr.policy';
const stored = (() => {
	try {
		return localStorage.getItem(PolicyKey) ?? undefined;
	} catch{
		return undefined;
	}
})();
let policyText = stored ?? defaultPolicy;
let policy: Policy | undefined;

function readPolicy(): boolean {
	try {
		policy = parsePolicy(policyText, 'policy', '');
		$('policy-status').textContent = isDefault(policyText) ? 'default policy' : 'custom policy: badges mark its tiers with *';
		$('policy-status').classList.remove('bad');
		$<HTMLButtonElement>('policy-reset').disabled = isDefault(policyText);
		return true;
	} catch(e) {
		$('policy-status').textContent = e instanceof PolicyError || e instanceof Error ? e.message.replace(/^policy: /, '') : String(e);
		$('policy-status').classList.add('bad');
		$<HTMLButtonElement>('policy-reset').disabled = false;
		return false;
	}
}

let gridTimer: number | undefined;
function drawPolicyGrid(): void {
	clearTimeout(gridTimer);
	gridTimer = window.setTimeout(() => renderVisual($('policy-visual'), policyText, vocabulary, text => {
		/* a grid edit that leads back to the default brings back its text, comments included */
		setText(yamlView, isDefault(text) ? defaultPolicy : text);
	}, { calls: [...new Set(last?.report.findings.map(f => f.call) ?? [])] }), 30);
}

function policyChanged(text: string): void {
	policyText = text;
	if(!readPolicy()) {
		return;
	}
	try {
		if(text === defaultPolicy) {
			localStorage.removeItem(PolicyKey);
		} else {
			localStorage.setItem(PolicyKey, text);
		}
	} catch{ /* private mode: the policy lasts as long as the page */ }
	drawPolicyGrid();
	drawTierTable();
	retier();
}

const yamlView: EditorView = policyEditor($('policy'), policyText, policyChanged, () => vocabulary);
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
	b.addEventListener('click', () => {
		for(const o of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
			o.setAttribute('aria-pressed', String(o === b));
		}
		$('policy-visual').hidden = b.dataset.view !== 'grid';
		$('policy').hidden = b.dataset.view !== 'yaml';
	});
}
/** says the policy changed, with a button that brings back the one before */
function policyNote(message: string, previous: string): void {
	const undo = () => {
		setText(yamlView, previous);
		clearPolicyNote();
	};
	for(const id of ['notice', 'policy-note']) {
		const box = $(id);
		const b = el('button', 'button secondary small', isDefault(previous) ? 'Back to the default' : 'Keep my policy');
		b.type = 'button';
		b.addEventListener('click', undo);
		box.replaceChildren(el('span', '', message + ' '), b);
		box.hidden = false;
	}
	if(previous === policyText) {
		clearPolicyNote();
	}
}
function clearPolicyNote(): void {
	$('notice').hidden = true;
	$('policy-note').hidden = true;
}
$('policy-reset').addEventListener('click', () => {
	const mine = policyText;
	if(mine === defaultPolicy) {
		return;
	}
	setText(yamlView, defaultPolicy);
	policyNote('The policy is back to the default.', mine);
	for(const id of ['notice', 'policy-note']) {
		$(id).querySelector('button')?.replaceChildren('Undo');
	}
});
$('policy-copy').addEventListener('click', () => {
	const url = isDefault(policyText) ? base : `${base}#p=${b64url(deflateSync(strToU8(policyText), { level: 9 }))}`;
	void navigator.clipboard?.writeText(url).then(() => {
		$('policy-copy').textContent = 'copied';
		setTimeout(() => {
			$('policy-copy').textContent = 'copy policy link';
		}, 1500);
	}, () => showError(`Copy this link by hand: ${url}`));
});
readPolicy();
drawPolicyGrid();

/* ---------------------------------------------------------------- progress */

/*
 * The progress box only ever touches its own few elements: progress can arrive every few hundred
 * milliseconds and must never redraw the report. Until the first partial report it floats over the report
 * (it takes no space, so nothing moves); once a partial report shows, it sits above it.
 */
const StepNames: [Progress['phase'] | 'fetch', string][] = [['fetch', 'fetch'], ['files', 'files'], ['dataflow', 'dataflow'], ['sinks', 'risky calls'], ['origins', 'value sources'], ['lint', 'linting rules']];

/** a duration, short */
function duration(ms: number): string {
	if(ms < 1) {
		return '<1 ms';
	}
	if(ms < 1000) {
		return `${Math.round(ms)} ms`;
	}
	if(ms < 60_000) {
		return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	}
	const min = Math.floor(ms / 60_000);
	const sec = Math.round(ms % 60_000 / 1000);
	return sec === 0 || sec === 60 ? `${min + (sec === 60 ? 1 : 0)} min` : `${min} min ${sec} s`;
}

interface ProgressBox {
	(p: Progress | string): void
	/** stops the clock */
	stop(): void
	/** a partial report shows: the box now sits above it instead of over it */
	attach(): void
}

function showProgress(label: string): ProgressBox {
	const box = $('progress');
	box.hidden = false;
	box.classList.remove('attached');
	$('error').hidden = true;
	$('empty').hidden = true;
	const fill = $('bar-fill');
	const text = $('progress-text');
	const count = $('progress-count');
	const started = performance.now();
	const steps = StepNames.map(([, name], i) => {
		const span = el('span', i === 0 ? 'step active' : 'step');
		const time = el('span', 'step-time');
		span.append(el('span', 'step-name', name), time);
		return { span, time, from: i === 0 ? started : undefined as number | undefined, eta: undefined as { ms: number, at: number } | undefined };
	});
	$('steps').replaceChildren(...steps.map(s => s.span));
	fill.className = 'indeterminate';
	fill.style.width = '';
	count.textContent = '';
	let at = 0;
	let message = label;
	/* floating: a negative margin as tall as the box, set at once so the report does not move even for a frame */
	let attached = false;
	let height = -1;
	const place = () => {
		const h = attached ? -1 : box.getBoundingClientRect().height;
		if(h !== height) {
			height = h;
			box.style.marginBottom = attached ? '' : `-${h}px`;
		}
	};
	const resized = new ResizeObserver(place);
	resized.observe(box);
	const clock = $('progress-clock');
	/* the time left, as the worker last said, counted down here between its messages */
	let eta: { ms: number, at: number } | undefined;
	const left = (now: number) => {
		if(eta === undefined) {
			return 'estimating…';
		}
		const ms = eta.ms - (now - eta.at);
		if(ms <= 0) {
			return 'taking longer than estimated';
		}
		const s = duration(Math.max(1000, Math.ceil(ms / 1000) * 1000));
		return `about ${s} left`;
	};
	const paint = () => {
		const now = performance.now();
		const from = steps[at].from;
		/* the step's own time left, next to its time so far */
		const own = steps[at].eta;
		const rest = own === undefined ? undefined : own.ms - (now - own.at);
		steps[at].time.textContent = from === undefined ? '' : `${duration(now - from)}${rest === undefined ? '' : rest > 0 ? ` · ~${duration(Math.max(1000, Math.ceil(rest / 1000) * 1000))} left` : ' · over estimate'}`;
		clock.textContent = `${duration(now - started)} · ${left(now)}`;
		if(text.textContent !== message) {
			text.textContent = message;
		}
		/* the box may have grown with its text: still no space taken, even without a frame for the observer */
		place();
	};
	paint();
	const tick = setInterval(paint, 250);
	const update = (p: Progress | string) => {
		if(typeof p === 'string') {
			message = p;
			fill.className = 'indeterminate';
			fill.style.width = '';
			count.textContent = '';
			paint();
			return;
		}
		if(p.phase === 'done') {
			return;
		}
		if(p.etaMs !== undefined) {
			eta = { ms: p.etaMs, at: performance.now() };
		}
		const i = StepNames.findIndex(([phase]) => phase === p.phase);
		/* the linting rules run beside the rest: a late message of an earlier step only updates the time left */
		if(i < at) {
			paint();
			return;
		}
		/* steps only go forward; a step that was skipped gets no time */
		if(i > at) {
			const now = performance.now();
			for(let j = at; j < i; j++) {
				const from = steps[j].from;
				steps[j].span.className = 'step done';
				steps[j].time.textContent = from === undefined ? '' : duration(now - from);
			}
			steps[i].from = now;
			steps[i].span.className = 'step active';
			at = i;
		}
		message = p.message;
		/* the step's time left: as the analysis estimates it, else from how fast its count goes */
		const step = steps[at];
		const now = performance.now();
		if(p.phaseEtaMs !== undefined) {
			step.eta = { ms: p.phaseEtaMs, at: now };
		} else if(p.total && p.done && step.from !== undefined && p.done < p.total) {
			step.eta = { ms: (now - step.from) / p.done * (p.total - p.done), at: now };
		}
		if(p.total) {
			const done = Math.min(p.done ?? 0, p.total);
			fill.className = '';
			fill.style.width = `${Math.round(100 * done / p.total)}%`;
			count.textContent = `${done} of ${p.total}`;
		} else {
			fill.className = 'indeterminate';
			fill.style.width = '';
			count.textContent = '';
		}
		paint();
	};
	return Object.assign(update, {
		stop: () => {
			clearInterval(tick);
			resized.disconnect();
		},
		attach: () => {
			attached = true;
			box.classList.add('attached');
			place();
		}
	});
}

/**
 * Keeps what the reader looks at in place while the report above it changes: the first section of the
 * report that reaches into the window is measured before and after, and the page scrolls by the difference.
 */
function keepPlace(): () => void {
	const sections = [...document.querySelectorAll<HTMLElement>('#result > .verdict, #result > .block')];
	const anchor = sections.find(s => s.getBoundingClientRect().bottom > 0);
	if(anchor === undefined || scrollY === 0) {
		return () => {};
	}
	const before = anchor.getBoundingClientRect().top;
	return () => {
		const moved = anchor.getBoundingClientRect().top - before;
		if(moved !== 0) {
			scrollBy(0, moved);
		}
	};
}

function showError(msg: string): void {
	$('progress').hidden = true;
	const e = $('error');
	e.hidden = false;
	e.textContent = msg;
	/* a link that shows only an export shows the error in its place */
	const raw = document.getElementById('raw');
	if(raw !== null && raw.dataset.state === 'running') {
		raw.textContent = `badgR could not make this export: ${msg}`;
		raw.dataset.state = 'error';
	}
}

/* ---------------------------------------------------------------- analysis, with a cache per code and policy */

/** where the analyzed code came from, which decides whether a link can bring it back */
type Source = { kind: 'code' } | { kind: 'url', url: string } | { kind: 'files' };
interface Run { report: Report, files: readonly SourceFile[], policyText: string, fromEditor: boolean, source: Source }
const cache = new Map<string, Run>();
let last: Run | undefined;
let busy = false;
let queued: (() => void) | undefined;

const keyOf = (files: readonly SourceFile[], text: string) => sha256(`${text}\u0000${JSON.stringify(files)}`);

async function analyze(target: string, load: (progress: (msg: string) => void) => Promise<SourceFile[]>, source: Source = { kind: 'files' }, then?: () => void): Promise<void> {
	const fromEditor = source.kind === 'code';
	if(busy) {
		queued = () => void analyze(target, load, source, then);
		return;
	}
	if(!readPolicy()) {
		showError(`The policy is not valid: ${$('policy-status').textContent}`);
		return;
	}
	busy = true;
	selected = undefined;
	document.body.classList.add('busy');
	const update = showProgress(`reading ${target}`);
	let partial = false;
	try {
		const files = await load(m => update(m));
		const text = policyText;
		const key = await keyOf(files, text);
		let run = cache.get(key);
		if(run === undefined) {
			const id = ++nextId;
			const report = await new Promise<Report>((resolve, reject) => {
				running = { id, resolve, reject, onProgress: update, onPartial: r => {
					/* the findings are final, the linting rules come in one by one */
					const keep = partial ? keepPlace() : () => {};
					update.attach();
					show({ report: { ...r, target }, files, policyText: text, fromEditor, source }, partial ? 'partial' : 'full');
					partial = true;
					keep();
				} };
				void sha256(text).then(policyHash => worker.postMessage({
					type: 'analyze', id, base, target, files, policyText: text,
					policyName: isDefault(text) ? 'default.yaml' : 'custom policy', policyHash, policyModified: !isDefault(text)
				} satisfies WorkerRequest));
			});
			run = { report, files, policyText: text, fromEditor, source };
			cache.set(key, run);
		}
		update.stop();
		const keep = keepPlace();
		$('progress').hidden = true;
		show({ ...run, report: { ...run.report, target }, fromEditor, source }, partial ? 'final' : 'full');
		keep();
		then?.();
	} catch(e) {
		update.stop();
		if(partial) {
			/* a provisional tier is no result */
			$('result').hidden = true;
		}
		showError(e instanceof SourceError || e instanceof Error ? e.message : String(e));
	} finally {
		busy = false;
		running = undefined;
		document.body.classList.remove('busy');
		const next = queued;
		queued = undefined;
		next?.();
	}
}

/** what the report on the page shows, so a partial report and the final one only redraw what changed */
let drawn: { files: readonly SourceFile[], target: string, findings: string, lintResults: number } | undefined;
const findingIds = (r: Report) => r.findings.map(f => f.id).join('\u0000');

/**
 * `full` draws a report anew; `partial` and `final` follow a partial report of the same run and keep
 * the findings table, the code view, and what is open as it is. Only a complete report goes into the link.
 */
function show(run: Run, mode: 'full' | 'partial' | 'final' = 'full'): void {
	const calls = (r?: Report) => [...new Set(r?.findings.map(f => f.call) ?? [])].join('\u0000');
	const newCalls = calls(last?.report) !== calls(run.report);
	last = run;
	if(newCalls) {
		/* the grid suggests the calls of the report for trusted and allowed calls */
		drawPolicyGrid();
	}
	$('empty').hidden = true;
	$('shared').hidden = true;
	const same = mode !== 'full' && drawn !== undefined && drawn.files === run.files && drawn.target === run.report.target && drawn.findings === findingIds(run.report);
	render(run.report, run.files, same);
	markStale();
	/* only a complete report goes into the link */
	if(mode !== 'partial' && run.report.pending === undefined) {
		writeLink();
		if(rawView !== undefined) {
			showRaw(rawView, run.report, run.files);
		}
		if(exportAfter !== undefined) {
			const kind = exportAfter;
			exportAfter = undefined;
			exportNow(kind, run.report, run.files);
		}
	}
}

/* ---------------------------------------------------------------- links that bring the result back */

/**
 * The page's address names the analyzed code (inline, compressed, for code from the editor; the URL for a
 * fetched repository or file), the tier and the number of findings it got, and the selected result. Opening
 * the link shows this at once and analyzes the code again. The hash never reaches a server.
 */
let selected: string | undefined;

function b64url(bytes: Uint8Array): string {
	let bin = '';
	for(const b of bytes) {
		bin += String.fromCharCode(b);
	}
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text: string): Uint8Array {
	const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * The parameters of a link to the result, always in the same order and with the same encoding, so the
 * same code, policy, review, and selection give the same link: the code (`url`, or `z` for the editor's
 * code), the policy if it is not the default (`p`), the review (`rv`, sorted), the tier and number of
 * findings it got, and the selection (`at`). `export` makes the page download a file once it is done.
 */
function linkParams(over: { at?: string, export?: string, view?: string } = {}): URLSearchParams | undefined {
	if(last === undefined || last.source.kind === 'files') {
		return undefined;
	}
	const q = new URLSearchParams();
	if(last.source.kind === 'url') {
		q.set('url', last.source.url);
	} else {
		q.set('z', b64url(deflateSync(strToU8(codeView.state.doc.toString()), { level: 9 })));
	}
	if(!isDefault(last.policyText)) {
		q.set('p', b64url(deflateSync(strToU8(last.policyText), { level: 9 })));
	}
	const byKey = new Map<string, ReviewEntry>();
	for(const e of last.report.findings.map(reviewOf)) {
		if(e !== undefined && !byKey.has(e.key)) {
			byKey.set(e.key, e);
		}
	}
	/* by code point, not by locale, so every browser makes the same link */
	const decided = [...byKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	if(decided.length > 0) {
		q.set('rv', b64url(deflateSync(strToU8(JSON.stringify(decided)), { level: 9 })));
	}
	q.set('tier', last.report.tier.tier);
	q.set('n', String(last.report.findings.length));
	const at = over.at ?? selected;
	if(at !== undefined) {
		q.set('at', at);
	}
	if(over.export !== undefined) {
		q.set('export', over.export);
	}
	if(over.view !== undefined) {
		q.set('view', over.view);
	}
	return q;
}

function writeLink(): void {
	/* a link that shows only an export keeps its address, so reloading it shows the export again */
	if(rawView !== undefined) {
		return;
	}
	const q = linkParams();
	history.replaceState(null, '', q ? `#${q.toString()}` : location.pathname);
}

/** a full link to the result, or the page itself for uploads, which cannot go into a link */
function linkTo(over: { at?: string, export?: string, view?: string } = {}): string {
	const q = linkParams(over);
	return q ? `${base}#${q.toString()}` : base;
}

/** what the badge marks: a custom policy, and a review that decided every finding and left none to fix */
function badgeMarks(r: Report): BadgeMarks {
	return {
		custom:   r.policy.modified ?? !isDefault(policyText),
		reviewed: (r.pending ?? []).length === 0 && reviewSummary(reviewed(r).findings).complete
	};
}

/** the report as SARIF, with links to each result when the code can go into a link */
function sarifText(r: Report, files: readonly SourceFile[]): string {
	const lines = new Map(files.map(f => [f.path, f.content.split('\n')]));
	const first = files.find(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path))?.path;
	const shareable = last !== undefined && last.source.kind !== 'files';
	return JSON.stringify(sarifLog([reviewed(r)], {
		fileOf:       f => f ?? first,
		lineOf:       (f, line) => lines.get(f ?? first ?? '')?.[line - 1],
		capabilities: policy?.capabilities,
		linkOf:       shareable ? at => linkTo({ at }) : undefined
	}), null, 2) + '\n';
}

/** the files a link can ask for with `export=` */
const Exports: Record<string, (r: Report, files: readonly SourceFile[]) => [string, string, string]> = {
	sarif:  (r, files) => ['report.sarif', 'application/sarif+json', sarifText(r, files)],
	json:   r => ['report.json', 'application/json', JSON.stringify(reviewed(r), null, 2)],
	md:     r => ['report.md', 'text/markdown', markdownReport(reviewed(r))],
	badge:  r => ['badge.svg', 'image/svg+xml', badgeSvg(r.tier.tier, r.tier.color, badgeMarks(r))],
	review: r => ['review.json', 'application/json', JSON.stringify(reviewFile(r.findings.map(reviewOf).filter((e): e is ReviewEntry => e !== undefined)), null, 2)]
};
/** set by a link with `export=`: the file to download once the analysis is done */
let exportAfter: string | undefined;
/** set by a link with `view=`: the page shows only this export, as text, once the analysis is done */
let rawView: string | undefined;

/** the page as one export only: `view=sarif` shows the SARIF of the code, analyzed again, and nothing else */
function startRaw(kind: string): void {
	if(!Object.hasOwn(Exports, kind)) {
		showError(`A link can show ${Object.keys(Exports).join(', ')}, not ${kind}.`);
		return;
	}
	rawView = kind;
	document.body.classList.add('raw-view');
	const pre = el('pre', 'raw', `analyzing the code again for ${kind === 'sarif' ? 'SARIF' : kind}…`);
	pre.id = 'raw';
	pre.dataset.state = 'running';
	document.body.append(pre);
}

function showRaw(kind: string, r: Report, files: readonly SourceFile[]): void {
	const [name, , content] = Exports[kind](r, files);
	const pre = $('raw');
	pre.textContent = content;
	pre.dataset.state = 'done';
	document.title = name;
}

function exportNow(kind: string, r: Report, files: readonly SourceFile[]): void {
	const make = Object.hasOwn(Exports, kind) ? Exports[kind] : undefined;
	if(make === undefined) {
		showError(`A link can export ${Object.keys(Exports).join(', ')}, not ${kind}.`);
		return;
	}
	const [name, type, content] = make(r, files);
	const a = el('a');
	a.download = name;
	a.href = URL.createObjectURL(new Blob([content], { type }));
	a.dataset.export = kind;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** the same code in flowR's playground, with the lines of the findings marked */
function playgroundLink(r: Report, files: readonly SourceFile[]): HTMLElement {
	const rFiles = files.filter(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path));
	const main = rFiles.find(f => r.findings.some(x => x.file === f.path)) ?? rFiles[0];
	const marks = r.findings.filter(f => (f.file ?? main?.path) === main?.path && f.loc).map(f => `${f.loc?.[0]}` as `${number}`);
	const url = main === undefined ? undefined : Playground.link({
		code: main.content, name: main.path, files: rFiles.filter(f => f !== main).map(f => ({ name: f.path, code: f.content })), marks
	});
	if(url === undefined || url.length > 4000) {
		const b = el('button', 'button secondary small', 'flowR playground');
		b.type = 'button';
		b.disabled = true;
		b.title = 'the code is too long for a link to the flowR playground';
		return b;
	}
	const a = link(url, 'flowR playground', 'open this code in flowR\'s playground, with the lines of the findings marked, to see its dataflow, slices, and linting results');
	a.className = 'button secondary small';
	return a;
}

/** a menu of what to copy: links to this result, to its SARIF, and the report as Markdown */
function shareMenu(r: Report): HTMLElement {
	const shareable = last !== undefined && last.source.kind !== 'files';
	const menu = el('details', 'menu');
	menu.id = 'share-menu';
	menu.dataset.key = 'share';
	const summary = el('summary', 'button secondary small', 'copy link');
	summary.title = shareable
		? 'links to this result. The code is inside the link and never goes to a server.'
		: 'uploaded files cannot go into a link. Copy the Markdown or download report.md instead.';
	const list = el('div', 'menu-list');
	const links = [
		copyButton('link to this result', () => linkTo(), 'opens this page with the code, the policy, your review, and the selected result, and analyzes it again'),
		copyButton('SARIF link', () => linkTo({ view: 'sarif' }), 'opens as the SARIF of this code only: the page analyzes it again and shows nothing but report.sarif'),
		copyButton('SARIF download link', () => linkTo({ export: 'sarif' }), 'opens this page, analyzes the code again, and downloads report.sarif')
	];
	for(const b of links) {
		b.disabled = !shareable;
	}
	list.append(...links, copyButton('Markdown report', () => markdownReport(reviewed(r)), 'the report as Markdown, with your review, to paste into an issue'));
	menu.append(summary, list);
	return menu;
}

/** a policy change that keeps the findings (only tiers changed) is re-tiered here, without flowR */
function retier(): void {
	if(last === undefined || policy === undefined) {
		return;
	}
	let old: Policy;
	try {
		old = parsePolicy(last.policyText, 'policy', '');
	} catch{
		return;
	}
	const core = (p: Policy) => JSON.stringify([p.origins, p.fallbackOrigin, p.capabilities, p.trusted, p.allow]);
	const ran = new Set(last.report.lint.map(l => l.rule));
	if(core(old) !== core(policy) || !lintRulesOf(policy).every(r => ran.has(r))) {
		$('result').classList.add('stale');
		$('code-status').textContent = 'the policy changed what is analyzed. Analyze again.';
		return;
	}
	const report: Report = {
		...last.report,
		tier:   assignTier(policy, last.report.findings, last.report.lint, last.report.analyzed),
		policy: { ...last.report.policy, name: isDefault(policyText) ? 'default.yaml' : 'custom policy', modified: !isDefault(policyText) }
	};
	last = { ...last, report, policyText };
	render(report, last.files);
	markStale();
}

/* ---------------------------------------------------------------- inputs */

const drop = $('drop');
$<HTMLInputElement>('file-input').addEventListener('change', ev => {
	const input = ev.target as HTMLInputElement;
	const list = [...input.files ?? []];
	void analyze(list.length === 1 ? list[0].name : `${list.length} files`, () => fromFiles(list));
	input.value = '';
});
$<HTMLInputElement>('folder-input').addEventListener('change', ev => {
	const input = ev.target as HTMLInputElement;
	const list = [...input.files ?? []];
	void analyze(list[0]?.webkitRelativePath.split('/')[0] ?? 'folder', () => fromFiles(list));
	input.value = '';
});
drop.addEventListener('dragover', ev => {
	ev.preventDefault();
	drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', ev => {
	ev.preventDefault();
	drop.classList.remove('over');
	const items = ev.dataTransfer?.items;
	if(items) {
		void analyze(items[0]?.webkitGetAsEntry()?.name ?? 'dropped files', () => fromDrop(items));
	}
});
/* the names of the packages the page has data for, offered while typing a bare name */
let packageNames: Promise<string[]> | undefined;
async function suggestPackages(text: string): Promise<void> {
	const t = text.trim().replace(/^cran:\s*/i, '');
	const list = $('url-packages');
	if(!/^[A-Za-z][\w.]*$/.test(t) || t.length < 2) {
		list.replaceChildren();
		return;
	}
	packageNames ??= fetch(`${base}pkgs/index.json`).then(r => r.json() as Promise<{ packages: Record<string, string> }>)
		.then(i => Object.keys(i.packages).sort((a, b) => a.localeCompare(b))).catch(() => []);
	const lower = t.toLowerCase();
	const names = (await packageNames).filter(n => n.toLowerCase().startsWith(lower)).slice(0, 30);
	list.replaceChildren(...names.map(n => {
		const o = el('option');
		o.value = n;
		return o;
	}));
}
$<HTMLInputElement>('url-input').addEventListener('input', () => {
	void suggestPackages($<HTMLInputElement>('url-input').value);
	const d = describeUrl($<HTMLInputElement>('url-input').value);
	$('url-note').textContent = d ? sentence(d.note) + '.' : '';
	$('url-note').classList.toggle('bad', d?.kind === 'shiny-deployment');
});
$('url-form').addEventListener('submit', ev => {
	ev.preventDefault();
	const url = $<HTMLInputElement>('url-input').value.trim();
	void analyze(url, progress => fromUrl(url, progress), { kind: 'url', url });
});

/* the editor: an example only loads its code (and its result, if analyzed before); Analyze or live mode runs */
const liveButton = $<HTMLButtonElement>('live');
const live = { get checked(): boolean {
	return liveButton.getAttribute('aria-pressed') === 'true';
} };
let liveTimer: number | undefined;
const editorFiles = (): SourceFile[] => {
	const text = codeView.state.doc.toString();
	const ex = Examples.find(e => e.files.map(f => f.content).join('\n') === text);
	return ex ? ex.files : [{ path: 'script.R', content: text }];
};
const editorTarget = () => {
	const text = codeView.state.doc.toString();
	return `${Examples.find(e => e.files.map(f => f.content).join('\n') === text)?.label.replace(/^/, 'example: ') ?? 'pasted code'}`;
};
const runEditor = (then?: () => void) => void analyze(editorTarget(), async() => editorFiles(), { kind: 'code' }, then);

function markStale(): void {
	const edited = last?.fromEditor === true && JSON.stringify(last.files) !== JSON.stringify(editorFiles());
	$('result').classList.toggle('stale', edited);
	$('code-status').textContent = edited ? 'edited since the analysis' : '';
}

async function showCached(): Promise<void> {
	const run = cache.get(await keyOf(editorFiles(), policyText));
	if(run !== undefined) {
		show({ ...run, report: { ...run.report, target: editorTarget() }, fromEditor: true, source: { kind: 'code' } });
	}
}

const codeView: EditorView = rEditor($('code'), Examples[0].files[0].content, () => {
	markExample();
	markStale();
	void showCached();
	if(live.checked) {
		clearTimeout(liveTimer);
		liveTimer = window.setTimeout(runEditor, 600);
	}
}, runEditor);
/* the examples, one per tier, in a menu: the badge it gets and what the code does */
function markExample(): void {
	const text = codeView.state.doc.toString();
	const ex = Examples.find(e => e.files.map(f => f.content).join('\n') === text);
	$('examples-label').textContent = ex ? `Example: ${ex.label}` : 'Load an example';
	for(const b of $('examples').children) {
		b.setAttribute('aria-current', String((b as HTMLElement).dataset.label === ex?.label));
	}
}
for(const ex of Examples) {
	const b = el('button', 'ex');
	b.type = 'button';
	b.dataset.label = ex.label;
	const img = el('img');
	img.alt = '';
	const tier = policy?.tiers.find(t => t.name === ex.label);
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(tier ? ex.label : ex.label === 'none' ? 'none' : 'bronze', tier?.color ?? (ex.label === 'none' ? policy?.fallbackTier.color ?? '#6b6b6b' : '#b06e3c')))}`;
	b.append(img, el('span', '', `${sentence(ex.title)}.`), el('span', 'sr', ex.label));
	b.addEventListener('click', () => {
		setText(codeView, ex.files.map(f => f.content).join('\n'));
		($('examples-menu') as HTMLDetailsElement).open = false;
		markExample();
	});
	$('examples').append(b);
}
markExample();
$('analyze-code').addEventListener('click', () => runEditor());
liveButton.addEventListener('click', () => {
	liveButton.setAttribute('aria-pressed', String(!live.checked));
	if(live.checked) {
		runEditor();
	}
});

/* ---------------------------------------------------------------- report */

const TierColor: Record<string, string> = { gold: 't-gold', silver: 't-silver', bronze: 't-bronze', none: 't-none' };

/** a link that downloads `content`, made only when it is clicked */
function download(name: string, type: string, content: () => string): HTMLAnchorElement {
	const a = el('a', 'button secondary small', name);
	a.href = '#';
	a.download = name;
	a.addEventListener('click', () => {
		const url = URL.createObjectURL(new Blob([content()], { type }));
		a.href = url;
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	});
	return a;
}

function importReviewButton(): HTMLElement {
	const label = el('label', 'button secondary small', 'import review');
	label.title = 'load a review.json and add its decisions';
	const input = el('input');
	input.type = 'file';
	input.accept = '.json,application/json';
	input.hidden = true;
	input.addEventListener('change', async() => {
		const file = input.files?.[0];
		if(file === undefined) {
			return;
		}
		try {
			for(const e of parseReview(await file.text())) {
				reviews.set(e.key, e);
			}
			saveReviews();
			if(last) {
				render(last.report, last.files);
				writeLink();
			}
		} catch(e) {
			showError(`That is not a review file: ${e instanceof Error ? e.message : String(e)}`);
		}
	});
	label.append(input);
	return label;
}

function copyButton(label: string, text: () => string, title: string): HTMLButtonElement {
	const b = el('button', 'button secondary small', label);
	b.type = 'button';
	b.title = title;
	b.addEventListener('click', () => {
		void navigator.clipboard.writeText(text()).then(() => {
			b.textContent = 'copied';
			setTimeout(() => b.textContent = label, 1200);
		}, () => {
			b.textContent = 'copy failed';
		});
	});
	return b;
}

const where = (f: { file?: string, loc?: readonly number[] }) => `${f.file ?? ''}${f.loc ? `:${f.loc[0]}` : ''}`;

/** flowR's messages mark code with backticks */
function ticks(text: string): (string | HTMLElement)[] {
	return text.split(/`([^`]+)`/).map((part, i) => i % 2 === 1 ? el('code', '', part) : part);
}

/** rdrr.io hosts the help pages of base R and of CRAN */
function docsOf(call: string): string | undefined {
	const [pkg, fn] = call.includes('::') ? call.split('::') : [undefined, call];
	if(pkg === undefined) {
		return undefined;
	}
	const baseR = ['base', 'stats', 'utils', 'methods', 'graphics', 'grDevices', 'datasets', 'tools', 'parallel', 'compiler', 'grid', 'splines', 'stats4', 'tcltk'];
	return baseR.includes(pkg) ? `https://rdrr.io/r/${pkg}/${fn}.html` : `https://rdrr.io/cran/${pkg}/man/${fn}.html`;
}

/** the most telling findings first: severe, outside values, the app's own calls */
function rank(f: Finding): number {
	return (f.class === 'severe' ? 0 : f.class === 'outward' ? 10 : 20) + (f.origins.includes('outside') ? 0 : 4) + (f.via === 'direct' ? 0 : 1);
}

/** a phrase as the start of a sentence, without the full stop */
function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, '');
}

/**
 * Why a tier fails, in terms of the code: the call that breaks the rule, what it does, and where, then the
 * rule it breaks. A failed linting rule has no call; it is named instead.
 */
function concreteReason(r: Report, v: { reason: string, findings: readonly string[] }, more: number): HTMLElement {
	const span = el('span');
	const fs = v.findings.map(id => r.findings.find(f => f.id === id)).filter((f): f is Finding => f !== undefined);
	const tail = more > 0 ? ` (and ${more} more reason${more > 1 ? 's' : ''})` : '';
	if(fs.length === 0) {
		span.append(`${sentence(v.reason)}.${tail}`);
		return span;
	}
	const f = fs[0];
	const at = el('a', 'jump', where(f));
	at.href = '#code-view';
	at.addEventListener('click', ev => {
		ev.preventDefault();
		ev.stopPropagation();
		selectFinding(f);
	});
	span.append(el('code', '', f.call), ` ${describe(f)}, at `, at, fs.length > 1 ? ` and ${fs.length - 1} more place${fs.length > 2 ? 's' : ''}` : '', '.',
		el('span', 'rule-broken', ` The tier forbids ${v.reason}.`), tail);
	return span;
}

/** `a, b, and c` */
function listing(xs: readonly string[]): string {
	return xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`;
}

/** what a finding does, as the rest of a sentence that starts with the call */
/** flowR's input types, in words */
const TypeWords: Record<string, string> = {
	user: 'user input', file: 'file contents', net: 'network data', glob: 'a file listing', cmdline: 'command-line arguments',
	param: 'a function parameter', unknown: 'a value flowR could not trace', system: 'a system setting', ffi: 'a value from native code',
	options: 'an R option', scope: 'a value of the environment', const: 'a constant', dconst: 'a default value', tempfile: 'a temporary file name',
	rand: 'a random number', lang: 'code of the script'
};
/* the words of the page: no one needs to know about taint analysis to read a report */
const ClassWords: Record<string, string> = { severe: 'dangerous', outward: 'files or network', other: 'output or database' };
/* what a class covers, read from the policy rather than written here */
const ClassLong: Record<string, string> = new Proxy({}, {
	get: (_, c: string) => `${cw(c)} calls, with the capabilities ${listing(Object.entries(policy?.capabilities ?? {}).filter(([, v]) => v.class === c).map(([k]) => k))}`
});
const OriginWords: Record<string, string> = { author: 'the code', system: 'the system', parameter: 'parameters', unknown: 'unknown', outside: 'users, files, net', none: 'no value' };
const OriginLong: Record<string, string> = {
	author: 'values written in the code itself, such as constants',
	system: 'values the deployment or the system sets, such as options or environment variables',
	parameter: 'parameters of the app\'s own functions, set by whoever calls them',
	unknown: 'values flowR could not trace back',
	outside: 'values from users, files, or the network',
	none: 'calls without any traced value'
};
/* flowR's file roles, in the words of the page */
const RoleWord: Record<FileRoleName, string> = { source: 'main', test: 'tests', vignette: 'vignettes', install: 'inst/', startup: 'startup' };
const RoleLong: Record<FileRoleName, string> = {
	source: 'the main sources, such as R/ of a package or the scripts of an app', test: 'tests, such as tests/testthat',
	vignette: 'vignettes', install: 'files installed verbatim, from inst/', startup: 'startup files such as .Rprofile'
};
const roleOfFinding = (f: Finding): FileRoleName => f.role ?? 'source';
const cw = (c: string) => ClassWords[c] ?? c;
const ow = (o: string) => OriginWords[o] ?? o;

/**
 * What a finding does, from what flowR states: the capability the policy matched (its name in the policy),
 * flowR's semantic tags of the function, and the value sources of the input-sources query. No prose of
 * badgR's own about what a function does.
 */
function describe(f: Finding): string {
	const tags = f.tags && f.tags.length > 0 ? ` (flowR: ${f.tags.join(', ')})` : '';
	const words = [...new Set(f.inputTypes.map(t => TypeWords[t] ?? t))];
	const values = words.length > 0 ? listing(words) : 'no traced value';
	return f.via === 'package'
		? `reaches ${f.capability} inside its package, through ${f.through}${tags}, with ${values}`
		: `has the capability ${f.capability}${tags}, with ${values}`;
}

/* the flowR documentation of what badgR asks flowR */
const Wiki = 'https://github.com/flowr-analysis/flowr/wiki/';
const Docs = {
	queryApi:      `${Wiki}Query-API`,
	dataflow:      `${Wiki}Dataflow-Graph`,
	lintOverview:  `${Wiki}Linter`,
	inputSources:  `${Wiki}%5BQuery%5D-Input-Sources`,
	functionInfo:  `${Wiki}%5BQuery%5D-Function-Info`,
	sigdb:         `${Wiki}Signature-Database`,
	linter:        `${Wiki}%5BQuery%5D-Linter`,
	callContracts: `${Wiki}%5BLinting-Rule%5D-Call-Contracts`
};
/** a tag that opens the flowR page behind it */
function tagLink(cls: string, text: string, href: string, title: string): HTMLAnchorElement {
	const a = link(href, text, title);
	a.className = `tag ${cls}`;
	return a;
}

/* ---------------------------------------------------------------- the reviewer's hand classification */

/*
 * A reviewer can mark a finding as tolerated, a false positive, or to fix, with a note. This never changes
 * the tier. The decisions stay in this browser, travel in shared links, and export as review.json, which
 * `badgr --review review.json` reads as well.
 */
const ReviewKey = 'badgr.review';
const reviews = new Map<string, ReviewEntry>((() => {
	try {
		return parseReview(localStorage.getItem(ReviewKey) ?? '[]').map(e => [e.key, e] as const);
	} catch{
		return [];
	}
})());
/* the browser keeps the newest 500 decisions of the last 90 days, so it does not fill up over the years */
const ReviewKeep = 500;
const ReviewDays = 90;
const reviewTimes = new Map<string, number>((() => {
	try {
		return Object.entries(JSON.parse(localStorage.getItem(`${ReviewKey}.at`) ?? '{}') as Record<string, number>);
	} catch{
		return [];
	}
})());
function saveReviews(touched?: string): void {
	const now = Date.now();
	if(touched !== undefined) {
		reviewTimes.set(touched, now);
	}
	for(const k of reviews.keys()) {
		if(!reviewTimes.has(k)) {
			reviewTimes.set(k, now);
		}
	}
	const keep = [...reviewTimes].filter(([k, t]) => reviews.has(k) && now - t < ReviewDays * 864e5).sort((a, b) => b[1] - a[1]).slice(0, ReviewKeep);
	const kept = new Set(keep.map(([k]) => k));
	for(const k of [...reviews.keys()]) {
		if(!kept.has(k) && k !== touched) {
			reviews.delete(k);
		}
	}
	reviewTimes.clear();
	keep.forEach(([k, t]) => reviewTimes.set(k, t));
	try {
		localStorage.setItem(`${ReviewKey}.at`, JSON.stringify(Object.fromEntries(reviewTimes)));
		localStorage.setItem(ReviewKey, JSON.stringify([...reviews.values()]));
	} catch{ /* private mode: the decisions last as long as the page */ }
}
function keyOfFinding(f: Finding): string {
	const file = last?.files.find(x => x.path === f.file) ?? last?.files.find(x => /\.(R|r|Rmd|rmd|qmd)$/.test(x.path));
	const line = f.loc ? file?.content.split('\n')[f.loc[0] - 1] : undefined;
	return findingKey(f, line);
}
function reviewOf(f: Finding): ReviewEntry | undefined {
	return reviews.get(keyOfFinding(f));
}
function setReview(f: Finding, state: ReviewState | undefined, note?: string): void {
	const key = keyOfFinding(f);
	if(state === undefined) {
		reviews.delete(key);
	} else {
		reviews.set(key, { key, state, ...(note ? { note } : {}) });
	}
	saveReviews(key);
	if(last) {
		const keep = scrollY;
		render(last.report, last.files);
		writeLink();
		scrollTo({ top: keep });
	}
}
/** the report with the decisions in it, for the downloads */
function reviewed(r: Report): Report {
	return { ...r, findings: r.findings.map(f => {
		const e = reviewOf(f);
		return e ? { ...f, review: { state: e.state, ...(e.note ? { note: e.note } : {}) } } : f;
	}) };
}
/** the compact control of a table row: one button per state, the active one pressed */
function reviewPicker(f: Finding, compact: boolean): HTMLElement {
	const box = el('span', 'rv');
	const now = reviewOf(f)?.state;
	for(const st of ReviewStates) {
		const b = el('button', `rv-b rv-${st}`, compact ? { 'tolerated': '✓', 'false-positive': 'FP', 'to-fix': 'fix' }[st] : ReviewLabel[st]);
		b.type = 'button';
		b.setAttribute('aria-pressed', String(now === st));
		b.title = now === st ? `${ReviewLabel[st]}. Click to undo.` : `mark as ${ReviewLabel[st]} (does not change the tier)`;
		b.addEventListener('click', ev => {
			ev.stopPropagation();
			setReview(f, now === st ? undefined : st, reviewOf(f)?.note);
		});
		box.append(b);
	}
	return box;
}
/** the popover's part: the state and a note */
function reviewBox(f: Finding): HTMLElement {
	const box = el('div', 'rv-box');
	box.append(el('span', 'hint', 'Your review: '), reviewPicker(f, false));
	const note = el('input');
	note.placeholder = 'a note, e.g. why it is tolerated';
	note.value = reviewOf(f)?.note ?? '';
	note.addEventListener('change', () => setReview(f, reviewOf(f)?.state ?? 'tolerated', note.value.trim()));
	box.append(note);
	return box;
}
/** how the findings table was grouped and unfolded, kept while the same report is redrawn */
const view: { target?: string, count?: number, groupBy: 'capability' | 'call' | 'file' | 'none', expanded: Set<string>, full: Set<string>, active: Set<string> } =
	{ groupBy: 'none', expanded: new Set(), full: new Set(), active: new Set() };

let selectFinding: (f: Finding, quiet?: boolean) => void = () => {};
let revealFinding: (f: Finding) => void = () => {};
let selectLint: (rule: string, r: LintResult, quiet?: boolean) => void = () => {};

/** the open state of the folds in `box` that have a `data-key`, to put back once `box` is drawn again */
function openState(box: HTMLElement): () => void {
	const was = new Map([...box.querySelectorAll<HTMLDetailsElement>('details[data-key]')].map(d => [d.dataset.key ?? '', d.open]));
	return () => box.querySelectorAll<HTMLDetailsElement>('details[data-key]').forEach(d => {
		const open = was.get(d.dataset.key ?? '');
		if(open !== undefined) {
			d.open = open;
		}
	});
}

/**
 * Draws a report. `incremental` is for a later report of the same run with the same findings (a partial
 * report with more linting rules done, or the final one): the findings table, the matrix, and the code
 * stay as they are, and what the reader opened stays open.
 */
function render(r: Report, files: readonly SourceFile[], incremental = false): void {
	$('result').hidden = false;
	const pending = r.pending ?? [];
	$('result').classList.toggle('partial', pending.length > 0);
	const restore = incremental ? [openState($('ladder')), openState($('downloads')), openState($('lint'))] : [];
	const marks = badgeMarks(r);
	const svg = badgeSvg(r.tier.tier, r.tier.color, marks);
	const img = el('img');
	img.alt = badgeTitle(r.tier.tier, marks);
	img.title = [badgeTitle(r.tier.tier, marks), marks.custom ? 'The * says the tier is that of a custom policy, not of badgR\'s default.' : '',
		marks.reviewed ? 'The check mark says every finding is reviewed and none is left to fix.' : ''].filter(Boolean).join('. ');
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	$('badge').replaceChildren(img);
	/* while linting rules run, the tier is the best the code can still get */
	const sofar = pending.length > 0 ? [el('em', 'provisional', 'so far')] : [];
	$('verdict-title').replaceChildren(
		...(r.tier.tier === 'none' ? [document.createTextNode('No tier '), el('span', 'sr', 'none')] : [el('span', `tier-word ${TierColor[r.tier.tier] ?? ''}`, r.tier.tier), document.createTextNode(' tier')]),
		...sofar, el('small', 'target', r.target));
	/* the one line that says what the assigned tier means */
	const spec = policy?.tiers.find(t => t.name === r.tier.tier);
	const req = el('p', `requirement ${TierColor[r.tier.tier] ?? 't-none'}`, spec?.summary ?? (r.tier.tier === policy?.fallbackTier.name ? 'No tier fits. Review each finding yourself.' : ''));
	$('verdict-req').replaceWith(req);
	req.id = 'verdict-req';
	const note = $('verdict-pending');
	note.hidden = pending.length === 0;
	note.textContent = pending.length === 0 ? '' : `${plural(pending.length, 'linting rule')} still running. ${r.tier.tier === policy?.fallbackTier.name ? 'Their results show up below as they come in.' : 'If one reports something, the tier can still drop.'}`;

	/* next to the badge: counts at a glance, then labeled rows, then the most telling findings */
	const summary = $('summary');
	summary.replaceChildren();
	const stat = (text: string, cls: string, title: string, go?: () => void) => {
		const chip = el(go ? 'button' : 'span', `stat ${cls}`, text);
		chip.title = title;
		if(go) {
			(chip as HTMLButtonElement).type = 'button';
			chip.addEventListener('click', go);
		}
		return chip;
	};
	const stats = el('div', 'stats');
	const filterBy = (key: string) => () => {
		const b = $('filters').querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
		b?.click();
		$('findings').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	};
	if(!r.analyzed) {
		stats.append(stat('not analyzed', 'bad', r.error ?? 'flowR could not analyze the code'));
	} else {
		stats.append(stat(plural(r.findings.length, 'risky call'), r.findings.length ? '' : 'ok', 'calls that can do something the policy watches, such as run commands or use the network'));
		for(const c of [...new Set(r.findings.map(f => f.class))]) {
			const n = r.findings.filter(f => f.class === c).length;
			stats.append(stat(`${n} ${cw(c)}`, `c-${c}`, `${sentence(ClassLong[c])}. Click to filter.`, filterBy(`class:${c}`)));
		}
		const outside = r.findings.filter(f => f.origins.includes('outside')).length;
		if(outside > 0) {
			stats.append(stat(`${outside} with values from outside`, 'c-outside', 'these calls get values from users, files, or the network. Click to filter.', filterBy('origin:outside')));
		}
		const hits = r.lint.filter(l => l.count > 0);
		const n = hits.reduce((s2, l) => s2 + l.count, 0);
		const fixes = hits.flatMap(l => l.results).filter(x => x.quickFix).length;
		if(n > 0) {
			stats.append(stat(`${plural(n, 'lint result')}${fixes ? `, ${fixes} fixable` : ''}`, 'c-lint', `${listing(hits.map(l => `${l.rule} (${l.count})`))}. Click to see them.`,
				() => $('lint').scrollIntoView({ block: 'start', behavior: 'smooth' })));
		}
		if(pending.length > 0) {
			stats.append(stat(`${pending.length} still running`, 'c-pending', `linting rules not done yet: ${listing(pending)}. Click to see them.`,
				() => $('lint').scrollIntoView({ block: 'start', behavior: 'smooth' })));
		}
	}
	if(r.findings.length > 0) {
		const c = reviewCounts(r.findings.map(f => reviewOf(f)?.state));
		const done = r.findings.length - c.unreviewed;
		stats.append(stat(done === 0 ? 'none reviewed' : `${done} of ${r.findings.length} reviewed`, c.unreviewed === 0 ? 'ok' : 'c-review',
			done === 0 ? 'mark findings as tolerated, false positive, or to fix, in the table or in the details of a finding. The tier stays the same.'
				: `${c.tolerated} tolerated, ${c['false-positive']} false positives, ${c['to-fix']} to fix. Click to show the rest.`,
			filterBy('review:unreviewed')));
	}
	summary.append(stats);

	const facts = el('dl', 'facts');
	const fact = (k: string, ...v: (string | Node)[]) => {
		const dd = el('dd');
		dd.append(...v);
		facts.append(el('dt', '', k), dd);
	};
	const mine = r.tier.checks.findIndex(c => c.tier === r.tier.tier);
	const above = r.tier.checks[(mine < 0 ? r.tier.checks.length : mine) - 1];
	if(above?.violations[0]) {
		const more = above.violations.length - 1;
		const why = concreteReason(r, above.violations[0], more);
		why.title = above.violations.map(v => sentence(v.reason)).join('. ') + '.';
		fact(`why not ${above.tier}`, why);
	}
	fact('left to review', r.tier.review === 'full' ? 'All findings.' : sentence(r.tier.review) + '.');
	if(r.unresolvedPackages.length > 0) {
		fact('not looked into', `${listing(r.unresolvedPackages)}: no signature data, so calls inside ${r.unresolvedPackages.length > 1 ? 'these packages' : 'this package'} are not checked.`);
	}
	summary.append(facts);

	if(r.findings.length > 0) {
		summary.append(el('p', 'top-label', 'most telling findings'));
		const top = el('ul', 'top');
		/* the three most telling kinds of finding, each once, with how many more are like it */
		const kinds = new Map<string, Finding[]>();
		for(const f of [...r.findings].sort((x, y) => rank(x) - rank(y))) {
			kinds.set(`${f.call}|${f.capability}|${f.via}`, [...kinds.get(`${f.call}|${f.capability}|${f.via}`) ?? [], f]);
		}
		for(const [f, alike] of [...kinds.values()].slice(0, 3).map(fs => [fs[0], fs.length - 1] as const)) {
			const item = el('li');
			const a = el('a', 'jump', where(f));
			a.href = '#code-view';
			a.title = 'show in the code';
			a.addEventListener('click', ev => {
				ev.preventDefault();
				selectFinding(f);
			});
			const call = el('code', '', f.call);
			call.title = `${describe(f)}. Input types: ${listing(f.inputTypes) || 'none'}.`;
			item.append(a, ' ', call, ' ', el('span', 'hint', `${f.capability}${f.tags?.length ? ` (flowR: ${f.tags.join(', ')})` : ''}${f.via === 'package' ? `, inside its package through ${f.through}` : ''}${alike > 0 ? `, and ${alike} more like it` : ''}`));
			top.append(item);
		}
		summary.append(top);
	}

	/* every result in sentences, for a closer look and for the shared link */
	const all = $('all-body');
	all.replaceChildren();
	const section = (title: string, items: HTMLElement[]) => {
		if(items.length === 0) {
			return;
		}
		const ol = el('ol');
		/* at most a hundred per section, the rest is in the tables below and in the downloads */
		ol.append(...items.slice(0, 100));
		if(items.length > 100) {
			ol.append(el('li', 'hint', `${items.length - 100} more in the table below and in report.json`));
		}
		all.append(el('h4', '', title), ol);
	};
	const jump = (text: string, go: () => void) => {
		const a = el('a', 'jump', text);
		a.href = '#code-view';
		a.addEventListener('click', ev => {
			ev.preventDefault();
			go();
		});
		return a;
	};
	section('Risky calls', [...r.findings].sort((a, b) => rank(a) - rank(b)).map(f => {
		const item = el('li');
		item.append(el('code', '', f.call), ` ${describe(f)}, at `, jump(where(f), () => selectFinding(f)), '.',
			...(f.inputTypes.length > 0 ? [el('span', 'hint', ` Input types: ${listing(f.inputTypes)}.`)] : []));
		return item;
	}));
	section('Why the stricter tiers fail', r.tier.checks.filter(c => !c.met).flatMap(c => c.violations.map(v => {
		const item = el('li');
		item.append(`${sentence(c.tier)} fails: ${v.reason}${v.findings.length ? ` (${plural(v.findings.length, 'finding')})` : ''}.`);
		return item;
	})));
	section('Linting results', r.lint.flatMap(l => l.results.map(x => {
		const item = el('li');
		item.append(link(l.docs ?? Docs.linter, l.title ?? l.rule, l.about), ' at ', jump(`${x.file?.split('/').pop() ?? ''}:${x.loc?.[0] ?? '?'}`, () => selectLint(l.rule, x)), ': ', ...ticks(x.message),
			x.quickFix ? `. Suggested fix: ${x.quickFix.map(q => q.replacement ?? 'remove it').join(' or ')}.` : '.');
		return item;
	})));
	$('all-results').hidden = all.childElementCount === 0;
	/* what badgR asked flowR, each linked to its documentation */
	const meta = $('verdict-meta');
	meta.replaceChildren(`${plural(r.files.length, 'R file')} · ${pending.length > 0 ? 'still running' : duration(r.ms)} · flowR ${r.flowrVersion} · uses flowR's `,
		link(Docs.dataflow, 'dataflow graph'), ', ', link(Docs.functionInfo, 'function-info'), ', ', link(Docs.inputSources, 'input-sources'), ', and ',
		link(Docs.linter, 'linter'), ' queries and its ', link(Docs.sigdb, `signature database ${r.sigdb.tag ?? ''}`.trim()), ` · ${r.policy.name}`);
	/* two actions in sight, the files in one menu */
	const fixes = allFixes(r);
	const menu = el('details', 'menu');
	const ms = el('summary', 'button secondary small', 'Download');
	const list = el('div', 'menu-list');
	/* the files are made on a click, not on every redraw */
	list.append(
		download('badge.svg', 'image/svg+xml', () => svg),
		download('report.json', 'application/json', () => JSON.stringify(reviewed(r), null, 2)),
		download('report.md', 'text/markdown', () => markdownReport(reviewed(r))),
		download('report.sarif', 'application/sarif+json', () => sarifText(r, files)),
		...(fixes.count > 0 ? [download('fixes.patch', 'text/x-diff', () => fixes.patch)] : []));
	menu.dataset.key = 'downloads';
	menu.append(ms, list);
	$('downloads').replaceChildren(shareMenu(r), menu, playgroundLink(r, files));
	/* the review goes in and out next to the findings it decides */
	const exportReview = download('review.json', 'application/json', () => JSON.stringify(reviewFile(r.findings.map(reviewOf).filter((e): e is ReviewEntry => e !== undefined)), null, 2));
	exportReview.textContent = 'export review';
	exportReview.title = 'your decisions as review.json, to keep or to load elsewhere';
	$('review-actions').replaceChildren(exportReview, importReviewButton());

	/* the tier ladder: one line per tier, the reasons fold out */
	$('ladder').replaceChildren(...r.tier.checks.map(c => {
		const spec = policy?.tiers.find(t => t.name === c.tier);
		/* a tier met so far, whose linting rules still run, can still fail */
		const waits = c.met ? (spec?.lint ?? []).filter(x => pending.includes(x)) : [];
		const item = el('li', `${waits.length > 0 ? 'pending' : c.met ? 'met' : 'failed'}${c.tier === r.tier.tier ? ' mine' : ''}`);
		/* only more than one reason folds: a single one is said in full on the line itself */
		const folds = c.violations.length > 1;
		const head = el(folds ? 'summary' : 'div', 'tier-line');
		const name = el('span', `tier-name ${TierColor[c.tier] ?? ''}`, c.tier);
		name.title = spec?.summary ?? spec?.description ?? '';
		const mark = el('span', 'mark', waits.length > 0 ? '…' : c.met ? '✓' : '✗');
		if(waits.length > 0) {
			mark.title = `met so far, waiting for ${listing(waits)}`;
		}
		head.append(mark, name);
		if(c.tier === r.tier.tier) {
			head.append(el('span', 'yours', pending.length > 0 ? 'so far' : 'assigned'));
		}
		/* first what the tier asks for, then why the code misses it */
		if(spec?.summary) {
			head.append(el('span', 'tier-req', spec.summary));
		}
		if(c.violations.length > 0) {
			const first = concreteReason(r, c.violations[0], c.violations.length - 1);
			first.prepend(el('strong', '', 'Fails because '));
			first.classList.add('why');
			head.append(first);
		}
		if(folds) {
			const d = el('details');
			d.dataset.key = c.tier;
			d.open = c === above;
			const ul = el('ul');
			ul.append(...c.violations.slice(1).map(v => {
				const li = el('li');
				li.append(sentence(v.reason));
				const fs = v.findings.map(id => r.findings.find(f => f.id === id)).filter((f): f is Finding => f !== undefined);
				for(const f of fs.slice(0, 4)) {
					const a = el('a', 'jump', where(f));
					a.href = '#code-view';
					a.title = `${f.call} ${describe(f)}`;
					a.addEventListener('click', ev => {
						ev.preventDefault();
						selectFinding(f);
					});
					li.append(' ', a);
				}
				if(fs.length > 4) {
					li.append(el('span', 'hint', ` and ${fs.length - 4} more`));
				}
				return li;
			}));
			d.append(head, ul);
			item.append(d);
		} else {
			item.append(head);
		}
		return item;
	}));

	restore.slice(0, 2).forEach(f => f());
	if(!incremental) {
		renderFindings(r);
	}
	/* the code shows the linting results too: drawn again only when there are new ones */
	const lintResults = r.lint.reduce((n, l) => n + l.results.length, 0);
	if(!incremental || drawn?.lintResults !== lintResults) {
		renderCode(r, files, incremental);
	}
	renderLint(r, incremental);
	restore.at(-1)?.();
	renderQueries(r, incremental);
	drawn = { files, target: r.target, findings: findingIds(r), lintResults };
}

/** the matrix and the findings table, which only change with the findings */
function renderFindings(r: Report): void {
	/* sink class × origin, every class and origin of the policy */
	const classes = policy ? [...new Set(Object.values(policy.capabilities).map(c => c.class))] : [];
	const allClasses = [...new Set([...classes, ...r.findings.map(f => f.class)])];
	const allOrigins = [...new Set([...policy ? Object.keys(policy.origins) : [], ...r.findings.flatMap(f => f.origins)])];
	const matrix = $('matrix');
	const max = Math.max(1, ...allClasses.flatMap(c => allOrigins.map(o => r.findings.filter(f => f.class === c && f.origins.includes(o)).length)));
	const head = el('tr');
	head.append(el('th'), ...allOrigins.map(o => {
		const th = el('th', 'n');
		th.append(link(Docs.inputSources, ow(o), `${sentence(OriginLong[o] ?? o)}, found with flowR's input-sources query`));
		return th;
	}));
	/* per class, a row of all its findings and, when the code has files of several roles, a row per role */
	const roles = FileRoles.filter(x => r.findings.some(f => roleOfFinding(f) === x));
	const cellRow = (c: string, label: HTMLElement, fs: readonly Finding[], cls = '') => {
		const tr = el('tr', cls);
		tr.append(label);
		for(const o of allOrigins) {
			const calls = fs.filter(f => f.class === c && f.origins.includes(o));
			const n = calls.length;
			const td = el('td', 'n');
			const span = el('span', n ? (o === 'outside' ? 'hot' : 'warm') : 'zero', n ? String(n) : '·');
			span.title = n ? `${listing([...new Set(calls.slice(0, 12).map(f => `${f.call} (${where(f)})`))])}${n > 12 ? ', …' : ''} ${n === 1 ? 'gets' : 'get'} ${OriginLong[o] ?? o}` : `no ${cw(c)} call gets ${OriginLong[o] ?? o}`;
			if(n) {
				span.style.opacity = String(0.55 + 0.45 * n / max);
				span.classList.add('clickable');
				span.addEventListener('click', () => selectFinding(calls[0]));
			}
			td.append(span);
			tr.append(td);
		}
		return tr;
	};
	const rows = allClasses.flatMap(c => {
		const th = el('th', '', cw(c));
		th.title = policy ? `capabilities of class ${c}: ${listing(Object.entries(policy.capabilities).filter(([, v]) => v.class === c).map(([k, v]) => `${k} (${v.description ?? ''})`))}` : '';
		const out = [cellRow(c, th, r.findings)];
		if(roles.length > 1) {
			for(const role of roles.filter(x => r.findings.some(f => f.class === c && roleOfFinding(f) === x))) {
				const shipped = policy?.shipped.includes(role) ?? true;
				const rth = el('th', 'm-role', RoleWord[role]);
				rth.title = `${RoleLong[role]}, from flowR's file roles; ${shipped ? 'shipped: the tiers count it' : 'not shipped: the tiers do not count it unless a rule names it'}`;
				out.push(cellRow(c, rth, r.findings.filter(f => roleOfFinding(f) === role), `role-row${shipped ? '' : ' unshipped'}`));
			}
		}
		return out;
	});
	matrix.replaceChildren(el('thead'), el('tbody'));
	matrix.firstElementChild?.append(head);
	matrix.lastElementChild?.append(...rows);

	/* findings with filters; the filters, groups, and folds stay while the same report is drawn again */
	if(view.target !== r.target || view.count !== r.findings.length) {
		Object.assign(view, { target: r.target, count: r.findings.length, groupBy: r.findings.length > 8 ? 'capability' : 'none', expanded: new Set(), full: new Set(), active: new Set() });
	}
	const active = view.active;
	const matches = (f: Finding) => [...active].every(a => {
		const [kind, value] = a.split(':');
		return kind === 'class' ? f.class === value : kind === 'via' ? f.via === value : kind === 'review' ? reviewOf(f) === undefined : kind === 'role' ? roleOfFinding(f) === value : f.origins.includes(value);
	});
	let shown = r.findings.filter(matches);
	const filters = $('filters');
	filters.replaceChildren();
	const origins = [...new Set(r.findings.flatMap(f => f.origins))];
	const roleKeys = FileRoles.filter(x => r.findings.some(f => roleOfFinding(f) === x)).map(x => `role:${x}`);
	const keys = [...roleKeys.length > 1 ? roleKeys : [], ...new Set(r.findings.map(f => `class:${f.class}`)), ...new Set(r.findings.map(f => `via:${f.via}`)), ...origins.map(o => `origin:${o}`), 'review:unreviewed'];
	for(const k of [...active].filter(k => !keys.includes(k))) {
		active.delete(k);
	}
	shown = r.findings.filter(matches);
	for(const k of keys) {
		const [kind, value] = k.split(':');
		const b = el('button', 'chip', kind === 'class' ? `${cw(value)} calls` : kind === 'via' ? (value === 'package' ? 'inside packages' : 'in the app') : kind === 'review' ? 'not reviewed yet' : kind === 'role' ? `in ${RoleWord[value as FileRoleName]}` : `values from ${ow(value)}`);
		b.type = 'button';
		b.dataset.key = k;
		b.setAttribute('aria-pressed', String(active.has(k)));
		b.addEventListener('click', () => {
			if(!active.delete(k)) {
				active.add(k);
			}
			b.setAttribute('aria-pressed', String(active.has(k)));
			shown = r.findings.filter(matches);
			drawFindings();
		});
		filters.append(b);
	}
	const table = $('findings');
	/*
	 * Many findings come in groups: by capability, by called function, or by file. A group is one line that
	 * says how many findings it holds and of which kind, and unfolds into its rows, ten at a time.
	 */
	let groupBy = view.groupBy;
	const { expanded, full } = view;
	const PerGroup = 10;
	const keyOf = (f: Finding) => groupBy === 'capability' ? f.capability : groupBy === 'call' ? f.call : groupBy === 'file' ? (f.file ?? '') : '';
	const grouping = el('span', 'grouping');
	const groupButtons = (['capability', 'call', 'file', 'none'] as const).map(g => {
		const b = el('button', 'chip', g === 'none' ? 'no groups' : `by ${g}`);
		b.type = 'button';
		b.addEventListener('click', () => {
			groupBy = view.groupBy = g;
			expanded.clear();
			full.clear();
			drawFindings();
		});
		return b;
	});
	grouping.append(el('span', 'hint', 'group '), ...groupButtons);
	filters.append(grouping);
	const row = (f: Finding) => {
		const tr = el('tr');
		tr.dataset.id = f.id;
		const call = el('td');
		call.append(el('code', '', f.call));
		const cap = el('td');
		cap.append(tagLink(f.class, cw(f.class), f.via === 'package' ? Docs.sigdb : Docs.functionInfo,
			`${sentence(ClassLong[f.class] ?? f.class)}. ${f.via === 'package' ? 'Found inside the package with flowR\'s signature database.' : 'From what flowR knows about the function.'}`),
			` ${f.capability}`, ...(f.tags ?? []).map(t => tagLink('ftag', t, Docs.functionInfo, `flowR's semantic tag ${t} of ${f.via === 'package' ? f.through : f.call}`)));
		const orig = el('td');
		orig.append(...f.origins.map(o => tagLink(o, ow(o), Docs.inputSources, `${sentence(OriginLong[o] ?? o)}: ${listing([...new Set(f.inputTypes.map(t => TypeWords[t] ?? t))]) || 'nothing traced'}, found with flowR's input-sources query`)));
		cap.title = `policy name: ${f.capability}`;
		const via = el('td', '', f.via === 'package' ? `inside the package (${f.through})` : 'in the app');
		via.title = f.via === 'package' ? `${f.call} itself is harmless, but inside its package it calls ${f.through} (from flowR's signature database)` : `the app calls ${f.call} itself`;
		call.title = `${f.call} ${describe(f)}`;
		const rv = el('td', 'rv-cell');
		rv.append(reviewPicker(f, true));
		const at = el('td', 'mono', where(f));
		if(roleOfFinding(f) !== 'source') {
			const tag = el('span', `tag role${policy?.shipped.includes(roleOfFinding(f)) === false ? ' unshipped' : ''}`, RoleWord[roleOfFinding(f)]);
			tag.title = RoleLong[roleOfFinding(f)];
			at.append(' ', tag);
		}
		tr.append(at, call, cap, via, orig, rv);
		tr.classList.toggle('reviewed', reviewOf(f) !== undefined);
		tr.addEventListener('click', ev => {
			if(!(ev.target as Element).closest('.rv-cell')) {
				selectFinding(f);
			}
		});
		return tr;
	};
	const drawFindings = () => {
		$('more-findings').hidden = true;
		$('finding-count').textContent = r.findings.length > 0 ? `${shown.length} of ${r.findings.length}` : '';
		grouping.hidden = r.findings.length < 3;
		groupButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['capability', 'call', 'file', 'none'][i] === groupBy)));
		/* nothing to filter, group, or review: the summary already says there are no risky calls */
		$('findings-block').hidden = r.findings.length === 0;
		if(r.findings.length === 0) {
			table.replaceChildren();
			return;
		}
		const h = el('tr');
		h.append(...['line', 'call', 'what it can do', 'where it happens', 'values from', 'review'].map(x => el('th', '', x)));
		const thead = el('thead');
		thead.append(h);
		const body = el('tbody');
		const groups = new Map<string, Finding[]>();
		for(const f of [...shown].sort((x, y) => rank(x) - rank(y))) {
			groups.set(keyOf(f), [...groups.get(keyOf(f)) ?? [], f]);
		}
		/* few findings in all: everything open; many: the most telling group open */
		const openAll = shown.length <= 30;
		let first = true;
		for(const [key, fs] of groups) {
			if(groupBy !== 'none') {
				const open = expanded.has(key) || openAll || (first && expanded.size === 0);
				const gh = el('tr', `group${open ? ' open' : ''}`);
				const td = el('td');
				td.colSpan = 6;
				const open_ = fs.filter(f => reviewOf(f) === undefined).length;
				const classes = [...new Set(fs.map(f => f.class))];
				const origins = [...new Set(fs.flatMap(f => f.origins))];
				const filesN = new Set(fs.map(f => f.file)).size;
				td.append(el('span', 'g-mark', open ? '▾' : '▸'), el('code', 'g-key', key || '(no file)'), el('span', 'g-count', plural(fs.length, 'finding')),
					...classes.map(c => el('span', `tag ${c}`, cw(c))), ...origins.map(o => el('span', `tag ${o}`, ow(o))),
					el('span', 'hint', filesN > 1 ? ` in ${filesN} files` : ''),
					el('span', `g-open${open_ === 0 ? ' done' : ''}`, open_ === 0 ? 'all reviewed' : `${open_} to review`));
				td.title = groupBy === 'capability' ? policy?.capabilities[key]?.description ?? '' : '';
				gh.append(td);
				gh.addEventListener('click', () => {
					if(open) {
						expanded.delete(key);
						if(first) {
							expanded.add('\u0000');
						}
					} else {
						expanded.add(key);
					}
					drawFindings();
				});
				body.append(gh);
				first = false;
				if(!open) {
					continue;
				}
			}
			const limit = groupBy === 'none' ? PerGroup * 2 : PerGroup;
			const rows = full.has(key) ? fs : fs.slice(0, limit);
			body.append(...rows.map(row));
			if(fs.length > rows.length) {
				const mr = el('tr', 'more-row');
				const td = el('td');
				td.colSpan = 6;
				const b = el('button', 'button secondary small', `show the other ${fs.length - rows.length}`);
				b.type = 'button';
				b.addEventListener('click', () => {
					full.add(key);
					drawFindings();
				});
				td.append(b);
				mr.append(td);
				body.append(mr);
			}
		}
		table.replaceChildren(thead, body);
	};
	/* a finding picked elsewhere opens its group and rows */
	revealFinding = f => {
		if(!table.querySelector(`tr[data-id="${CSS.escape(f.id)}"]`)) {
			expanded.add(keyOf(f));
			full.add(keyOf(f));
			drawFindings();
		}
	};
	drawFindings();
}

/* ---------------------------------------------------------------- the signature database, as the page knows it */

interface PackageData { v?: string, x: string[], c: Record<string, string[]> }
const BaseOrder = ['base', 'stats', 'utils', 'methods', 'graphics', 'grDevices', 'datasets', 'tools', 'parallel', 'compiler', 'grid', 'splines', 'stats4', 'tcltk'];
const packageData = new Map<string, Promise<PackageData | undefined>>();
function loadPackageData(name: string): Promise<PackageData | undefined> {
	let p = packageData.get(name);
	if(p === undefined) {
		p = fetch(`${base}pkgs/${encodeURIComponent(name)}.json`).then(r => r.ok ? r.json() as Promise<PackageData> : undefined).catch(() => undefined);
		packageData.set(name, p);
	}
	return p;
}

/** the packages the code attaches, the last one first as R searches them, then base R */
function attachedPackages(files: readonly SourceFile[]): string[] {
	const attached = files.flatMap(f => [...f.content.matchAll(/\b(?:library|require|requireNamespace)\(\s*["']?([\w.]+)/g)].map(m => m[1]));
	return [...new Set([...attached.reverse(), ...BaseOrder])];
}

/** the entry of a function: its package and version, and what it reaches inside the package */
function sigdbSection(fn: string, candidates: readonly string[]): HTMLElement {
	const box = el('div', 'sigdb');
	box.append(el('p', 'hint', 'Looking it up in the signature database…'));
	void (async() => {
		for(const pkg of candidates) {
			const data = await loadPackageData(pkg);
			if(data?.x.includes(fn)) {
				const head = el('p');
				head.append(el('code', '', `${pkg}::${fn}`), ` is exported by ${pkg}${data.v ? ` ${data.v}` : ''}.`);
				const reach = data.c[fn] ?? [];
				const body = el('p');
				body.append(reach.length > 0
					? `Inside its package it reaches ${listing(reach.map(x => `${x}`))}, which badgR checks for capabilities.`
					: 'Inside its package it reaches no function that could have a capability of the policy.');
				const links = el('p', 'pop-links');
				const docs = docsOf(`${pkg}::${fn}`);
				links.append(link(Docs.sigdb, `signature database ${sigdbTag ?? ''}`.trim(), 'flowR\'s data of every CRAN package: exports, signatures, and call graphs'));
				if(docs) {
					links.append(link(docs, 'help page', `the R documentation of ${pkg}::${fn}`));
				}
				box.replaceChildren(head, body, links);
				return;
			}
		}
		box.replaceChildren(el('p', 'hint', candidates.length > 0
			? `None of ${listing(candidates.slice(0, 4))}${candidates.length > 4 ? ', …' : ''} exports ${fn} in the data of this page. This page has the latest CRAN version of each package. The command line has every version.`
			: `The data of this page has no entry for ${fn}.`));
	})();
	return box;
}

/* ---------------------------------------------------------------- the code, with findings and linting results to click */

interface Mark { from: number, to: number, cls: string, tip: string, open: (at: HTMLElement) => void }

/** the file the code view shows, kept when the same report is drawn again */
let codeFile: string | undefined;

function renderCode(r: Report, files: readonly SourceFile[], incremental = false): void {
	const rFiles = files.filter(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path));
	const fileOf = (f?: string) => f ?? rFiles[0]?.path ?? '';
	const count = new Map<string, number>();
	for(const f of r.findings) {
		count.set(fileOf(f.file), (count.get(fileOf(f.file)) ?? 0) + 1);
	}
	const ordered = [...rFiles].sort((a, b) => (count.get(b.path) ?? 0) - (count.get(a.path) ?? 0));
	const tabs = $('file-tabs');
	const view = $('code-view');
	const pop = $('popover');
	let current = '';

	const popover = (at: HTMLElement, fill: (box: HTMLElement) => void) => {
		pop.replaceChildren();
		fill(pop);
		const close = el('button', 'close', '×');
		close.type = 'button';
		close.addEventListener('click', () => {
			pop.hidden = true;
			selected = undefined;
			writeLink();
		});
		pop.prepend(close);
		pop.hidden = false;
		const box = view.getBoundingClientRect();
		const t = at.getBoundingClientRect();
		const parent = (pop.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? box;
		pop.style.top = `${t.bottom - parent.top + 6}px`;
		/* to the right of the code, where lines are short, so the lines below stay clickable */
		/* right of the code, where lines are short, and always inside its section */
		const width = Math.min(340, parent.width - 8);
		pop.style.left = `${Math.max(0, parent.width - width - 4)}px`;
	};

	const findingBox = (f: Finding) => (box: HTMLElement) => {
		const h = el('div', 'pop-head');
		h.append(tagLink(f.class, cw(f.class), Docs.functionInfo, sentence(ClassLong[f.class] ?? f.class)), ' ', el('code', '', f.call));
		box.append(h, el('p', '', `${f.call} ${describe(f)}.`));
		const dl = el('dl');
		const row = (k: string, v: string | Node) => {
			const dd = el('dd');
			dd.append(v);
			dl.append(el('dt', '', k), dd);
		};
		row('via', f.via === 'package' ? link(Docs.sigdb, `inside the package, through ${f.through}`, 'from the call graph of flowR\'s signature database') : 'the app calls it directly');
		row('origins', f.origins.length > 0 ? link(Docs.inputSources, listing(f.origins), 'traced with flowR\'s input-sources query') : 'none traced');
		row('input types', f.inputTypes.join(', ') || 'none');
		if(f.contract && (f.contract.injectable.length + f.contract.resource.length + f.contract.written.length) > 0) {
			row('contracts', link(Docs.callContracts, [['injectable', f.contract.injectable], ['a resource', f.contract.resource], ['written', f.contract.written]]
				.filter(([, v]) => v.length > 0).map(([k, v]) => `${listing(v as string[])} ${(v as string[]).length > 1 ? 'are' : 'is'} ${k as string}`).join(', and ') + '.',
			'what flowR\'s contracts state of the parameters'));
		}
		box.append(dl);
		box.append(reviewBox(f));
		const [pkg, fn] = f.call.includes('::') ? f.call.split('::') : [undefined, f.call];
		box.append(sigdbSection(fn, pkg ? [pkg] : []));
	};

	/* a call in the code: what flowR's signature database knows of the function */
	const callBox = (fn: string, explicit: string | undefined) => (box: HTMLElement) => {
		const own = rFiles.some(f => new RegExp(`(^|\\n)\\s*\`?${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\s*(<-|=)\\s*function`).test(f.content));
		const h = el('div', 'pop-head');
		h.append(el('code', 'fn-name', explicit ? `${explicit}::${fn}` : fn));
		box.append(h);
		if(own && !explicit) {
			box.append(el('p', '', 'Defined in the analyzed code. flowR analyzes its body like the rest of the code.'));
			return;
		}
		box.append(sigdbSection(fn, explicit ? [explicit] : attachedPackages(rFiles)));
	};

	const lintBox = (rule: string, x: LintResult) => (box: HTMLElement) => {
		const l = r.lint.find(s => s.rule === rule);
		const h = el('div', 'pop-head');
		h.append(tagLink('lint', 'lint', Docs.linter, 'flowR\'s linter query'), ' ', link(l?.docs ?? 'https://github.com/flowr-analysis/flowr/wiki/Linter', l?.title ?? rule, l?.about));
		const msg = el('p');
		msg.append(...ticks(x.message));
		box.append(h, msg);
		for(const q of x.quickFix ?? []) {
			box.append(quickFixRow(q, x.file));
		}
	};

	const marksOf = (path: string): Map<number, Mark[]> => {
		const marks = new Map<number, Mark[]>();
		const lines = (rFiles.find(f => f.path === path)?.content ?? '').split('\n');
		const add = (loc: readonly number[] | undefined, cls: string, tip: string, open: (at: HTMLElement) => void) => {
			if(!loc) {
				return;
			}
			const [l1, c1, l2, c2] = loc;
			for(let l = l1; l <= l2; l++) {
				const from = l === l1 ? c1 - 1 : 0;
				const to = l === l2 ? c2 : (lines[l - 1]?.length ?? 0);
				marks.set(l, [...marks.get(l) ?? [], { from, to, cls, tip, open }]);
			}
		};
		for(const f of r.findings.filter(x => fileOf(x.file) === path)) {
			add(f.loc, `m-sink m-${f.class}${f.origins.includes('outside') ? ' m-outside' : ''}`, `${f.call} ${describe(f)}${f.review ? ` (reviewed: ${ReviewLabel[f.review.state]})` : ''}`, at => {
				selected = findingAt(f, fileOf(f.file));
				writeLink();
				highlightRow(f);
				popover(at, findingBox(f));
			});
		}
		for(const l of r.lint) {
			for(const x of l.results.filter(y => fileOf(y.file) === path)) {
				add(x.loc, `m-lint${x.quickFix ? ' m-fix' : ''}`, `${l.title ?? l.rule}: ${x.message.replace(/`/g, '')}${x.quickFix ? ', with a quick fix' : ''}`, at => {
					selected = lintAt(l.rule, x, fileOf(x.file));
					writeLink();
					popover(at, lintBox(l.rule, x));
				});
			}
		}
		return marks;
	};

	const showFile = (path: string, line?: number, keep = false) => {
		current = codeFile = path;
		if(!keep) {
			pop.hidden = true;
		}
		for(const t of tabs.children) {
			t.setAttribute('aria-pressed', String((t as HTMLElement).dataset.path === path));
		}
		const content = rFiles.find(f => f.path === path)?.content ?? '';
		const tokens = highlightLines(content);
		const srcLines = content.split('\n');
		const marks = marksOf(path);
		const big = tokens.length > 3000;
		const near = (i: number) => !big || [...marks.keys()].some(m => Math.abs(m - i) <= 5);
		view.replaceChildren(...tokens.flatMap((toks, i) => {
			const no = i + 1;
			if(!near(no)) {
				return [];
			}
			const ms = marks.get(no) ?? [];
			const row = el('div', `ln${ms.some(m => m.cls.startsWith('m-sink')) ? ' hit' : ''}`);
			row.dataset.line = String(no);
			row.append(el('span', 'no', String(no)));
			const text = el('span', 'src');
			/* cut the tokens at the bounds of the marks, and wrap the marked pieces */
			const cuts = [...new Set([0, ...ms.flatMap(m => [m.from, m.to]), ...toks.reduce<number[]>((acc, t) => [...acc, (acc.at(-1) ?? 0) + t.text.length], [])])].sort((a, b) => a - b);
			let pos = 0;
			const pieces: { text: string, cls: string, at: number }[] = [];
			for(const t of toks) {
				let start = pos;
				for(const c of cuts.filter(c => c > pos && c < pos + t.text.length)) {
					pieces.push({ text: t.text.slice(start - pos, c - pos), cls: t.cls, at: start });
					start = c;
				}
				pieces.push({ text: t.text.slice(start - pos), cls: t.cls, at: start });
				pos += t.text.length;
			}
			for(const p of pieces) {
				const span = el('span', p.cls, p.text);
				const over = ms.filter(m => p.at >= m.from && p.at < m.to);
				if(over.length > 0) {
					const m = el('span', over.map(o => o.cls).join(' '));
					m.append(span);
					m.tabIndex = 0;
					m.title = `${over.map(o => o.tip).join('. ')}. Click for details.`;
					m.addEventListener('click', ev => {
						ev.stopPropagation();
						over[0].open(m);
					});
					m.addEventListener('keydown', ev => ev.key === 'Enter' && over[0].open(m));
					text.append(m);
				} else if(/\btok-call\b/.test(p.cls)) {
					/* every call opens what the signature database knows of it */
					const before = srcLines[i]?.slice(0, p.at) ?? '';
					const explicit = /([\w.]+):::?$/.exec(before)?.[1];
					span.classList.add('fn-link');
					span.title = `${explicit ? `${explicit}::` : ''}${p.text}: click for what flowR's signature database knows of it`;
					span.tabIndex = 0;
					const open = () => popover(span, callBox(p.text, explicit));
					span.addEventListener('click', open);
					span.addEventListener('keydown', ev => ev.key === 'Enter' && open());
					text.append(span);
				} else {
					text.append(span);
				}
			}
			if(toks.length === 0) {
				text.append(' ');
			}
			row.append(text);
			return [row];
		}));
		if(line !== undefined) {
			const target = view.querySelector<HTMLElement>(`[data-line="${line}"]`);
			view.querySelectorAll('.sel').forEach(s => s.classList.remove('sel'));
			target?.classList.add('sel');
			target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	};

	const highlightRow = (f: Finding) => {
		const table = $('findings');
		table.querySelectorAll('tr.sel').forEach(t => t.classList.remove('sel'));
		table.querySelector(`tr[data-id="${CSS.escape(f.id)}"]`)?.classList.add('sel');
	};

	tabs.replaceChildren(...ordered.slice(0, 60).map(f => {
		const b = el('button', 'chip', `${f.path}${count.get(f.path) ? ` (${count.get(f.path)})` : ''}`);
		b.type = 'button';
		b.dataset.path = f.path;
		b.addEventListener('click', () => showFile(f.path));
		return b;
	}));
	tabs.hidden = rFiles.length < 2;

	/* `quiet` marks the place without opening the details, as when a link brings a selection back */
	const openAt = (path: string, loc: readonly number[] | undefined, fill: (box: HTMLElement) => void, quiet = false) => {
		if(path !== current || loc) {
			showFile(path, loc?.[0]);
		}
		if(quiet) {
			return;
		}
		view.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		const target = loc ? view.querySelector<HTMLElement>(`[data-line="${loc[0]}"] .src > span[class^="m-"]`) ?? view.querySelector<HTMLElement>(`[data-line="${loc[0]}"]`) : null;
		if(target) {
			popover(target, fill);
		}
	};
	selectFinding = (f, quiet = false) => {
		revealFinding(f);
		selected = findingAt(f, fileOf(f.file));
		writeLink();
		highlightRow(f);
		openAt(fileOf(f.file), f.loc, findingBox(f), quiet);
	};
	selectLint = (rule, x, quiet = false) => {
		selected = lintAt(rule, x, fileOf(x.file));
		writeLink();
		openAt(rFiles.length === 1 ? rFiles[0].path : fileOf(x.file), x.loc, lintBox(rule, x), quiet);
	};
	/* drawn again for new linting results: the same file, scrolled as it was, and the details stay open */
	const again = incremental ? rFiles.find(f => f.path === codeFile) : undefined;
	if(again) {
		const top = view.scrollTop;
		showFile(again.path, undefined, true);
		view.scrollTop = top;
	} else if(ordered[0]) {
		showFile(ordered[0].path);
	}
}

/** a flowR quick fix: what it changes, and for code from the editor, a button that applies it */
/** the file a fix or result belongs to, among the analyzed files */
function sourceOf(file?: string): SourceFile | undefined {
	const rFiles = (last?.files ?? []).filter(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path));
	return rFiles.find(f => f.path === file) ?? (rFiles.length === 1 ? rFiles[0] : undefined);
}

/** a diff, colored per line */
function diffView(diff: string, withHeader: boolean): HTMLElement {
	const pre = el('pre', 'diff');
	for(const line of diff.replace(/\n$/, '').split('\n')) {
		if(!withHeader && /^(---|\+\+\+) /.test(line)) {
			continue;
		}
		const cls = line.startsWith('@@') ? 'd-hunk' : line.startsWith('+++') || line.startsWith('---') ? 'd-file' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : 'd-ctx';
		pre.append(el('span', cls, line + '\n'));
	}
	return pre;
}

/** puts new code into the editor and analyzes it again */
function replaceEditorCode(text: string): void {
	setText(codeView, text);
	document.querySelector<HTMLButtonElement>('[data-tab="paste"]')?.click();
	runEditor();
}

/** a flowR quick fix: what it does, the lines before and after, and for code from the editor, a button that applies it */
function quickFixRow(q: QuickFix, file?: string): HTMLElement {
	const row = el('div', 'fix');
	const head = el('div', 'fix-head');
	head.append(el('span', 'fix-label', 'quick fix'), ' ', ...ticks(q.description));
	row.append(head);
	const src = sourceOf(q.file ?? file);
	if(src) {
		const diff = unifiedDiff(src.path, src.content, [q], 0);
		if(diff) {
			row.append(diffView(diff, false));
		}
		if(last?.fromEditor && last.files.length === 1) {
			const b = el('button', 'button small', 'apply');
			b.type = 'button';
			b.title = 'apply this fix to the code in the editor and analyze again';
			b.addEventListener('click', () => replaceEditorCode(applyFixes(codeView.state.doc.toString(), [q])));
			head.append(' ', b);
		}
	}
	return row;
}

/** every quick fix of the report, as one patch over all files */
function allFixes(r: Report): { patch: string, count: number, files: number } {
	const byFile = new Map<string, QuickFix[]>();
	for(const l of r.lint) {
		for(const x of l.results) {
			for(const q of x.quickFix ?? []) {
				const src = sourceOf(q.file ?? x.file);
				if(src) {
					byFile.set(src.path, [...byFile.get(src.path) ?? [], q]);
				}
			}
		}
	}
	let patch = '';
	let count = 0;
	for(const [path, fixes] of byFile) {
		const src = sourceOf(path) as SourceFile;
		patch += unifiedDiff(path, src.content, fixes);
		count += applicableFixes(src.content, fixes);
	}
	return { patch, count, files: byFile.size };
}

/** the flowR page of each step badgR runs */
const QueryDocs: Record<string, string> = {
	'dataflow':           Docs.dataflow,
	'input-sources':      Docs.inputSources,
	'linter':             Docs.linter,
	'function-info':      Docs.functionInfo,
	'signature-database': Docs.sigdb
};
/** the steps that are flowR queries, which flowR's REPL runs with `:query` */
const isQuery = (q: FlowrQueryRecord) => q.type !== 'dataflow' && q.type !== 'signature-database';
const ListWords: Record<string, [string, string]> = { criterion: ['criterion', 'criteria'], rules: ['rule', 'rules'], functions: ['function', 'functions'] };
const items = (key: string, n: number) => {
	const [one, many] = ListWords[key] ?? ['item', 'items'];
	return `${n} ${n === 1 ? one : many}`;
};
/** the first list in a request, such as the criteria of input-sources or the rules of the linter */
function listOf(req: unknown): [string, readonly unknown[]] | undefined {
	return req !== null && typeof req === 'object' ? Object.entries(req).find((e): e is [string, unknown[]] => Array.isArray(e[1])) : undefined;
}

/** a request as compact JSON; a long list shows as its length and unfolds on a click */
function requestView(req: unknown): HTMLElement {
	let long = false;
	const short = JSON.stringify(req, (k, v: unknown) => {
		if(Array.isArray(v) && v.length > 4) {
			long = true;
			return `«${items(k, v.length)}»`;
		}
		return v;
	}).replace(/"«([^»]*)»"/g, '[$1]');
	if(!long) {
		return el('code', 'q-json', short);
	}
	const d = el('details', 'q-req');
	d.append(el('summary', '', ''));
	d.firstElementChild?.append(el('code', 'q-json', short));
	/* the full list only when asked for: it can hold thousands of criteria */
	d.addEventListener('toggle', () => {
		if(d.open && d.childElementCount === 1) {
			d.append(el('code', 'q-json q-full', JSON.stringify(req)));
		}
	});
	return d;
}

/** the groups of steps the reader opened or folded, kept while the same report is drawn again */
const queryFolds = new Map<string, boolean>();

function renderQueries(r: Report, incremental = false): void {
	if(!incremental) {
		queryFolds.clear();
	}
	const qs = r.queries ?? [];
	const total = qs.reduce((t, q) => t + q.ms, 0);
	$('query-count').textContent = qs.length > 0 ? `${plural(qs.length, 'step')}, ${duration(total)}` : '';
	const box = $('queries');
	if(qs.length === 0) {
		box.replaceChildren(el('p', 'hint', 'This report has no record of its flowR steps.'));
		return;
	}
	const intro = el('p', 'hint q-intro');
	const replAll = JSON.stringify(qs.filter(isQuery).map(q => q.request));
	intro.append('The flowR steps behind this report. To run a query yourself, use ', el('code', '', ':query <json>'),
		' in flowR\'s REPL. The ', link(Docs.queryApi, 'Query API'), ' explains each query.',
		copyButton('copy all queries', () => replAll, 'all queries as one JSON array, for :query in flowR\'s REPL'));
	const table = el('table', 'queries');
	const head = el('tr');
	head.append(...['step', 'request', 'time', 'result', ''].map(h => el('th', '', h)));
	const thead = el('thead');
	thead.append(head);
	table.append(thead);
	const docsOfRule = (rule: unknown) => r.lint.find(l => l.rule === rule)?.docs ?? vocabulary?.lintRules.find(v => v.name === rule)?.docs;
	const row = (q: FlowrQueryRecord, member: boolean) => {
		const tr = el('tr', member ? 'q-member' : '');
		const type = el('td', 'q-type');
		type.append(link(QueryDocs[q.type] ?? Docs.queryApi, q.type, `flowR's documentation of ${q.type}`));
		/* a linting rule links its own page */
		const rules = q.type === 'linter' ? listOf(q.request)?.[1] ?? [] : [];
		if(rules.length === 1 && docsOfRule(rules[0])) {
			type.append(' ', link(docsOfRule(rules[0]) as string, '↗', `the rule ${String(rules[0])}`));
		}
		const req = el('td', 'q-request');
		req.append(requestView(q.request));
		const copy = el('td', 'q-copy');
		if(isQuery(q)) {
			copy.append(copyButton('copy', () => `:query ${JSON.stringify([q.request])}`, 'this query as a command for flowR\'s REPL'));
		}
		tr.append(type, req, el('td', 'mono q-ms', duration(q.ms)), el('td', 'q-result', q.result), copy);
		return tr;
	};
	/* steps of one type in one group: the input-sources query runs in batches, the linter once per rule */
	const groups = new Map<string, FlowrQueryRecord[]>();
	for(const q of qs) {
		groups.set(q.type, [...groups.get(q.type) ?? [], q]);
	}
	for(const [type, group] of groups) {
		const tbody = el('tbody', group.length > 1 ? 'q-group' : '');
		tbody.dataset.type = type;
		if(group.length === 1) {
			tbody.append(row(group[0], false));
			table.append(tbody);
			continue;
		}
		const lists = group.map(q => listOf(q.request));
		const key = lists.find(l => l !== undefined)?.[0];
		const count = lists.reduce((n, l) => n + (l?.[1].length ?? 0), 0);
		const what = type === 'linter' ? `${plural(group.length, 'rule')}, one query each`
			: key ? `${items(key, count)} in ${group.length} batches` : plural(group.length, 'request');
		const gh = el('tr', 'q-head');
		const t = el('td', 'q-type');
		const toggle = el('button', 'q-toggle', '');
		toggle.type = 'button';
		t.append(toggle, link(QueryDocs[type] ?? Docs.queryApi, type, `flowR's documentation of ${type}`), el('span', 'hint', ` ×${group.length}`));
		const copy = el('td', 'q-copy');
		if(isQuery(group[0])) {
			copy.append(copyButton('copy', () => `:query ${JSON.stringify(group.map(q => q.request))}`, `the ${group.length} ${type} queries as one command for flowR's REPL`));
		}
		gh.append(t, el('td', 'q-request hint', what), el('td', 'mono q-ms', duration(group.reduce((n, q) => n + q.ms, 0))), el('td', 'q-result hint', ''), copy);
		const members = group.map(q => row(q, true));
		/* a few steps show at once, many fold */
		const set = (o: boolean) => {
			tbody.classList.toggle('open', o);
			toggle.textContent = o ? '▾' : '▸';
			toggle.setAttribute('aria-expanded', String(o));
			toggle.title = o ? 'fold' : `show the ${group.length} steps`;
			members.forEach(m => m.hidden = !o);
		};
		set(queryFolds.get(type) ?? group.length <= 3);
		gh.addEventListener('click', ev => {
			if(!(ev.target as Element).closest('a, .q-copy')) {
				set(!tbody.classList.contains('open'));
				queryFolds.set(type, tbody.classList.contains('open'));
			}
		});
		tbody.append(gh, ...members);
		table.append(tbody);
	}
	const wrap = el('div', 'table-wrap');
	wrap.append(table);
	box.replaceChildren(intro, wrap);
}

function renderLint(r: Report, incremental = false): void {
	const pending = r.pending ?? [];
	const clean = r.lint.filter(l => !l.error && l.count === 0);
	const hits = r.lint.length - clean.length;
	$('lint-count').textContent = pending.length > 0
		? `${r.lint.length} of ${r.lint.length + pending.length} done, ${hits} report something`
		: `${hits} of ${r.lint.length} report something`;
	const fixes = allFixes(r);
	const bar = el('div', 'fixes-bar');
	if(fixes.count > 0) {
		bar.append(el('span', '', `flowR suggests ${plural(fixes.count, 'fix')}${fixes.files > 1 ? ` in ${fixes.files} files` : ''}. `));
		if(last?.fromEditor && last.files.length === 1) {
			const apply = el('button', 'button small', 'apply all');
			apply.type = 'button';
			apply.title = 'apply all fixes to the code in the editor and analyze it again';
			apply.addEventListener('click', () => {
				const src = last?.files[0];
				if(src) {
					replaceEditorCode(applyFixes(src.content, r.lint.flatMap(l => l.results.flatMap(x => x.quickFix ?? []))));
				}
			});
			bar.append(apply);
		}
		bar.append(copyButton('copy patch', () => fixes.patch, 'the fixes as a unified diff, for git apply or patch -p1'),
			download('fixes.patch', 'text/x-diff', () => fixes.patch));
		const d = el('details', 'patch-view');
		d.dataset.key = '\u0000patch';
		d.append(el('summary', '', 'show the patch'), diffView(fixes.patch, true));
		bar.append(d);
	}
	/* nothing to see: the section starts folded; a redraw of the same report leaves it as the reader set it */
	if(!incremental) {
		($('lint').closest('details') as HTMLDetailsElement).open = clean.length < r.lint.length || pending.length > 0;
	}
	const cleanRow = el('div', 'lint clean');
	const allClean = clean.length === r.lint.length && pending.length === 0;
	cleanRow.append(el('span', 'mark', '✓'), el('span', 'hint', `${allClean ? `All ${plural(clean.length, 'rule')}` : plural(clean.length, 'rule')} found nothing: `));
	clean.forEach((l, i) => {
		const a = link(l.docs ?? Docs.lintOverview, l.rule, l.about ?? l.title);
		a.className = 'rule';
		cleanRow.append(...(i > 0 ? [' '] : []), a);
	});
	/* which query runs, and which tiers need which rule */
	const intro = el('p', 'lint-intro hint');
	const needs = (policy?.tiers ?? []).filter(t => t.lint.length > 0).map(t => `${t.name} needs ${listing(t.lint)}`);
	intro.append('badgR runs these rules with flowR\'s ', link(Docs.linter, 'linter query'), '.',
		needs.length > 0 ? ` ${sentence(listing(needs))} to report nothing. The other rules are advice and do not change the tier.` : ' They are advice and do not change the tier.');
	/* the rules not done yet, each with what it checks; they run one after the other, in this order */
	const waiting = pending.map((rule, i) => {
		const v = vocabulary?.lintRules.find(x => x.name === rule);
		const row = el('div', 'lint pending');
		const name = link(v?.docs ?? Docs.lintOverview, rule, v?.about ?? v?.title);
		name.className = 'rule';
		row.append(el('span', i === 0 ? 'mark spin' : 'mark', i === 0 ? '' : '·'), name, el('span', 'hint', i === 0 ? 'running' : 'waiting'));
		return row;
	});
	$('lint').replaceChildren(intro, ...(fixes.count > 0 ? [bar] : []), ...r.lint.filter(l => !clean.includes(l)).map(l => {
		const state = l.error ? 'failed' : l.count > 0 ? 'hits' : 'clean';
		const name = link(l.docs ?? Docs.lintOverview, l.rule, l.about ?? l.title);
		name.className = 'rule';
		const stopped = l.error === undefined ? undefined : /^stopped after (\S+) ?s\b/.exec(l.error)?.[1];
		const text = stopped !== undefined ? `stopped: took longer than ${stopped} s (lintTimeout in the policy)`
			: l.error ? `failed: ${l.error}` : l.count > 0 ? plural(l.count, 'result') : 'no results';
		if(stopped !== undefined) {
			const row = el('div', 'lint stopped');
			row.dataset.key = l.rule;
			row.title = l.error ?? '';
			row.append(el('span', 'mark', '⏱'), name, el('span', 'lint-count', text));
			return row;
		}
		if(state === 'clean') {
			const row = el('div', 'lint clean');
			row.append(el('span', 'mark', '✓'), name, el('span', 'hint', text));
			return row;
		}
		const d = el('details', `lint ${state}`);
		d.dataset.key = l.rule;
		d.open = state === 'hits' && l.count <= 5;
		const s = el('summary');
		s.append(el('span', 'mark', '✗'), name, el('span', 'lint-count', text));
		d.append(s);
		const ul = el('ul');
		for(const x of l.results.slice(0, 200)) {
			const item = el('li');
			const at = el('a', 'jump mono', x.loc ? `${x.file?.split('/').pop() ?? ''}:${x.loc[0]}` : '?');
			at.href = '#code-view';
			at.addEventListener('click', ev => {
				ev.preventDefault();
				selectLint(l.rule, x);
			});
			item.append(at, ' ', ...ticks(x.message));
			for(const q of x.quickFix ?? []) {
				item.append(quickFixRow(q, x.file));
			}
			ul.append(item);
		}
		if(l.results.length > 200) {
			ul.append(el('li', 'hint', `${l.results.length - 200} more in report.json`));
		}
		d.append(ul);
		return d;
	}), ...(clean.length > 0 ? [cleanRow] : []), ...waiting);
}

/* ---------------------------------------------------------------- the badges of the policy */

function drawTierTable(): void {
	if(policy === undefined) {
		return;
	}
	const p = policy;
	const all = [...p.tiers.map(t => ({ ...t, fallback: false })),
		{ name: p.fallbackTier.name, color: p.fallbackTier.color, review: p.fallbackTier.review, summary: 'Fits no tier above, or flowR could not analyze the code.', description: undefined, forbid: [], lint: [] as readonly string[], fallback: true }];
	/* one line per tier, the details unfold on demand */
	$('tier-table').replaceChildren(...all.map(t => {
		const li = el('li');
		const d = el('details', 'tier-more');
		const sum = el('summary');
		const img = el('img');
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(t.name, t.color))}`;
		img.alt = `badgR: ${t.name}`;
		sum.append(img, el('span', '', t.summary ?? t.description ?? `No finding of ${listing(t.forbid.map(f => f.reason ?? 'a forbidden kind'))}.`));
		d.append(sum);
		const body = el('div', 'tier-body');
		if(t.description && t.description !== t.summary) {
			body.append(el('p', '', sentence(t.description) + '.'));
		}
		if(t.forbid.length > 0 || t.lint.length > 0) {
			const rules = el('ul');
			rules.append(...t.forbid.map(f => el('li', '', `Fails on ${f.reason ?? 'a forbidden finding'}.`)));
			if(t.lint.length > 0) {
				const item = el('li');
				item.append('Fails if one of these flowR linting rules reports something: ');
				t.lint.forEach((x, i) => {
					const v = vocabulary?.lintRules.find(r => r.name === x);
					const a = link(v?.docs ?? Docs.linter, x, v?.about);
					a.className = 'rule';
					item.append(...(i > 0 ? [i === t.lint.length - 1 ? ', and ' : ', '] : []), a);
				});
				item.append('.');
				rules.append(item);
			}
			body.append(rules);
		}
		const review = el('p');
		review.append(el('strong', '', 'Left to review: '), t.review === 'full' ? 'all findings.' : `${t.review}.`);
		body.append(review);
		if(!t.fallback) {
			const how = el('p', 'hint');
			how.append('flowR checks this with the ', link(Docs.inputSources, 'input-sources query', 'where the values at a sink come from'),
				' and the ', link(Docs.sigdb, 'signature database', 'which calls reach a sink inside a package'), '.');
			body.append(how);
		}
		d.append(body);
		li.append(d);
		return li;
	}));
	const top = p.tiers[1]?.name ?? p.tiers[0]?.name ?? 'silver';
	$('snippet').textContent = [
		'# the Docker image has flowR and its signature database inside and needs no network',
		'docker pull eagleoutice/badgr',
		'docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" eagleoutice/badgr \\',
		'  --badge /work/badge.svg --md /work/report.md /work/app',
		'',
		`# in CI: fail below ${top} (exit code 2)`,
		`docker run --rm -v "$PWD:/work/src:ro" eagleoutice/badgr --min-tier ${top} /work/src`,
		'',
		'# or with Node.js, from a clone of the repository',
		'npm run badgr -- app/ --badge badge.svg',
		'',
		'# in the README',
		'![badgR](badge.svg)'
	].join('\n');
}
drawTierTable();

/* the start: the four example tiers, one click each */
for(const ex of Examples.slice(0, 4)) {
	const b = el('button', 'start-card');
	b.type = 'button';
	const img = el('img');
	img.alt = '';
	const tier = policy?.tiers.find(t => t.name === ex.label) ?? (ex.label === policy?.fallbackTier.name ? policy.fallbackTier : undefined);
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(ex.label, tier?.color ?? '#6b6b6b'))}`;
	const holder = el('span', 'start-badge');
	holder.append(img);
	b.append(holder, el('span', '', sentence(ex.title) + '.'));
	b.addEventListener('click', () => {
		document.querySelector<HTMLButtonElement>('[data-tab="paste"]')?.click();
		setText(codeView, ex.files.map(f => f.content).join('\n'));
		runEditor();
	});
	$('start').append(b);
}

/* ---------------------------------------------------------------- start */

/* links into the page: `#url=` (a repository or file), `#z=` (compressed code) or `#code=` (plain code),
   with the shared tier and selection */
function openLink(): void {
	const q = new URLSearchParams(location.hash.slice(1));
	const tier = q.get('tier') ?? undefined;
	const n = q.get('n');
	const at = q.get('at') ?? undefined;
	const reselect = () => {
		if(at === undefined || last === undefined) {
			return;
		}
		const sel = parseAt(at);
		const first = last.files.find(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path))?.path;
		if(sel?.kind === 'f') {
			const f = last.report.findings.find(x => (x.file ?? first) === sel.file && String(x.loc?.[0] ?? 0) === sel.line && x.call === sel.call)
				?? last.report.findings.find(x => (x.file ?? first) === sel.file && x.call === sel.call)
				?? last.report.findings.find(x => String(x.loc?.[0] ?? 0) === sel.line);
			if(f) {
				selectFinding(f, true);
			}
		} else if(sel?.kind === 'l') {
			const results = last.report.lint.find(l => l.rule === sel.rule)?.results ?? [];
			const x = results.find(y => (y.file ?? first) === sel.file && String(y.loc?.[0] ?? 0) === sel.line) ?? results.find(y => String(y.loc?.[0] ?? 0) === sel.line);
			if(x) {
				selectLint(sel.rule, x, true);
			}
		}
	};
	exportAfter = q.get('export') ?? undefined;
	const view = q.get('view');
	if(view !== null) {
		startRaw(view);
	}
	/* the link names the policy it was made with (none: the default), so it shows the same tier */
	const p = q.get('p');
	let linkPolicy = defaultPolicy;
	if(p !== null) {
		try {
			linkPolicy = strFromU8(inflateLimited(unb64url(p), 1 << 20));
			parsePolicy(linkPolicy, 'policy', '');
		} catch(e) {
			showError(`The policy in this link is damaged, so the default policy is used: ${e instanceof Error ? e.message : String(e)}`);
			linkPolicy = defaultPolicy;
		}
	}
	/* only a link to a result or a policy names a policy; the bare page keeps the one of this browser */
	if(['url', 'z', 'code', 'p'].some(k => q.has(k)) && !samePolicy(linkPolicy, policyText)) {
		const mine = policyText;
		setText(yamlView, linkPolicy);
		policyNote(isDefault(linkPolicy) ? 'This link was made with the default policy, which now replaces yours.' : 'This link was made with its own policy, which now replaces yours.', mine);
	}
	/* the decisions of the link's reviewer join the ones in this browser */
	const rv = q.get('rv');
	if(rv !== null) {
		try {
			for(const e of parseReview(strFromU8(inflateLimited(unb64url(rv), 4 << 20)))) {
				reviews.set(e.key, e);
			}
			saveReviews();
		} catch{ /* a damaged link keeps its code and loses its review */ }
	}
	let code = q.get('code') ?? undefined;
	const z = q.get('z');
	if(z !== null) {
		try {
			code = strFromU8(inflateLimited(unb64url(z)));
		} catch{
			showError('The code in this link is damaged.');
		}
	}
	if(q.get('url') !== null) {
		const url = q.get('url') as string;
		$<HTMLInputElement>('url-input').value = url;
		document.querySelector<HTMLButtonElement>('[data-tab="url"]')?.click();
		const kind = describeUrl(url)?.kind;
		if(kind === 'playground' || kind === 'own') {
			/* the code is in the link itself, so nothing is fetched and it is analyzed at once */
			showShared(tier, n, 'Analyzing the code from the link…');
			$<HTMLFormElement>('url-form').requestSubmit();
		} else {
			/* fetching from another site waits for a click; the link's result shows until then */
			showShared(tier, n, `Fetch ${url} to see it here.`, () => $<HTMLFormElement>('url-form').requestSubmit());
		}
	} else if(code !== undefined) {
		setText(codeView, code);
		document.querySelector<HTMLButtonElement>('[data-tab="paste"]')?.click();
		showShared(tier, n, 'Analyzing the code from the link…');
		/* the code is analyzed here, without any request, so the link's result comes back at once */
		runEditor(reselect);
	}
}

function showShared(tier: string | undefined, n: string | null, note: string, act?: () => void): void {
	if(tier === undefined || policy === undefined) {
		return;
	}
	const t = [...policy.tiers, policy.fallbackTier].find(x => x.name === tier);
	/* a link can claim only a tier the policy has, and a count that is a number */
	if(t === undefined) {
		return;
	}
	if(n !== null && !/^\d{1,9}$/.test(n)) {
		n = null;
	}
	const box = $('shared');
	const img = el('img');
	img.alt = `badgR: ${tier}`;
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(tier, t.color))}`;
	const p = el('p');
	p.append(`This link was shared with tier ${tier}${n !== null ? ` and ${plural(Number(n), 'finding')}` : ''}. ${note}`);
	box.replaceChildren(img, p);
	if(act) {
		const b = el('button', 'button', 'Fetch and analyze');
		b.type = 'button';
		b.addEventListener('click', act);
		box.append(b);
	}
	box.hidden = false;
	$('empty').hidden = true;
}
openLink();
