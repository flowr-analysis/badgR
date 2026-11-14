/**
 * `npm run web:dev`: builds the playground, rebuilds on every change under web/, src/, and policies/, and
 * reloads the open pages. Unminified, with source maps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { context } from 'esbuild';
import { copyStatic, options } from './build-web';
import { reload, serve } from './serve-web';

async function main(): Promise<void> {
	copyStatic();
	let pending: NodeJS.Timeout | undefined;
	const changed = () => {
		clearTimeout(pending);
		pending = setTimeout(() => {
			console.log(`${new Date().toLocaleTimeString()} rebuilt, reloading`);
			reload();
		}, 80);
	};
	for(const o of options(true)) {
		const ctx = await context({ ...o, plugins: [...o.plugins ?? [], { name: 'reload', setup: b => b.onEnd(r => {
			if(r.errors.length === 0) {
				changed();
			}
		}) }] });
		await ctx.watch();
	}
	const web = path.resolve(__dirname, '..', 'web');
	fs.watch(web, (_, file) => {
		if(file === 'index.html' || file === 'style.css') {
			copyStatic();
			changed();
		}
	});
	serve(Number(process.env.PORT ?? 8080), true);
}

void main();
