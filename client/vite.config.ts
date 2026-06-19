import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'src/main.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => {
          if (info.name?.endsWith('.css')) {
            return 'assets/style.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});