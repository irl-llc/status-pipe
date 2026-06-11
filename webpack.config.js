//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
	target: 'node', // VS Code extension hosts run in Node
	mode: 'none', // production mode is set by the `package` script

	entry: './src/extension.ts',
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: 'extension.js',
		libraryTarget: 'commonjs2',
	},
	externals: {
		vscode: 'commonjs vscode', // provided by the host, must not be bundled
	},
	resolve: {
		extensions: ['.ts', '.js'],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [{ loader: 'ts-loader' }],
			},
		],
	},
	devtool: 'nosources-source-map',
	infrastructureLogging: {
		level: 'log', // enables logging required for problem matchers
	},
};

/** @type {(mode: string) => WebpackConfig} */
const webviewConfig = (mode) => ({
	target: 'web', // webview runs in a browser context
	mode: 'none',

	entry: './src/queueView/queueView.tsx',
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: 'queueView.js',
		libraryTarget: 'var',
		library: 'queueView',
	},
	resolve: {
		extensions: ['.tsx', '.ts', '.js'],
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				exclude: /node_modules/,
				use: [{ loader: 'ts-loader' }],
			},
		],
	},
	plugins: [
		// React reads process.env.NODE_ENV at runtime to pick its dev/prod
		// builds. The webview has no `process`, so webpack must inline this
		// value (at mode 'none' the default DefinePlugin does not fire);
		// it follows the build mode so `npm run package` ships prod React.
		new webpack.DefinePlugin({
			'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
		}),
		new CopyWebpackPlugin({
			patterns: [
				{
					from: path.resolve(__dirname, 'node_modules/@vscode/codicons/dist'),
					to: path.resolve(__dirname, 'dist/codicons'),
				},
			],
		}),
	],
	devtool: 'nosources-source-map',
	infrastructureLogging: {
		level: 'log',
	},
});

module.exports = (env, argv) => {
	const mode = (argv && argv.mode) || 'none';
	const webview = webviewConfig(mode);
	if (mode === 'production') {
		extensionConfig.mode = 'production';
		webview.mode = 'production';
	}
	return [extensionConfig, webview];
};
