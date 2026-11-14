/**
 * Builds the playground into `web-dist/`: the page, the analysis worker (flowR and the tree-sitter wasm
 * inlined), the logo, and the default policy. The package data comes from `gen-web-data.ts`.
 *
 * Usage: tsx scripts/build-web.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinModules } from 'node:module';
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { logoSvg } from '../src/badge';

const root = path.resolve(__dirname, '..');
export const out = path.join(root, 'web-dist');
const empty = path.join(root, 'web', 'shims', 'empty.js');
const pathShim = path.join(root, 'web', 'shims', 'path-shim.js');
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string }).version;

/* flowR's modules read `process` while they are imported, so one has to exist (as in flowR's playground) */
const ProcessShim = 'globalThis.process ??= { argv: [], argv0: "browser", env: {}, platform: "browser",'
	+ ' versions: {}, cwd: () => "/", exit: () => undefined,'
	+ ' on: () => undefined, hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }),'
	+ ' stdout: { write: () => true }, stderr: { write: () => true }, nextTick: f => queueMicrotask(f) };';

/** every node built-in becomes an empty module, except `path`, whose arithmetic flowR needs */
const stubNodeBuiltins: Plugin = {
	name: 'stub-node-builtins',
	setup(b) {
		const known = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
		b.onResolve({ filter: /.*/ }, args => {
			const bare = args.path.split('/')[0].replace(/^node:/, '');
			if(bare === 'path') {
				return { path: pathShim };
			}
			return known.has(args.path) || known.has(bare) || known.has(`node:${bare}`) ? { path: empty } : undefined;
		});
	}
};

const flowrVersion = (JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@eagleoutice', 'flowr', 'package.json'), 'utf-8')) as { version: string }).version;

/** the esbuild options of the worker and the page; `live` adds the reload hook of `web:dev` */
export function options(live: boolean): BuildOptions[] {
	const common: BuildOptions = {
		bundle:        true,
		minify:        !process.env.BADGR_WEB_DEBUG && !live,
		sourcemap:     process.env.BADGR_WEB_DEBUG || live ? 'inline' : false,
		format:        'iife',
		mainFields:    ['browser', 'module', 'main'],
		platform:      'browser',
		target:        'es2022',
		legalComments: 'none',
		logLevel:      'warning',
		define:        {
			'process.env.NODE_ENV': '"production"', '__dirname': '"/"', '__filename': '"/main.js"',
			'BADGR_VERSION': JSON.stringify(version),
			'FLOWR_VERSION': JSON.stringify(flowrVersion), 'BADGR_LIVE': String(live)
		},
		banner:        { js: ProcessShim },
		plugins:       [stubNodeBuiltins],
		/* the wasm files load as files of their own: fetched in parallel and compiled while streaming, not as base64 inside the script */
		loader:        { '.wasm': 'file', '.R': 'text', '.yaml': 'text' },
		assetNames:    '[name]-[hash]',
		nodePaths:     [path.join(root, 'node_modules')],
		metafile:      true
	};
	return [
		{ ...common, entryPoints: [path.join(root, 'web', 'worker.ts')], outfile: path.join(out, 'worker.js') },
		{ ...common, entryPoints: [path.join(root, 'web', 'main.ts')], outfile: path.join(out, 'main.js') }
	];
}

/** the page's static files and the logos */
export function copyStatic(): void {
	fs.mkdirSync(out, { recursive: true });
	for(const f of ['index.html', 'style.css']) {
		fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
	}
	fs.writeFileSync(path.join(out, 'badgr-logo.svg'), logoSvg(128));
	fs.writeFileSync(path.join(out, 'badgr-icon.svg'), logoSvg(64, false));
	fs.writeFileSync(path.join(out, '.nojekyll'), '');
}

async function main(): Promise<void> {
	copyStatic();
	const results = await Promise.all(options(false).map(o => build(o)));
	const size = results.flatMap(r => Object.values(r.metafile?.outputs ?? {})).reduce((s, o) => s + o.bytes, 0);
	console.log(`wrote ${out} (${(size / 1e6).toFixed(1)} MB of scripts and wasm)`);
	if(!fs.existsSync(path.join(out, 'pkgs', 'index.json'))) {
		console.log('no package data yet: run `npm run web:data` (tsx scripts/gen-web-data.ts web-dist/pkgs)');
	}
}

if(require.main === module) {
	void main();
}
