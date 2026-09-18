import { defineConfig } from 'vite';
import pages from './vite.pages.config';
export default defineConfig({
  ...pages,
  base: '/',
  define: { __CLEANROOM_STATIC__: 'true', __CLEANROOM_SERVER__: 'true' },
  build: { ...pages.build, outDir: '../server-dist', emptyOutDir: true },
});
