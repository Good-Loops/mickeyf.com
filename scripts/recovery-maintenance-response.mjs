import { createServer } from 'node:http';

// Match the existing production API origins; never reflect an arbitrary origin.
const origins = new Set([
    'https://mickeyf.com',
    'https://www.mickeyf.com',
    'capacitor://localhost',
    'http://localhost:5173',
]);

const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        if (request.method === 'OPTIONS') {
            response.writeHead(204, {
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            });
            response.end();
            return;
        }
    }
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Ludolume is temporarily unavailable. Please try again later.');
});

server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => {
    console.log(`Maintenance response listening on ${server.address().port}`);
});
