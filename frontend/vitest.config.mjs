import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the extracted, framework-free modules for now. Component tests need
    // jsdom and a much larger setup; the value here is covering the glue that
    // has actually been breaking.
    include: ['src/**/*.test.{js,jsx}'],
    environment: 'node',
    reporters: ['default']
  }
});
