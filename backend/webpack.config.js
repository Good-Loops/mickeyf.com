const path = require('path');

module.exports = {
    entry: {
        server: ['./ts/app.ts'],
        'submission-receipt-cleanup': ['./ts/leaderboards/runSubmissionReceiptCleanup.ts'],
        'account-deletion-audit': ['./ts/accounts/runDeletionAudit.ts'],
    },
    target: 'node',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.node$/,
                use: 'node-loader'
            }
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: '[name].min.js',
        path: path.resolve(__dirname, 'dist'),
    },
    externals: {
        express: 'commonjs express', // Exclude express from bundling
    },
};
