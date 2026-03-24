import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 4000 },
  define: {
    __DEV__: JSON.stringify(true),
  },
  resolve: {
    alias: { '@': '/src' },
  },
});
