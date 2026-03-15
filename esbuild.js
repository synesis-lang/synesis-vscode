const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['extension.js'],
    bundle: true,
    platform: 'node',
    target: 'node14',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    minify: !isWatch  // minify in production, skip during dev watch
};

if (isWatch) {
    esbuild.context(buildOptions).then((ctx) => ctx.watch());
} else {
    esbuild.build(buildOptions).catch(() => process.exit(1));
}
