import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { CLIENT_NAME } from './version.ts';

/** What the Converter Studio API sends back, as https://converter.studio/developers describes it. */

export type ConversionStatus =
  | 'fetching'
  | 'waiting_for_upload'
  | 'measuring'
  | 'quoted'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'expired'
  | 'canceled';

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly params?: Record<string, string | number>;
}

/** A conversion as `GET /v1/conversions/:id` describes it. Its id is also its upload's id. */
export interface ConversionView {
  readonly id: string;
  readonly status: ConversionStatus;
  readonly from: string | null;
  readonly to: string | null;
  readonly credits: number | null;
  readonly maxCredits: number | null;
  readonly outputName: string | null;
  readonly outputSize: number | null;
  /** Anyone with this link can download the result until it expires: never logged. */
  readonly downloadUrl: string | null;
  readonly error: ApiErrorBody | null;
  readonly next: string;
}

/** An upload slot from `POST /v1/uploads`. */
export interface UploadSlot {
  readonly id: string;
  /** Carries the upload's own token: never logged. */
  readonly uploadUrl: string;
  readonly maxBytes: number;
  /** One request carries at most this many bytes; larger files go in parts. */
  readonly partBytes: number;
}

/** The answer to one `PUT` of an upload. */
export type UploadReceipt =
  | { readonly status: 'partial'; readonly received: number }
  | {
      readonly status: 'ready';
      readonly file: {
        readonly name: string;
        readonly size: number;
        readonly format: string | null;
      };
    };

export interface FormatView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly extensions: readonly string[];
  /** What it converts to on the server right now. */
  readonly to: readonly string[];
}

/** What to do next, for the API's error codes (logged under the API's own message). */
const HINTS: Record<string, string> = {
  invalidApiKey:
    "Check the repository secret passed as 'api-key'. Keys are made on https://converter.studio/account#api-keys and start with cvs_live_.",
  notEnoughCredits:
    'Buy credits or choose a plan on https://converter.studio/pricing. Free accounts get new credits every day.',
  dailyLimit:
    'Free accounts get new credits every day; plans on https://converter.studio/pricing have more.',
  monthlyLimit: 'Buy a credit pack or choose a larger plan on https://converter.studio/pricing.',
  fileTooLarge:
    'Convert a smaller file, or choose a plan with a larger file limit on https://converter.studio/pricing.',
  durationTooLong:
    'Convert a shorter file, or choose a plan with a longer limit on https://converter.studio/pricing.',
  unsupportedConversion:
    "Choose another 'to' format. https://converter.studio/developers lists what each format converts to.",
  tooManyRequests:
    "Converter Studio takes up to 60 new files a minute for each API key. Lower 'concurrency', or convert fewer files in one step.",
  serverBusy: 'Try again in a few minutes.',
  invalidRequest:
    "Check the 'options' input: it may hold a setting name or value that Converter Studio doesn't know. https://converter.studio/developers lists them.",
  uploadFailed: 'Try again.',
  passwordNeeded: 'Add the archive\'s password to \'options\', as {"password": "…"}.',
  wrongPassword: "Check the archive's password in 'options'.",
  noPages: "Check 'pageRange' in 'options'.",
  noText: 'For a scanned PDF, add {"ocr": true} to \'options\'.',
  sizeTooSmall: "Raise 'maxSize' in 'options', or convert a shorter video.",
  tooManyPending:
    "Too many uploads are waiting to be converted. Lower 'concurrency' and try again.",
  tooManyUnconverted: 'Try again later.',
  archivePlanRequired: 'Converting what is inside an archive needs a Pro or Premium plan.',
  fileExpired: 'Results are kept for 6 hours. Run the workflow again.',
};

export function hintFor(code: string | undefined): string | undefined {
  return code ? HINTS[code] : undefined;
}

/** Messages for the codes the website's own routes send without one (the download link). */
const FALLBACK_MESSAGES: Record<string, string> = {
  fileExpired: 'The converted file has already been deleted',
  notFound: "Converter Studio couldn't find that conversion",
  tooManyRequests: 'Converter Studio received too many requests at once',
  serverBusy: 'Converter Studio is busy right now',
  invalidRequest: "Converter Studio didn't accept the request",
  invalidApiKey: "Converter Studio didn't accept the API key",
};

/** An answer of the API that is not a success, with its own message and code. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string | undefined;
  readonly params: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    code?: string,
    params?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = status;
    this.code = code;
    this.params = params;
  }

  get hint(): string | undefined {
    return hintFor(this.code);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The API's error from a body (`{ error: { code, message, params } }` or `{ error: "code" }`). */
