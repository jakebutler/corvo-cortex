import { defineConfig } from 'vitest/config';
import { cloudflareWorkers } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareWorkers()],
  test: {
    globals: true,
    environment: 'miniflare',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
});
