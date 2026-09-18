import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
const project = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: `${project}standalone`,
  base: '/cleanroom-detective/',
  publicDir: `${project}public`,
  plugins: [react()],
  define: { __CLEANROOM_STATIC__: 'true', __CLEANROOM_SERVER__: 'false' },
  resolve: { alias: { '@': project } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: `${project}pages-dist`, emptyOutDir: true },
});
