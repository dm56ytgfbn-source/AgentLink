// Exercises the actual Swift client against a local HTTPS fixture. Retains all fixtures.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import https from 'node:https';
import assert from 'node:assert/strict';

if (process.platform !== 'darwin') throw Error('Native client test requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'agentlink-native-retained-'));
const key = path.join(fixture, 'key.pem'), cert = path.join(fixture, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'ignore' });
let requests = 0;
const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
  let body = '';
  req.on('data', data => { body += data; });
  req.on('end', () => {
    const request = JSON.parse(body);
    requests++;
    assert.equal(req.headers.authorization, 'Bearer native-fixture-token');
    const response = { id: request.id, type: 'response', ok: true, result: [], error: null };
    if (requests === 2 || requests === 5) response.id = 'wrong-id';
    if (requests === 3) response.ok = false;
    res.writeHead(requests === 4 ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const source = (await readFile(path.join(root, 'native/AgentLinkWindowApp.swift'), 'utf8')).split('final class RemoteWindowView:')[0];
const swift = path.join(fixture, 'ClientCheck.swift');
const harness = `
let args = CommandLine.arguments
let device = AgentLinkDevice(name: "fixture", url: args[1], token: "native-fixture-token", ca: args[2], device_id: "fixture")
let client = try AgentLinkClient(device: device)
let expectTrustFailure = args.count > 3
var check = 0
func verifyNext() {
    check += 1
    if check == 5 {
        client.action("window.input", payload: ["id": "fixture", "kind": "text", "text": "test"]) { error in
            guard error != nil else { fputs("Mismatched action response was accepted\\n", stderr); exit(1) }
            print("Native HTTPS client: 5 checks passed")
            exit(0)
        }
        return
    }
    client.listWindows { result in
        switch result {
        case .success(let windows):
            guard !expectTrustFailure && check == 1 && windows.isEmpty else { fputs("Unexpected list response was accepted\\n", stderr); exit(1) }
        case .failure(let error):
            if expectTrustFailure {
                guard (error as NSError).domain == "AgentLinkTLS" else { fputs("TLS rejection lacked an actionable explanation\\n", stderr); exit(1) }
                print("Native HTTPS client: rejected certificate without serverAuth and explained the failure"); exit(0)
            }
            guard check != 1 else { fputs("Valid TLS fixture failed: \\(error.localizedDescription)\\n", stderr); exit(1) }
        }
        verifyNext()
    }
}
verifyNext()
RunLoop.main.run()
`;
await writeFile(swift, source + harness, { flag: 'wx' });
const binary = path.join(fixture, 'native-client-check');
try {
  execFileSync('swiftc', [swift, '-o', binary, '-framework', 'AppKit', '-framework', 'Security'], { stdio: 'inherit' });
  async function runClient(certificate, expectedFailure = false) {
    const args = [`https://127.0.0.1:${server.address().port}`, certificate];
    if (expectedFailure) args.push('expect-trust-failure');
    const child = spawn(binary, args, { stdio: 'inherit' });
    const deadline = setTimeout(() => child.kill('SIGTERM'), 30000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, 'Swift client integration must pass');
    } finally { clearTimeout(deadline); }
  }
  await runClient(cert);
  const oldKey = path.join(fixture, 'legacy-key.pem'), oldCert = path.join(fixture, 'legacy-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', oldKey, '-out', oldCert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  server.setSecureContext({ key: await readFile(oldKey), cert: await readFile(oldCert) });
  await runClient(oldCert, true);
  assert.equal(requests, 5);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
