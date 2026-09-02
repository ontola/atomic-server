// Tests target the server-side modules directly, so they run without the
// SvelteKit plugin: faster, and no `$app` imports to mock.
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			$server: path.resolve(import.meta.dirname, 'src/lib/server'),
			$lib: path.resolve(import.meta.dirname, 'src/lib')
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		globalSetup: ['./src/test/global-setup.ts'],
		fileParallelism: false,
		environment: 'node',
		testTimeout: 30_000
	}
})
