import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadNative } from './binding.js';
import { headersToRecord, readBody } from './http.js';
import type { NativeEmulator, NativeHeader, NativeRequest, NativeResponse } from './native.js';
import { AwsEmulatorRequestHandler } from './request-handler.js';

export interface AwsEmulatorOptions {
  /**
   * Require every request to be SigV4-signed with {@link AwsEmulator.credentials} (or
   * credentials the emulator's own IAM/STS operations created); anything else gets 403.
   * @default false
   */
  authentication?: boolean;
  /**
   * Upstream usage telemetry. It is process-wide: `false` from any emulator turns it off for
   * the whole process, as does `EMULATOR_TELEMETRY=off`.
   * @default true (the upstream default)
   */
  telemetry?: boolean;
  /**
   * The region {@link AwsEmulator.clientConfig} hands to SDK clients.
   * @default "us-east-1"
   */
  region?: string;
  /**
   * Default timeout in milliseconds for {@link AwsEmulator.close}, which `await using` /
   * `Symbol.asyncDispose` also uses.
   */
  closeTimeout?: number;
}

export interface AwsEmulatorCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface AwsEmulatorClientConfig {
  region: string;
  credentials: AwsEmulatorCredentials;
  requestHandler: AwsEmulatorRequestHandler;
}

export interface ListenOptions {
  /** @default 0 (an ephemeral port) */
  port?: number;
  /** @default "127.0.0.1" */
  host?: string;
}

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

const MAX_TIMER_MS = 2 ** 31 - 1;
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * An AWS Emulator running inside this Node.js process. Each instance owns fresh,
 * isolated in-memory state; every client wired to one instance shares it.
 *
 * ```ts
 * await using aws = new AwsEmulator();
 * const s3 = new S3Client(aws.clientConfig());
 * ```
 */
export class AwsEmulator implements AsyncDisposable {
  /** The region {@link clientConfig} uses. */
  readonly region: string;
  /** AWS SDK v3 `requestHandler` that routes requests into this emulator in-process. */
  readonly requestHandler: AwsEmulatorRequestHandler;

  readonly #native: NativeEmulator;
  readonly #closeTimeout: number | undefined;
  readonly #requests = new Map<Promise<unknown>, (reason: Error) => void>();
  readonly #servers = new Set<Server>();
  readonly #forced = Promise.withResolvers<void>();
  #closing: Promise<void> | undefined;

