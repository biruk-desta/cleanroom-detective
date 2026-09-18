import { build, preview } from 'vite';
import { fileURLToPath } from 'node:url';
// Same Vite plugins, worker bundling and base path as the deployed website.
const { default: config } = await import('../vite.pages.config.ts');
const root = fileURLToPath(new URL('./browser-validation', import.meta.url));
const outDir = fileURLToPath(new URL('../validation-dist', import.meta.url));
const options = {
  ...config,
  configFile: false,
  root,
  publicDir: false,
  build: { ...config.build, outDir },
  preview: { host: '127.0.0.1', port: 4175 },
};
await build(options);
const server = await preview(options);
server.printUrls();
