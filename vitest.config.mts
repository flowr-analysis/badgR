import { defineConfig } from 'vitest/config';

/* the page imports the policy and the examples as text, as its bundler does */
const asText = {
	name:      'badgr-text',
	transform: (code: string, id: string) => /\.(yaml|R)$/.test(id) ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined
};

export default defineConfig({ plugins: [asText], test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 } });
