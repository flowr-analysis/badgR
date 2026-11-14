/** Serves `web-dist/` on http://127.0.0.1:8080 (or $PORT). `serve(port, true)` adds the reload events of `web:dev`. */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const dist = path.resolve(__dirname, '..', 'web-dist');
const types: Record<string, string> = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};
const listeners = new Set<http.ServerResponse>();

/** tells every open page to reload */
export function reload(): void {
	for(const res of listeners) {
		res.write('data: reload\n\n');
	}
}

export function serve(port: number, live = false): http.Server {
	return http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		if(live && url.pathname === '/__live') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
			res.write(': connected\n\n');
			listeners.add(res);
			req.on('close', () => listeners.delete(res));
			return;
		}
		const file = path.join(dist, decodeURIComponent(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
		if(!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end('not found');
			return;
		}
		res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': live ? 'no-store' : 'max-age=60' }).end(fs.readFileSync(file));
	}).listen(port, '127.0.0.1', () => console.log(`badgR playground on http://127.0.0.1:${port}/${live ? ' (reloads on change)' : ''}`));
}

if(require.main === module) {
	serve(Number(process.env.PORT ?? 8080));
}