  constructor(options: AwsEmulatorOptions = {}) {
    this.region = options.region ?? 'us-east-1';
    this.#closeTimeout = validateTimeout(options.closeTimeout, 'closeTimeout');
    const { NativeEmulator } = loadNative();
    this.#native = new NativeEmulator({
      authentication: options.authentication ?? false,
      telemetry: options.telemetry ?? true,
    });
    this.requestHandler = new AwsEmulatorRequestHandler((request) => this.#dispatch(request));
  }

  get closed(): boolean {
    return this.#closing !== undefined;
  }

  /**
   * The access key pair to sign with. With authentication off these are placeholders
   * (any signature is accepted).
   */
  get credentials(): AwsEmulatorCredentials {
    this.#assertOpen();
    const { accessKeyId, secretAccessKey } = this.#native.credentials();
    return { accessKeyId, secretAccessKey };
  }

  /** PEM of the CA behind every TLS listener the emulator opens (e.g. for a signed URL). */
  get certificateAuthorityPem(): string {
    this.#assertOpen();
    return this.#native.certificateAuthorityPem();
  }

  /** `region`, `credentials` and `requestHandler` for an AWS SDK v3 client. */
  clientConfig(): AwsEmulatorClientConfig {
    return {
      region: this.region,
      credentials: this.credentials,
      requestHandler: this.requestHandler,
    };
  }

  /**
   * Send a raw HTTP request to the emulator, `fetch`-style. The URL is the AWS URL the
   * request is meant for (e.g. a presigned URL), not a local address.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const headers: NativeHeader[] = [];
    request.headers.forEach((value, name) => {
      headers.push({ name, value });
    });
    if (!request.headers.has('host')) {
      headers.push({ name: 'host', value: new URL(request.url).host });
    }

    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const native = await this.#dispatch({
      method: request.method,
      url: request.url,
      headers,
      ...(body !== undefined && { body }),
    });

    const responseHeaders = new Headers();
    for (const { name, value } of native.headers) responseHeaders.append(name, value);
    return new Response(NULL_BODY_STATUS.has(native.status) ? null : new Uint8Array(native.body), {
      status: native.status,
      headers: responseHeaders,
    });
  }

  /**
   * Also serve this emulator over plain HTTP on a local port, for clients that can only be
   * pointed at an endpoint URL (AWS CLI, other processes, ...). The server stops on
   * {@link close}.
   *
   * @returns the endpoint URL, e.g. `http://127.0.0.1:54321`
   */
  async listen(options: ListenOptions = {}): Promise<string> {
    this.#assertOpen();
    const host = options.host ?? '127.0.0.1';
    const server = createServer((req, res) => {
      this.#serve(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
        }
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    server.listen(options.port ?? 0, host);
    await once(server, 'listening');
    this.#servers.add(server);

    const { port } = server.address() as AddressInfo;
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  /**
   * Stop local listeners, wait for in-flight requests, and drop the emulator with all its
   * state. Once called, every new request is rejected.
   *
   * @param timeout milliseconds to wait before forcing the close (see
   *   {@link AwsEmulatorOptions.closeTimeout}, which it overrides). Calling `close()` again
   *   while a close is underway returns the same promise; a timeout passed then still arms,
   *   so `close(0)` can cut a graceful close short.
   */
  close(timeout: number | undefined = this.#closeTimeout): Promise<void> {
    const ms = validateTimeout(timeout, 'timeout');
    this.#closing ??= this.#shutdown();
    const closing = this.#closing;
    // Beyond setTimeout's 32-bit range a timer would fire at once; treat it as "no timeout".
    if (ms !== undefined && ms <= MAX_TIMER_MS) {
      const timer = setTimeout(() => this.#forceClose(), ms);
      closing.finally(() => clearTimeout(timer)).catch(() => {});
    }
    return closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #shutdown(): Promise<void> {
    const servers = [...this.#servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    );
    const drained = Promise.all([...servers, Promise.allSettled(this.#requests.keys())]);
    await Promise.race([drained, this.#forced.promise]);
    this.#servers.clear();
    this.#native.close();
  }

  #forceClose(): void {
    for (const server of this.#servers) {
      server.closeAllConnections();
    }
    const error = new Error('AwsEmulator was closed before the request completed (close timeout)');
    for (const reject of this.#requests.values()) {
      reject(error);
    }
    this.#forced.resolve();
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new Error('AwsEmulator is closed');
    }
  }

  #dispatch(request: NativeRequest): Promise<NativeResponse> {
    if (this.#closing) {
      return Promise.reject(new Error('AwsEmulator is closed'));
    }
    const { promise, resolve, reject } = Promise.withResolvers<NativeResponse>();
    this.#requests.set(promise, reject);
    this.#native.handle(request).then(resolve, reject);
    const forget = () => this.#requests.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: NativeHeader[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] as string;
      if (!HOP_BY_HOP.has(name.toLowerCase())) {
        headers.push({ name, value: req.rawHeaders[i + 1] as string });
      }
    }
    const body = await readBody(req);
    const native = await this.#dispatch({
      method: req.method ?? 'GET',
      url: `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`,
      headers,
      ...(body !== undefined && body.length > 0 && { body }),
    });

    const responseHeaders = headersToRecord(
      native.headers.filter(({ name }) => !HOP_BY_HOP.has(name.toLowerCase())),
    );
    if (!NULL_BODY_STATUS.has(native.status) && req.method !== 'HEAD') {
      responseHeaders['content-length'] = String(native.body.length);
    }
    res.writeHead(native.status, responseHeaders);
    res.end(req.method === 'HEAD' ? undefined : native.body);
  }
}

function validateTimeout(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number of milliseconds, got ${value}`);
  }
  return value;
}
