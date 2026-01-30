const { src, dest, parallel } = require('gulp');

function buildNodeIcons() {
	return src('nodes/**/*.svg').pipe(dest('dist/nodes'));
}

function buildCredentialIcons() {
	return src('icons/**/*.svg').pipe(dest('dist/icons'));
}

exports['build:icons'] = parallel(buildNodeIcons, buildCredentialIcons);
