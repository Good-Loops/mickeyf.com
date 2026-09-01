import net from 'node:net';

const [host = '127.0.0.1', rawPort = '3306', rawTimeoutMs = '60000'] = process.argv.slice(2);
const port = Number.parseInt(rawPort, 10);
const timeoutMs = Number.parseInt(rawTimeoutMs, 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${rawPort}`);
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Invalid timeout: ${rawTimeoutMs}`);
}

const canConnect = () => new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (connected) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(connected);
    };

    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
});

const startedAt = Date.now();

while (!(await canConnect())) {
    if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for ${host}:${port}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(`Connected to ${host}:${port}`);
