import { Readable } from 'node:stream';
import { type BodyLike, escapeUri, headersToRecord, readBody } from './http.js';
import type { NativeRequest, NativeResponse } from './native.js';

/**
 * The subset of `@smithy/protocol-http`'s `HttpRequest` this handler reads. Declared
 * structurally so the library does not depend on any `@aws-sdk/*` / `@smithy/*` package.
 */
export interface SdkHttpRequest {
  method: string;
  protocol: string;
  hostname: string;
  port?: number | undefined;
  path: string;
  query?: Record<string, string | Array<string> | null> | undefined;
  headers: Record<string, string>;
  body?: unknown;
}

/** The subset of `@smithy/protocol-http`'s `HttpResponse` the SDK reads. */
export interface SdkHttpResponse {
  statusCode: number;
  reason?: string;
  headers: Record<string, string>;
  body: Readable;
}

export interface SdkHandlerOptions {
  abortSignal?: { aborted: boolean; reason?: unknown } | AbortSignal | undefined;
}

export type Dispatch = (request: NativeRequest) => Promise<NativeResponse>;

/**
 * An AWS SDK for JavaScript v3 `requestHandler` that serves every request from the
 * in-process emulator instead of the network.
 *
 * ```ts
 * new S3Client({ requestHandler: aws.requestHandler, ... })
 * ```
 */
export class AwsEmulatorRequestHandler {
  readonly metadata = { handlerProtocol: 'http/1.1' } as const;
  readonly #dispatch: Dispatch;

  constructor(dispatch: Dispatch) {
    this.#dispatch = dispatch;
  }

  async handle(
    request: SdkHttpRequest,
    options: SdkHandlerOptions = {},
  ): Promise<{ response: SdkHttpResponse }> {
    throwIfAborted(options.abortSignal);

    const headers = Object.entries(request.headers).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    if (!headers.some((h) => h.name.toLowerCase() === 'host')) {
      headers.push({ name: 'host', value: hostHeader(request) });
    }

    const body = await readBody(request.body as BodyLike);
    const native = await this.#dispatch({
      method: request.method,
      url: requestUrl(request),
      headers,
      ...(body !== undefined && { body }),
    });
    throwIfAborted(options.abortSignal);

    return {
      response: {
        statusCode: native.status,
        headers: headersToRecord(native.headers),
        body: Readable.from([native.body], { objectMode: false }),
      },
    };
  }

  updateHttpClientConfig(_key: never, _value: never): void {}

  httpHandlerConfigs(): Record<string, never> {
    return {};
  }

  destroy(): void {}
}

function throwIfAborted(signal: SdkHandlerOptions['abortSignal']): void {
  if (signal?.aborted) {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function hostHeader({ hostname, port }: SdkHttpRequest): string {
  return port ? `${hostname}:${port}` : hostname;
}

/** Rebuild the absolute URL the SDK would have connected to. */
export function requestUrl(request: SdkHttpRequest): string {
  const protocol = request.protocol.endsWith(':') ? request.protocol : `${request.protocol}:`;
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
  let url = `${protocol}//${hostHeader(request)}${path}`;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(request.query ?? {})) {
    const name = escapeUri(key);
    if (value === null) {
      parts.push(name);
    } else {
      for (const v of Array.isArray(value) ? value : [value]) parts.push(`${name}=${escapeUri(v)}`);
    }
  }
  if (parts.length > 0) url += `?${parts.join('&')}`;
  return url;
}
