/**
 * A thread that runs flowR's linting rules for the command line: it reads the code once, then runs the
 * rules it is sent one at a time. The analysis stops the thread when a rule takes longer than the policy allows.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { log, LogLevelNames } from '@eagleoutice/flowr/util/log';
import { diskAnalyzer } from './analyze';
import { type LintMessage, lintRule } from './core';

const port = parentPort;
if(port !== null) {
	log.updateSettings(s => {
		s.settings.minLevel = LogLevelNames.fatal;
	});
	const post = (m: LintMessage) => port.postMessage(m);
	const { files, sigDir } = workerData as { files: string[], sigDir?: string };
	const ready = diskAnalyzer(files, sigDir).then(async a => {
		await a.dataflow();
		return a;
	});
	ready.then(() => post({ type: 'lint-ready' }), (e: unknown) => post({ type: 'lint-failed', error: e instanceof Error ? e.message : String(e) }));
	port.on('message', (rule: string) => {
		void ready.then(a => lintRule(a, rule)).then(r => post({ type: 'lint-done', ...r }));
	});
}
