import {build} from 'esbuild';

// CKEditor packages are NOT bundled: Liferay's import map resolves
// "@ckeditor/ckeditor5-*/dist/index.js" to the editor's own instances, so the
// plugin shares the exact classes (Plugin, Widget, ContextualBalloon...) the
// running editor uses.

await build({
	bundle: true,
	entryPoints: ['src/index.js'],
	external: ['@ckeditor/*'],
	format: 'esm',
	loader: {'.css': 'text'},
	minify: false,
	outdir: 'build',
	target: 'es2020',
});

console.log('aihub-mention-ckeditor built');