export function errorOf(body: unknown): {
  code?: string;
  message?: string;
  params?: Record<string, unknown>;
} {
  if (!isObject(body)) return {};
  const error = body.error;
  if (typeof error === 'string') return { code: error };
  if (!isObject(error)) return {};
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    params: isObject(error.params) ? error.params : undefined,
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  const { code, message, params } = errorOf(await readBody(response));
  return new ApiError(
    message ??
      (code ? FALLBACK_MESSAGES[code] : undefined) ??
      `Converter Studio answered with HTTP status ${response.status}`,
    response.status,
    code,
    params,
  );
}

/** How the transport behaves; tests make it fast and observable. */
export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times a request is sent again (rate limit, busy server, lost connection). */
  readonly maxRetries?: number;
  /** Told before a request is sent again. Never given a URL or a header. */
  readonly onRetry?: (reason: string, waitMs: number) => void;
}

/** Whether a request may be sent again after a lost connection or a server error. */
type Retry = 'safe' | 'never';

interface Send {
  readonly url: string;
  readonly init: RequestInit;
  readonly retry: Retry;
  readonly timeoutMs: number;
  /** Adds the API key (not for upload and download links, which carry their own token). */
  readonly auth: boolean;
  /** Only a download follows a redirect; nothing that carries the key or a body does. */
  readonly follow?: boolean;
}

/** The longest pause before sending a request again. */
const MAX_RETRY_WAIT_MS = 60_000;
/** Statuses after which a request is sent again: the rate limit and a busy server always. */
const RETRY_ALWAYS = new Set([429, 503]);
/** Statuses after which only a request that changes nothing twice is sent again. */
const RETRY_SAFE = new Set([500, 502, 504]);
/** The longest a single status request waits on the server (the API allows 60 seconds). */
export const LONG_POLL_SECONDS = 50;

/** How long to pause before sending a request again: `Retry-After`, the rate limit's reset, or a back-off. */
export function retryDelay(response: Response | undefined, attempt: number): number {
  const backoff = Math.min(MAX_RETRY_WAIT_MS, 2000 * 2 ** attempt);
  if (!response) return backoff;
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  let ms: number | undefined;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  } else if (reset !== null && Number.isFinite(Number(reset))) {
    ms = Number(reset) * 1000;
  }
  if (ms === undefined || !Number.isFinite(ms)) return backoff;
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(1000, ms));
}

/** A conversion request, as `POST /v1/conversions` takes it. */
export interface ConversionRequest {
  readonly uploadId: string;
  readonly to: string;
  readonly options?: Record<string, unknown>;
  readonly maxCredits: number;
}

