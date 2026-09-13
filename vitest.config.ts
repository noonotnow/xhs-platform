import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'transform-react-tests',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('.tsx')) return;
      const result = await transformWithEsbuild(code, id, {
        loader: 'tsx',
        jsx: 'automatic',
      });
      return { code: result.code, map: JSON.stringify(result.map) };
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
