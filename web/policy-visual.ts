/**
 * The policy as forms to click. Per tier, a grid of capabilities (grouped by sink class) against value
 * origins, each cell allowed or forbidden in the app's own calls, inside packages, or both. Below, the
 * settings of the whole policy: which flowR input types form which origin, the capabilities' classes and
 * tags, trusted functions, and extra linting rules. Every edit goes back into the YAML, which keeps its
 * comments.
 */
import { parseDocument, isSeq, isMap, type Document } from 'yaml';
import { NoOrigin, parsePolicy, type ForbidRule, type Policy } from '../src/policy-core';
import type { PolicyVocabulary } from './protocol';

type Via = 'direct' | 'package' | 'any';
type Cell = Via | undefined;

const Order: (Via | 'none')[] = ['none', 'direct', 'package', 'any'];
const Label: Record<string, string> = { none: '·', direct: 'app', package: 'pkg', any: 'all', mixed: '~' };
const Title: Record<string, string> = {
	none: 'allowed', direct: 'forbidden in the app\'s own calls', package: 'forbidden inside packages',
	any: 'forbidden everywhere', mixed: 'differs between the capabilities of this class'
};
const Wiki = 'https://github.com/flowr-analysis/flowr/wiki/';
const Docs = {
	inputSources: `${Wiki}%5BQuery%5D-Input-Sources`,
	functionInfo: `${Wiki}%5BQuery%5D-Function-Info`,
	sigdb:        `${Wiki}Signature-Database`,
	linter:       `${Wiki}%5BQuery%5D-Linter`
};

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
const listing = (xs: readonly string[]) => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`;

/** short lists inline, `[a, b]`, as the default policy writes them */
function flowLists(node: unknown): void {
	if(isSeq(node)) {
		if(node.items.every(i => !isMap(i) && !isSeq(i))) {
			node.flow = true;
		}
		node.items.forEach(i => flowLists(i));
	} else if(isMap(node)) {
		node.items.forEach(p => flowLists(p.value));
	}
}
function flowed(doc: Document, value: unknown): unknown {
	const node = doc.createNode(value);
	flowLists(node);
	return node;
}

function merge(a: Cell, b: Via): Via {
	return a === undefined ? b : a === b ? a : 'any';
}

interface Shape {
	readonly classes: readonly string[]
	readonly capsOf:  ReadonlyMap<string, readonly string[]>
	readonly caps:    readonly string[]
	readonly origins: readonly string[]
}

export function shapeOf(policy: Policy): Shape {
	const capsOf = new Map<string, string[]>();
	for(const [name, c] of Object.entries(policy.capabilities)) {
		capsOf.set(c.class, [...capsOf.get(c.class) ?? [], name]);
	}
	return { classes: [...capsOf.keys()], capsOf, caps: Object.keys(policy.capabilities), origins: [...Object.keys(policy.origins), NoOrigin] };
}

/** the cells a list of rules forbids: every rule is classes or capabilities, origins, and via */
export function gridOf(rules: readonly ForbidRule[], shape: Shape): Map<string, Cell> {
	const grid = new Map<string, Cell>();
	for(const r of rules) {
		const byClass = r.classes?.flatMap(c => shape.capsOf.get(c) ?? []);
		const caps = r.capabilities && byClass ? r.capabilities.filter(c => byClass.includes(c)) : r.capabilities ?? byClass ?? shape.caps;
		for(const c of caps) {
			for(const o of r.origins ?? shape.origins) {
				grid.set(`${c}|${o}`, merge(grid.get(`${c}|${o}`), r.via ?? 'any'));
			}
		}
	}
	return grid;
}

function reasonFor(what: string, origins: readonly string[] | undefined, via: Via): string {
	const values = origins === undefined ? 'whatever its values'
		: origins.length === 1 && origins[0] === NoOrigin ? 'without a traced value'
			: `with ${listing(origins.filter(o => o !== NoOrigin))} values${origins.includes(NoOrigin) ? ' or none' : ''}`;
	const where = via === 'direct' ? ' in the app\'s own code' : via === 'package' ? ' inside a package' : '';
	return `${what}${where}, ${values}`;
}

/** the grid as rules: per via, the capabilities that forbid the same origins share a rule; whole classes are named as classes */
export function rulesOf(grid: Map<string, Cell>, shape: Shape, old: readonly ForbidRule[]): ForbidRule[] {
	const out: ForbidRule[] = [];
	const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	for(const via of ['any', 'direct', 'package'] as const) {
		const groups = new Map<string, string[]>();
		for(const c of shape.caps) {
			const os = shape.origins.filter(o => grid.get(`${c}|${o}`) === via);
			if(os.length > 0) {
				const key = os.join(',');
				groups.set(key, [...groups.get(key) ?? [], c]);
			}
		}
		for(const [key, caps] of groups) {
			const os = key.split(',');
			const origins = os.length === shape.origins.length ? undefined : os;
			const whole = shape.classes.filter(k => (shape.capsOf.get(k) ?? []).every(c => caps.includes(c)));
			const rest = caps.filter(c => !whole.some(k => shape.capsOf.get(k)?.includes(c)));
			const emit = (rule: Omit<ForbidRule, 'reason'>, what: string) => {
				const prev = old.find(r => same(r.classes, rule.classes) && same(r.capabilities, rule.capabilities) && same(r.origins, rule.origins) && (r.via ?? 'any') === via);
				out.push({ ...rule, ...(via === 'any' ? {} : { via }), reason: prev?.reason ?? reasonFor(what, origins, via) });
			};
			if(whole.length > 0) {
				emit({ classes: whole, ...(origins ? { origins } : {}) }, `a ${listing(whole)} sink`);
			}
			if(rest.length > 0) {
				emit({ capabilities: rest, ...(origins ? { origins } : {}) }, `a call with ${listing(rest)}`);
			}
		}
	}
	return out;
}

function cellButton(state: string, title: string, onClick: (back: boolean) => void): HTMLButtonElement {
	const b = el('button', `cell v-${state}`, Label[state]);
	b.type = 'button';
	b.title = title;
	b.addEventListener('click', ev => onClick(ev.shiftKey));
	b.addEventListener('contextmenu', ev => {
		ev.preventDefault();
		onClick(true);
	});
	return b;
}
const step = (state: string, back: boolean): Via | undefined => {
	const i = Order.indexOf(state as Via | 'none');
	const next = Order[(i + (back ? Order.length - 1 : 1)) % Order.length];
	return next === 'none' ? undefined : next as Via;
};

function chips(items: readonly string[], cls: string, href: (x: string) => string | undefined, title: (x: string) => string | undefined, remove: (x: string) => void): HTMLElement[] {
	return items.map(x => {
		const span = el('span', `chip on ${cls}`);
		const h = href(x);
		span.append(h ? link(h, x, title(x)) : x);
		const del = el('button', 'chip-x', '×');
		del.type = 'button';
		del.title = `remove ${x}`;
		del.addEventListener('click', () => remove(x));
		span.append(del);
		return span;
	});
}

function picker(label: string, options: readonly { value: string, title?: string }[], pick: (v: string) => void): HTMLSelectElement {
	const s = el('select');
	s.append(el('option', '', label));
	for(const o of options) {
		const opt = el('option', '', o.value);
		opt.value = o.value;
		if(o.title) {
			opt.title = o.title;
		}
		s.append(opt);
	}
	s.addEventListener('change', () => s.selectedIndex > 0 && pick(s.value));
	return s;
}

function option(value: string, text = value): HTMLOptionElement {
	const o = el('option', '', text);
	o.value = value;
	return o;
}

/** which tiers are unfolded, kept across redraws */
const openTiers = new Set<number>([0]);

/** draws the forms into `root`; `change` receives the new YAML */
export function renderVisual(root: HTMLElement, text: string, vocabulary: PolicyVocabulary | undefined, change: (yaml: string) => void): void {
	let policy: Policy;
	try {
		policy = parsePolicy(text, 'policy', '');
	} catch(e) {
		root.replaceChildren(el('p', 'hint', `Fix the YAML first: ${e instanceof Error ? e.message : String(e)}`));
		return;
	}
	const shape = shapeOf(policy);
	const settingsOpen = root.querySelector<HTMLDetailsElement>('.vsettings')?.open ?? false;
	const edit = (fn: (doc: Document) => void) => {
		const doc = parseDocument(text);
		fn(doc);
		change(doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
	};
	const ruleDocs = (r: string) => vocabulary?.lintRules.find(x => x.name === r);

	const legend = el('p', 'hint legend');
	legend.append('Click a cell to step through ');
	for(const s of ['none', 'direct', 'package', 'any']) {
		legend.append(el('span', `cell-key v-${s}`, Label[s]), ` ${Title[s]}, `);
	}
	legend.append('and shift-click or right-click to step back. Origins come from flowR\'s ', link(Docs.inputSources, 'input-sources query'),
		', calls inside packages from its ', link(Docs.sigdb, 'signature database'), '.');

	const tiers = policy.tiers.map((t, ti) => {
		const box = el('details', 'vtier');
		box.open = openTiers.has(ti);
		box.addEventListener('toggle', () => box.open ? openTiers.add(ti) : openTiers.delete(ti));
		const head = el('summary');
		const color = el('input');
		color.type = 'color';
		color.value = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#888888';
		color.title = 'badge color';
		color.addEventListener('click', ev => ev.stopPropagation());
		color.addEventListener('change', () => edit(d => d.setIn(['tiers', ti, 'color'], color.value)));
		head.append(color, el('strong', '', t.name), el('span', 'hint', t.summary ?? ''));
		box.append(head);

		const grid = gridOf(t.forbid, shape);
		const write = () => edit(d => d.setIn(['tiers', ti, 'forbid'], flowed(d, rulesOf(grid, shape, t.forbid))));
		const wrap = el('div', 'table-wrap');
		const table = el('table', 'vgrid');
		const colgroup = el('colgroup');
		colgroup.append(el('col', 'vg-name'), ...shape.origins.map(() => el('col', 'vg-cell')));
		const hr = el('tr');
		hr.append(el('th'), ...shape.origins.map(o => {
			const th = el('th');
			th.append(o === NoOrigin
				? link(Docs.inputSources, 'no value', 'calls flowR traced no value for, such as calls without arguments')
				: link(Docs.inputSources, o, `flowR input types ${listing(policy.origins[o] ?? [])}`));
			return th;
		}));
		const thead = el('thead');
		thead.append(hr);
		const tbody = el('tbody');
		for(const k of shape.classes) {
			const caps = shape.capsOf.get(k) ?? [];
			/* the class row sets all its capabilities at once */
			const ctr = el('tr', 'vg-class');
			const cth = el('th', '', k);
			cth.title = `all ${caps.length} capabilities of class ${k}`;
			ctr.append(cth);
			for(const o of shape.origins) {
				const states = new Set(caps.map(c => grid.get(`${c}|${o}`) ?? 'none'));
				const state = states.size === 1 ? [...states][0] : 'mixed';
				const td = el('td');
				td.append(cellButton(state, `${k} × ${o === NoOrigin ? 'no value' : o}: ${Title[state]}, for all of ${listing(caps)}`, back => {
					const next = step(state === 'mixed' ? 'none' : state, back);
					caps.forEach(c => grid.set(`${c}|${o}`, next));
					write();
				}));
				ctr.append(td);
			}
			tbody.append(ctr);
			for(const c of caps) {
				const spec = policy.capabilities[c];
				const tr = el('tr', 'vg-cap');
				const th = el('th');
				th.append(link(Docs.functionInfo, c, `${spec.description ?? c}${spec.tags?.length ? `. flowR tags: ${spec.tags.join(', ')}` : ''}${spec.functions?.length ? `. Functions: ${spec.functions.join(' ')}` : ''}`));
				tr.append(th);
				for(const o of shape.origins) {
					const state = grid.get(`${c}|${o}`) ?? 'none';
					const td = el('td');
					td.append(cellButton(state, `${c} × ${o === NoOrigin ? 'no value' : o}: ${Title[state]}`, back => {
						grid.set(`${c}|${o}`, step(state, back));
						write();
					}));
					tr.append(td);
				}
				tbody.append(tr);
			}
		}
		table.append(colgroup, thead, tbody);
		wrap.append(table);
		box.append(wrap);

		const lint = el('div', 'vrow');
		lint.append(el('span', 'vlabel', 'Linting rules'));
		lint.append(...chips(t.lint, 'rule-chip', r => ruleDocs(r)?.docs ?? Docs.linter, r => ruleDocs(r)?.about,
			r => edit(d => d.setIn(['tiers', ti, 'lint'], flowed(d, t.lint.filter(x => x !== r))))));
		lint.append(picker('+ rule', (vocabulary?.lintRules ?? []).filter(r => !t.lint.includes(r.name)).map(r => ({ value: r.name, title: r.about })),
			v => edit(d => d.setIn(['tiers', ti, 'lint'], flowed(d, [...t.lint, v])))));
		box.append(lint);

		for(const [key, label, value] of [['summary', 'In one line', t.summary ?? ''], ['review', 'Review left', t.review]] as const) {
			const row = el('label', 'vrow');
			row.append(el('span', 'vlabel', label));
			const input = el('input');
			input.value = value;
			input.addEventListener('change', () => edit(d => d.setIn(['tiers', ti, key], input.value)));
			row.append(input);
			box.append(row);
		}
		return box;
	});

	/* ---------------------------------------------------------------- the whole policy */
	const settings = el('details', 'vsettings');
	settings.open = settingsOpen;
	settings.append(el('summary', '', 'Settings of the whole policy'));

	/* origins: each flowR input type in one class */
	const types = [...new Set([...vocabulary?.inputTypes ?? [], ...Object.values(policy.origins).flat()])];
	const classOf = (ty: string) => Object.entries(policy.origins).find(([, v]) => v.includes(ty))?.[0];
	const og = el('div', 'vblock');
	const oh = el('h4');
	oh.append('Origins ', el('span', 'hint', 'which flowR input type counts as which origin, from the '), link(Docs.inputSources, 'input-sources query'));
	og.append(oh);
	const ot = el('div', 'vtypes');
	for(const ty of types) {
		const row = el('label', 'vtype');
		row.append(el('code', '', ty));
		const sel = el('select');
		sel.append(option('', `(${policy.fallbackOrigin}, the fallback)`), ...Object.keys(policy.origins).map(o => option(o)));
		sel.value = classOf(ty) ?? '';
		sel.addEventListener('change', () => edit(d => {
			for(const [o, list] of Object.entries(policy.origins)) {
				const next = list.filter(x => x !== ty);
				if(o === sel.value) {
					next.push(ty);
				}
				d.setIn(['origins', o], flowed(d, next));
			}
		}));
		row.append(sel);
		ot.append(row);
	}
	og.append(ot);
	const fb = el('label', 'vrow');
	fb.append(el('span', 'vlabel', 'Fallback origin'));
	const fsel = el('select');
	fsel.append(...Object.keys(policy.origins).map(o => option(o)));
	fsel.value = policy.fallbackOrigin;
	fsel.addEventListener('change', () => edit(d => d.set('fallbackOrigin', fsel.value)));
	fb.append(fsel, el('span', 'hint', 'for input types no origin lists'));
	og.append(fb);

	/* capabilities: class and flowR tags */
	const cg = el('div', 'vblock');
	const ch = el('h4');
	ch.append('Capabilities ', el('span', 'hint', 'their sink class, and the flowR semantic tags that give a function the capability, see the '), link(Docs.functionInfo, 'function-info query'));
	cg.append(ch);
	const classes = [...new Set(['severe', 'outward', 'other', ...shape.classes])];
	for(const [name, spec] of Object.entries(policy.capabilities)) {
		const row = el('div', 'vrow vcap');
		const n = el('span', 'vlabel');
		n.append(el('code', '', name));
		n.title = `${spec.description ?? ''}${spec.functions?.length ? `. Functions: ${spec.functions.join(' ')}` : ''}`;
		const sel = el('select');
		sel.append(...classes.map(k => option(k)));
		sel.value = spec.class;
		sel.title = 'sink class';
		sel.addEventListener('change', () => edit(d => d.setIn(['capabilities', name, 'class'], sel.value)));
		row.append(n, sel, ...chips(spec.tags ?? [], 'tag-chip', () => Docs.functionInfo, t => `flowR semantic call tag ${t}`,
			t => edit(d => d.setIn(['capabilities', name, 'tags'], flowed(d, (spec.tags ?? []).filter(x => x !== t))))));
		row.append(picker('+ tag', (vocabulary?.tags ?? []).filter(t => !spec.tags?.includes(t)).map(t => ({ value: t })),
			t => edit(d => d.setIn(['capabilities', name, 'tags'], flowed(d, [...spec.tags ?? [], t])))));
		cg.append(row);
	}

	/* trusted functions and extra linting rules */
	const tg = el('div', 'vblock');
	const th = el('h4');
	th.append('Trusted ', el('span', 'hint', 'package functions whose sinks inside the package do not count, as regular expressions on pkg::fn'));
	tg.append(th);
	const trow = el('div', 'vrow');
	trow.append(...chips(policy.trusted, 'regex-chip', () => undefined, () => undefined,
		x => edit(d => d.set('trusted', flowed(d, policy.trusted.filter(y => y !== x))))));
	const add = el('input');
	add.placeholder = '^pkg::fn$ and Enter';
	add.addEventListener('keydown', ev => {
		if(ev.key === 'Enter' && add.value.trim()) {
			const v = add.value.trim();
			edit(d => d.set('trusted', flowed(d, [...policy.trusted, v])));
		}
	});
	trow.append(add);
	tg.append(trow);

	const rg = el('div', 'vblock');
	const rh = el('h4');
	rh.append('Reported ', el('span', 'hint', 'flowR linting rules that run and show in the report without deciding a tier, see the '), link(Docs.linter, 'linter query'));
	rg.append(rh);
	const rrow = el('div', 'vrow');
	rrow.append(...chips(policy.report, 'rule-chip', r => ruleDocs(r)?.docs ?? Docs.linter, r => ruleDocs(r)?.about,
		r => edit(d => d.set('report', flowed(d, policy.report.filter(x => x !== r))))));
	rrow.append(picker('+ rule', (vocabulary?.lintRules ?? []).filter(r => !policy.report.includes(r.name)).map(r => ({ value: r.name, title: r.about })),
		v => edit(d => d.set('report', flowed(d, [...policy.report, v])))));
	rg.append(rrow);

	settings.append(og, cg, tg, rg);
	root.replaceChildren(legend, ...tiers, settings);
}