/** The Converter Studio REST API, with an account's API key. */
export class ConverterStudio {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #onRetry: ((reason: string, waitMs: number) => void) | undefined;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#maxRetries = options.maxRetries ?? 4;
    this.#onRetry = options.onRetry;
  }

  /**
   * Sends a request, again after a rate limit (429) or a busy server (503), and, when it changes
   * nothing twice, after a lost connection or a server error. Returns the last answer.
   */
  async #send(request: Send): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(request.init.headers);
      headers.set('X-Converter-Studio-Client', CLIENT_NAME);
      if (request.auth) headers.set('Authorization', `Bearer ${this.#apiKey}`);
      let response: Response;
      try {
        response = await this.#fetch(request.url, {
          ...request.init,
          headers,
          redirect: request.follow ? 'follow' : 'error',
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        if (request.retry === 'safe' && attempt < this.#maxRetries) {
          const wait = retryDelay(undefined, attempt);
          this.#onRetry?.(`no answer (${describe(error)})`, wait);
          await this.#sleep(wait);
          continue;
        }
        throw new ApiError(
          `Converter Studio could not be reached (${describe(error)})`,
          0,
          'unreachable',
          undefined,
          { cause: error },
        );
      }
      const again =
        RETRY_ALWAYS.has(response.status) ||
        (request.retry === 'safe' && RETRY_SAFE.has(response.status));
      if (!again || attempt >= this.#maxRetries) return response;
      const wait = retryDelay(response, attempt);
      await response.body?.cancel().catch(() => undefined);
      this.#onRetry?.(`HTTP status ${response.status}`, wait);
      await this.#sleep(wait);
    }
  }

  async #json<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; timeoutMs?: number; retry?: Retry } = {},
  ): Promise<{ data: T; response: Response }> {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.#send({
      url: `${this.#baseUrl}/v1${path}`,
      init: { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      retry: options.retry ?? 'safe',
      timeoutMs: options.timeoutMs ?? 60_000,
      auth: true,
    });
    if (!response.ok) throw await errorFrom(response);
    return { data: (await readBody(response)) as T, response };
  }

  /** The formats and what each converts to (no key needed, but it is sent). */
  async formats(): Promise<FormatView[]> {
    const { data } = await this.#json<{ formats: FormatView[] }>('GET', '/formats');
    return Array.isArray(data.formats) ? data.formats : [];
  }

  /** Checks the API key (the answer is not logged: it holds the account's e-mail address). */
  async checkKey(): Promise<void> {
    await this.#json<unknown>('GET', '/account');
  }

  /** Opens an upload slot; the API checks the plan's file size limit first. */
  async createUpload(fileName: string, size: number): Promise<UploadSlot> {
    const { data } = await this.#json<UploadSlot>('POST', '/uploads', { fileName, size });
    return data;
  }

  /**
   * Sends one request of an upload to its upload URL (which carries its own token). A part sent
   * again overwrites what arrived of it before. `undefined`: the answer to a request sent again
   * was "not found", which is what the API says once an upload is complete, so the first try may
   * have finished it (the conversion request finds out).
   */
  async sendPart(
    slot: UploadSlot,
    bytes: Blob,
    offset: number | null,
  ): Promise<UploadReceipt | { status: 'gap'; received: number } | undefined> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (offset !== null) headers['Upload-Offset'] = String(offset);
    let sentBefore = false;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#send({
          url: slot.uploadUrl,
          init: { method: 'PUT', headers, body: bytes },
          retry: 'never',
          // Two minutes, plus two seconds a megabyte.
          timeoutMs: 120_000 + Math.ceil(bytes.size / 1_000_000) * 2000,
          auth: false,
        });
      } catch (error) {
        if (attempt < this.#maxRetries) {
          sentBefore = true;
          const wait = retryDelay(undefined, attempt);
          this.#onRetry?.(`upload interrupted (${describe(error)})`, wait);
          await this.#sleep(wait);
          continue;
        }
        throw error;
      }
      if (response.ok) return (await readBody(response)) as UploadReceipt;
      if (response.status === 409 && offset !== null) {
        const received = Number(errorOf(await readBody(response)).params?.received);
        if (Number.isSafeInteger(received) && received >= 0) return { status: 'gap', received };
        throw new ApiError('The upload of the file did not finish', 409, 'uploadFailed');
      }
      if (response.status === 404 && sentBefore) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (response.status >= 500 && attempt < this.#maxRetries) {
        sentBefore = true;
        const wait = retryDelay(response, attempt);
        await response.body?.cancel().catch(() => undefined);
        this.#onRetry?.(`HTTP status ${response.status} during the upload`, wait);
        await this.#sleep(wait);
        continue;
      }
      throw await errorFrom(response);
    }
  }

  /**
   * Starts a conversion. The Idempotency-Key makes sending it again safe: the API answers with
   * the conversion the first request made (HTTP 200) instead of making a second one.
   */
  async createConversion(
    request: ConversionRequest,
    idempotencyKey: string,
  ): Promise<ConversionView> {
    const body: Record<string, unknown> = {
      uploadId: request.uploadId,
      to: request.to,
      maxCredits: request.maxCredits,
    };
    if (request.options && Object.keys(request.options).length > 0) body.options = request.options;
    const { data } = await this.#json<ConversionView>('POST', '/conversions', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    return data;
  }

  /** A conversion's status; with `waitSeconds`, the server answers as soon as it changes. */
  async getConversion(id: string, waitSeconds = 0): Promise<ConversionView> {
    const query = waitSeconds > 0 ? `?wait=${waitSeconds}` : '';
    const { data } = await this.#json<ConversionView>(
      'GET',
      `/conversions/${encodeURIComponent(id)}${query}`,
      undefined,
      { timeoutMs: (waitSeconds + 30) * 1000 },
    );
    return data;
  }

  /**
   * Downloads a result to `path` (the link carries its own token, so no key goes with it). The
   * file is written whole or not at all: a failed download leaves nothing at `path`.
   */
  async download(url: string, path: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#send({
        url,
        init: { method: 'GET' },
        retry: 'safe',
        timeoutMs: 30 * 60_000,
        auth: false,
        follow: true,
      });
      if (!response.ok) throw await errorFrom(response);
      if (!response.body)
        throw new ApiError('The download of the result was empty', 0, 'downloadFailed');
      let bytes = 0;
      try {
        const counted = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
        counted.on('data', (chunk: Buffer) => (bytes += chunk.length));
        await pipeline(counted, createWriteStream(path, { flags: 'w' }));
        return bytes;
      } catch (error) {
        await rm(path, { force: true });
        if (attempt < this.#maxRetries) {
          const wait = retryDelay(undefined, attempt);
          this.#onRetry?.(`download interrupted (${describe(error)})`, wait);
          await this.#sleep(wait);
          continue;
        }
        throw new ApiError(
          `The download of the result was interrupted (${describe(error)})`,
          0,
          'downloadFailed',
          undefined,
          { cause: error },
        );
      }
    }
  }
}

/** A short reason for a failed request, without any address (upload and download links carry tokens). */
export function describe(error: unknown): string {
  let text = String(error);
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
    text = error.name === 'TimeoutError' ? 'timed out' : code || error.message;
  }
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>')
    .replace(/token=\S+/gi, 'token=…');
}
