import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import type { NativeHeader } from './native.js';

/** A request body in any shape the AWS SDK (or a caller) may hand over. */
export type BodyLike =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Readable
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>
  | null
  | undefined;

/** Read a whole request body into one Buffer. */
export async function readBody(body: BodyLike): Promise<Buffer | undefined> {
  if (body == null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ReadableStream) return collect(Readable.fromWeb(body as never));
  if (Symbol.asyncIterator in body) return collect(body);
  throw new TypeError(`Unsupported request body type: ${Object.prototype.toString.call(body)}`);
}

async function collect(iterable: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of iterable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Fold response headers into a record; repeated names are joined with `, ` (RFC 9110 §5.3). */
export function headersToRecord(headers: readonly NativeHeader[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    const existing = record[key];
    record[key] = existing === undefined ? value : `${existing}, ${value}`;
  }
  return record;
}

/** RFC 3986 percent-encoding, the same the SDK's signer canonicalizes with. */
export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
