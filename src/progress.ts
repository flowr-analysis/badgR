import type { Progress } from './core';

const Steps: Record<Progress['phase'], number> = { files: 1, dataflow: 2, sinks: 3, origins: 4, lint: 5, tier: 6, done: 6 };

function clock(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Progress for the terminal, on stderr so stdout stays clean for `--json`.
 *
 * On a terminal it redraws one status line: which artifact of how many, the step of the analysis, a bar
 * for steps that count, how long the artifact has taken, and an estimate for the remaining artifacts from
 * the ones done so far. The line keeps ticking while flowR builds the dataflow graph, the one long step
 * that reports nothing on its own. Piped into a file or a CI log, it prints one line per step instead,
 * without the redraws.
 */
export class ProgressPrinter {
	private readonly tty: boolean;
	private readonly started = Date.now();
	private artifactStart = Date.now();
	private index = 0;
	private label = '';
	private last: Progress | undefined;
	private lastAt = Date.now();
	private ticker: NodeJS.Timeout | undefined;
	private readonly durations: number[] = [];

	constructor(private readonly total: number, private readonly out: NodeJS.WriteStream = process.stderr, private readonly quiet = false) {
		this.tty = Boolean(out.isTTY) && !process.env.CI;
	}

	startArtifact(index: number, label: string): void {
		this.index = index;
		this.label = label;
		this.artifactStart = Date.now();
		this.last = undefined;
		if(this.tty && !this.quiet) {
			this.ticker = setInterval(() => this.draw(), 250);
			this.ticker.unref();
		}
	}

	update(p: Progress): void {
		/* the end of an artifact is its report, not a step */
		if(p.phase === 'done' || p.phase === 'tier') {
			return;
		}
		const changedStep = this.last?.phase !== p.phase;
		this.last = p;
		this.lastAt = Date.now();
		if(this.quiet) {
			return;
		}
		if(this.tty) {
			this.draw();
		} else if(changedStep) {
			this.out.write(`${this.prefix()} ${Steps[p.phase]}/5 ${p.message}\n`);
		}
	}

	/** ends the line of the artifact, to make room for its report */
	endArtifact(): void {
		clearInterval(this.ticker);
		this.durations.push(Date.now() - this.artifactStart);
		if(this.tty && !this.quiet) {
			this.out.write('\r\x1b[2K');
		}
	}

	private prefix(): string {
		return this.total > 1 ? `[${this.index + 1}/${this.total}] ${this.label}` : this.label;
	}

	private eta(): string {
		const p = this.last;
		if(p?.etaMs !== undefined) {
			const left = Math.max(0, p.etaMs - (Date.now() - this.lastAt));
			return left > 0 ? `, about ${clock(left)} left` : ', taking longer than estimated';
		}
		if(this.durations.length === 0 || this.total <= 1) {
			return '';
		}
		const mean = this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
		const left = (this.total - this.index - 1) * mean + Math.max(0, mean - (Date.now() - this.artifactStart));
		return `, about ${clock(left)} left`;
	}

	private draw(): void {
		const p = this.last;
		const width = Math.max(40, (this.out.columns || 100) - 1);
		const step = p ? `${Steps[p.phase]}/5 ${p.message}` : 'starting';
		const bar = p?.total ? ` ${this.bar(p.done ?? 0, p.total)}` : '';
		const time = ` ${clock(Date.now() - this.artifactStart)}${this.eta()}`;
		let line = `${this.prefix()}  ${step}${bar}${time}`;
		if(line.length > width) {
			line = line.slice(0, width - 1) + '…';
		}
		this.out.write(`\r\x1b[2K${line}`);
	}

	private bar(done: number, total: number): string {
		const n = 12;
		const full = Math.round(n * Math.min(1, done / Math.max(1, total)));
		return `[${'#'.repeat(full)}${'.'.repeat(n - full)}]`;
	}

	/** the summary after all artifacts */
	summary(tiers: readonly string[]): void {
		if(this.quiet || this.total <= 1) {
			return;
		}
		const counts = new Map<string, number>();
		for(const t of tiers) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		this.out.write(`${this.total} artifacts in ${clock(Date.now() - this.started)}: ${[...counts].map(([t, c]) => `${t} ${c}`).join(', ')}\n`);
	}
}
