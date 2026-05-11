import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    // Stub API keys so SDK clients initialise without throwing at import time.
    // No real API calls are made in tests — they all use translationProvider=none.
    env: {
      OPENAI_API_KEY: 'test-key-stub',
      ANTHROPIC_API_KEY: 'test-key-stub',
      ASSEMBLYAI_API_KEY: 'test-key-stub',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
});
