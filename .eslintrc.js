module.exports = {
	root: true,
	env: {
		es6: true,
		node: true,
	},
	parser: '@typescript-eslint/parser',
	parserOptions: {
		project: ['./tsconfig.json'],
		sourceType: 'module',
		extraFileExtensions: ['.json'],
	},
	ignorePatterns: ['.eslintrc.js', '.eslintrc.prepublish.js', 'gulpfile.js', 'node_modules/', 'dist/'],
	plugins: ['@typescript-eslint', 'eslint-plugin-n8n-nodes-base'],
	extends: ['plugin:n8n-nodes-base/community'],
	rules: {
		'n8n-nodes-base/node-param-description-excess-final-period': 'off',
		'n8n-nodes-base/node-param-description-missing-final-period': 'off',
	},
};
