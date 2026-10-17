import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
await build({
    absWorkingDir: projectDirectory,
    entryPoints: ['server/vercel-entry.ts'],
    outfile: 'api/handler.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    sourcemap: false,
    minify: false,
    banner: { js: '// Gerado por npm run build:api. Edite os arquivos TypeScript em server/.' },
});
