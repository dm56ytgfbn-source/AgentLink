import { generateKeyPairSync, randomBytes, sign as signPayload, X509Certificate } from 'node:crypto';

// A self-signed server certificate built with nothing but node:crypto. macOS ships openssl so
// the shell-out works there, but Windows does not, and "the computer that will BE USED" has to
// produce a working identity on a machine where nobody installed anything. X509Certificate can
// only parse, so the DER below is encoded by hand; every field written here is checked by the
// handshake test in tests/selfsigned.test.ts.

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value = Math.floor(value / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const setOf = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const nullValue = () => Buffer.from([0x05, 0x00]);
const booleanTrue = () => Buffer.from([0x01, 0x01, 0xff]);
const octetString = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), value]));
const utf8String = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
const contextPrimitive = (tag: number, value: Buffer) => tlv(0x80 | tag, value);
const contextConstructed = (tag: number, value: Buffer) => tlv(0xa0 | tag, value);

function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  let body = value.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [];
    let value = arc;
    do { stack.unshift(value & 0x7f); value = Math.floor(value / 128); } while (value > 0);
    for (let index = 0; index < stack.length - 1; index++) stack[index] |= 0x80;
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0');
  const text = pad(date.getUTCFullYear() % 100) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
    + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function distinguishedName(commonName: string): Buffer {
  return sequence(setOf(sequence(objectIdentifier('2.5.4.3'), utf8String(commonName))));
}

function ipv4Bytes(address: string): Buffer {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    throw new Error('只支持 IPv4 形式的地址: ' + address);
  return Buffer.from(parts);
}

function subjectAlternativeName(dnsNames: string[], ipAddresses: string[]): Buffer {
  return sequence(
    ...dnsNames.map(name => contextPrimitive(2, Buffer.from(name, 'ascii'))),
    ...ipAddresses.map(address => contextPrimitive(7, ipv4Bytes(address))),
  );
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), booleanTrue(), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

export interface SelfSignedOptions {
  commonName: string;
  dnsNames?: string[];
  ipAddresses?: string[];
  days?: number;
  /** Test seam: a fixed serial makes the encoded bytes reproducible. */
  serial?: Buffer;
}

export interface SelfSignedCertificate { cert: string; key: string; fingerprint256: string; subject: string; validTo: string }

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const PEM_WIDTH = 64;

function toPem(label: string, der: Buffer): string {
  const lines: string[] = [];
  const base64 = der.toString('base64');
  for (let index = 0; index < base64.length; index += PEM_WIDTH) lines.push(base64.slice(index, index + PEM_WIDTH));
  return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----\n';
}

export function generateSelfSignedCertificate(options: SelfSignedOptions): SelfSignedCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serial = options.serial ?? randomBytes(16);
  const days = options.days ?? 3650;
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  const algorithm = sequence(objectIdentifier(SHA256_WITH_RSA), nullValue());
  const name = distinguishedName(options.commonName);

  const extensions = contextConstructed(3, sequence(
    extension('2.5.29.19', true, sequence(booleanTrue())),
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x05, 0xa0]))),
    extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', false, subjectAlternativeName(options.dnsNames ?? [], options.ipAddresses ?? [])),
  ));

  const tbs = sequence(
    contextConstructed(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );

  const signature = signPayload('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, bitString(signature));
  const cert = toPem('CERTIFICATE', der);
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const parsed = new X509Certificate(cert);
  return { cert, key, fingerprint256: parsed.fingerprint256, subject: parsed.subject, validTo: parsed.validTo };
}
