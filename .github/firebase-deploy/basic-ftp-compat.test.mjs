import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const getUriRequire = createRequire(require.resolve("get-uri"));
const { getUri } = require("get-uri");
const payload = "synthetic local FTP content\n";
const modified = new Date("2026-01-02T03:04:05Z");

// Exercise get-uri's actual basic-ftp caller across the scoped major override.
// All sockets bind only to loopback; no provider credentials or network service.
async function withFtp(run, { mdtm = true } = {}) {
  const sockets = new Set();
  const servers = [];
  const errors = [];
  function track(socket) {
    sockets.add(socket);
    socket.on("error", error => {
      // basic-ftp closes immediately after cache/missing-file responses on Windows.
      if (error.code !== "ECONNRESET") errors.push(error);
    });
    socket.on("close", () => sockets.delete(socket));
    return socket;
  }
  const control = createServer(socket => {
    track(socket).setEncoding("utf8");
    socket.write("220 Synthetic test server\r\n");
    let buffer = "";
    let queue = Promise.resolve();
    let dataConnection;
    async function command(line) {
      const [verb] = line.split(" ");
      if (verb === "USER") socket.write("331 Password required\r\n");
      else if (verb === "PASS") socket.write("230 Logged in\r\n");
      else if (verb === "FEAT") socket.write("211-Features\r\n MLST type;size;modify;\r\n211 End\r\n");
      else if (["TYPE", "STRU", "OPTS"].includes(verb)) socket.write("200 Accepted\r\n");
      else if (verb === "MDTM") socket.write(line.includes("missing") ? "550 Missing\r\n"
        : mdtm ? "213 20260102030405\r\n" : "502 Unsupported\r\n");
      else if (verb === "EPSV") {
        const data = createServer();
        servers.push(data);
        dataConnection = once(data, "connection").then(([connection]) => track(connection));
        data.listen(0, "127.0.0.1");
        await once(data, "listening");
        socket.write(`229 Entering passive mode (|||${data.address().port}|)\r\n`);
      } else if (verb === "RETR" || verb === "MLSD") {
        const data = await dataConnection;
        socket.write("150 Opening data connection\r\n");
        data.end(verb === "RETR" ? payload : `type=file;size=${Buffer.byteLength(payload)};modify=20260102030405; file.txt\r\n`,
          () => socket.write("226 Transfer complete\r\n"));
      } else if (verb === "QUIT") socket.end("221 Goodbye\r\n");
      else throw new Error(`Unexpected FTP test command: ${verb}`);
    }
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        queue = queue.then(() => command(line)).catch(error => { errors.push(error); socket.destroy(); });
      }
    });
  });
  servers.push(control);
  control.listen(0, "127.0.0.1");
  await once(control, "listening");
  try {
    await run(`ftp://127.0.0.1:${control.address().port}`);
    assert.deepEqual(errors, []);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

for (const mdtm of [true, false]) {
  test(`get-uri downloads with ${mdtm ? "MDTM" : "MLSD fallback"} metadata`, { timeout: 10000 }, async () => {
    await withFtp(async base => {
      const stream = await getUri(`${base}/file.txt`);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), payload);
      assert.equal(+stream.lastModified, +modified);
    }, { mdtm });
  });
}

test("get-uri preserves cached and missing-file errors", { timeout: 10000 }, async () => {
  await withFtp(async base => {
    await assert.rejects(getUri(`${base}/file.txt`, { cache: { lastModified: modified } }), { code: "ENOTMODIFIED" });
    await assert.rejects(getUri(`${base}/missing.txt`), { code: "ENOTFOUND" });
  });
});

test("Unix listing parser handles malformed long lines without blocking the process", () => {
  // Separate process bounds a regression's CPU time even if the parser blocks its event loop.
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { parseList } = require(process.argv[1]);
    const malformed = '-rw-r--r-- 1 ' + 'a '.repeat(32768) + '!';
    const files = parseList(malformed + '\\r\\n-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt\\r\\n');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'file.txt');
    assert.equal(files[0].size, 42);
  `, getUriRequire.resolve("basic-ftp/dist/parseList.js")], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
