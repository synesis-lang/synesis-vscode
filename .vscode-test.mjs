import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    tests: [
        {
            files: 'test/integration/**/*.test.js',
            mocha: {
                ui: 'bdd',
                timeout: 20000,
                color: true,
            },
            workspaceFolder: resolve(__dirname, 'test/fixtures/minimal'),
        },
    ],
});
