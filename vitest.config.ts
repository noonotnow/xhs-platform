import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'transform-react-tests',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('.tsx')) return;
      return transformWithEsbuild(code, id, {
        loader: 'tsx',
        jsx: 'automatic',
      });
    },
  }],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
  },
});
