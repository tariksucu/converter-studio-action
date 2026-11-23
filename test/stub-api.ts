/**
 * A small stand-in for the Converter Studio API, for the tests: the same routes, answers and
 * error bodies as https://converter.studio/developers describes, with made-up "conversions".
 * What a file's conversion does depends on its bytes: FAIL fails it, PRICEY costs 50 credits,
 * PAGES makes a ZIP (a PDF's pages as pictures), anything else is done on the second status read.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const STUB_KEY = 'cvs_live_stub_key_for_tests';

const FORMATS = [
  {
    id: 'png',
    name: 'PNG',
    category: 'image',
    extensions: ['png'],
    to: ['jpg', 'webp', 'avif', 'pdf'],
  },
  {
    id: 'jpg',
    name: 'JPG',
    category: 'image',
    extensions: ['jpg', 'jpeg'],
    to: ['png', 'webp', 'avif', 'pdf'],
  },
  { id: 'webp', name: 'WebP', category: 'image', extensions: ['webp'], to: ['jpg', 'png'] },
  { id: 'avif', name: 'AVIF', category: 'image', extensions: ['avif'], to: ['jpg', 'png'] },
  {
    id: 'heic',
    name: 'HEIC',
    category: 'image',
    extensions: ['heic', 'heif'],
    to: ['jpg', 'webp', 'avif'],
  },
  {
    id: 'pdf',
    name: 'PDF',
    category: 'document',
    extensions: ['pdf'],
    to: ['pdf', 'png', 'jpg', 'txt', 'docx'],
  },
  { id: 'docx', name: 'Word', category: 'document', extensions: ['docx'], to: ['pdf', 'txt'] },
  { id: 'txt', name: 'Text', category: 'document', extensions: ['txt'], to: ['pdf', 'docx'] },
  { id: 'tgz', name: 'TAR.GZ', category: 'archive', extensions: ['tar.gz', 'tgz'], to: ['zip'] },
  { id: 'zip', name: 'ZIP', category: 'archive', extensions: ['zip'], to: ['tgz'] },
];

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

/** An answer the stub gives instead of the real one, `times` times. */
export interface Fault {
  readonly method: string;
  readonly path: RegExp;
  /**
   * An HTTP status; 'drop' to close the connection without an answer; 'lost' to do what was
   * asked and then close the connection without an answer.
   */
  readonly status: number | 'drop' | 'lost';
  times: number;
  readonly retryAfter?: string;
  readonly body?: unknown;
}

interface Upload {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly size: number;
  bytes: Buffer;
  ready: boolean;
}

interface Job {
  readonly id: string;
  readonly to: string;
  readonly from: string | null;
  readonly inputName: string;
  readonly input: Buffer;
  readonly maxCredits: number | null;
  status: string;
  reads: number;
  credits: number;
  output: Buffer | null;
  outputName: string | null;
  error: { code: string; message: string } | null;
}

export interface Stub {
  /** The base URL the action takes (`…/api`). */
  readonly base: string;
  readonly calls: Call[];
  readonly faults: Fault[];
  readonly jobs: Map<string, Job>;
  /** Called after the stub answered a part of an upload (to make it lose bytes, say). */
  readonly hooks: { afterPart?: (upload: Upload) => void };
  close(): Promise<void>;
}

const MESSAGES: Record<string, string> = {
  invalidApiKey: 'The API key is missing, wrong or deleted.',
  notFound: "Converter Studio couldn't find that.",
  invalidRequest: "Converter Studio didn't accept the request.",
  unsupportedConversion: "Converter Studio doesn't convert this file to that format.",
  fileTooLarge: 'The file is larger than the limit of your plan (10 MB).',
  idempotencyKeyReused: 'This Idempotency-Key was used for another request.',
  notEnoughCredits: "You don't have enough credits left.",
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const fail = (
  res: ServerResponse,
  status: number,
  code: string,
  params?: Record<string, unknown>,
) =>
  send(res, status, {
    error: { code, message: MESSAGES[code] ?? code, ...(params ? { params } : {}) },
  });

async function read(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const extension = (name: string) => /\.(tar\.gz|[^.]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
const stem = (name: string) => name.replace(/\.(tar\.gz|[^.]+)$/i, '') || 'converted';

export interface StubOptions {
  readonly partBytes?: number;
  readonly maxBytes?: number;
  /** Credits left on the account; a conversion that needs more fails with notEnoughCredits. */
  readonly credits?: number;
}

export async function startStub(options: StubOptions = {}): Promise<Stub> {
  const calls: Call[] = [];
  const faults: Fault[] = [];
  const uploads = new Map<string, Upload>();
  const jobs = new Map<string, Job>();
  const idempotency = new Map<string, { body: string; id: string }>();
  const hooks: Stub['hooks'] = {};
  let credits = options.credits ?? 1000;
  let base = '';

  const view = (job: Job) => {
    const done = job.status === 'done';
    return {
      id: job.id,
      status: job.status,
      from: job.from,
      to: job.to,
      inputName: job.inputName,
      inputSize: job.input.length,
      credits: job.credits,
      maxCredits: job.maxCredits,
      progress: done ? 1 : null,
      outputName: done ? job.outputName : null,
      outputSize: done ? (job.output?.length ?? null) : null,
      downloadUrl: done ? `${base}/jobs/${job.id}/download?token=dl_${job.id}` : null,
      expiresAt: done ? new Date(Date.now() + 6 * 3600_000).toISOString() : null,
      error: job.error,
      next: 'Check again in a few seconds.',
    };
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const path = url.pathname.replace(/^\/api/, '');
      const body = await read(req);
      const headers = {
        authorization: req.headers.authorization,
        client: req.headers['x-converter-studio-client'] as string | undefined,
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        uploadOffset: req.headers['upload-offset'] as string | undefined,
        contentLength: req.headers['content-length'],
      };
      let parsed: unknown;
      if (req.headers['content-type'] === 'application/json' && body.length)
        parsed = JSON.parse(body.toString());
      calls.push({ method: req.method ?? '', path, headers, body: parsed });

      const fault = faults.find((f) => f.times > 0 && f.method === req.method && f.path.test(path));
      if (fault?.status === 'lost') {
        fault.times--;
        res.writeHead = () => res;
        res.end = () => {
          req.socket.destroy();
          return res;
        };
      } else if (fault) {
        fault.times--;
        if (fault.status === 'drop') {
          req.socket.destroy();
          return;
        }
        send(
          res,
          fault.status,
          fault.body ?? {
            error: { code: 'serverBusy', message: 'Converter Studio is busy right now.' },
          },
          fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {},
        );
        return;
      }

      const authorized = req.headers.authorization === `Bearer ${STUB_KEY}`;
      if (req.method === 'GET' && path === '/v1/formats')
        return send(res, 200, { formats: FORMATS });

      if (req.method === 'GET' && path === '/v1/account') {
        if (!authorized) return fail(res, 401, 'invalidApiKey');
        return send(res, 200, { email: 'someone@example.com', plan: 'pro', credits });
      }

      if (req.method === 'POST' && path === '/v1/uploads') {
        if (!authorized) return fail(res, 401, 'invalidApiKey');
        const { fileName, size } = parsed as { fileName: string; size: number };
        if (size > (options.maxBytes ?? 10_000_000)) return fail(res, 413, 'fileTooLarge');
        const id = `up_${randomBytes(6).toString('hex')}`;
        const token = randomBytes(8).toString('hex');
        uploads.set(id, { id, token, name: fileName, size, bytes: Buffer.alloc(0), ready: false });
        return send(res, 201, {
          id,
          uploadUrl: `${base}/v1/uploads/${id}?token=${token}`,
          method: 'PUT',
          maxBytes: options.maxBytes ?? 10_000_000,
          partBytes: options.partBytes ?? 95 * 1024 * 1024,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }

      const put = /^\/v1\/uploads\/([^/]+)$/.exec(path);
      if (req.method === 'PUT' && put) {
        const upload = uploads.get(put[1]);
        if (!upload || upload.ready || url.searchParams.get('token') !== upload.token)
          return fail(res, 404, 'notFound');
        const offsetHeader = req.headers['upload-offset'];
        if (offsetHeader === undefined) {
          upload.bytes = body;
        } else {
          const offset = Number(offsetHeader);
          if (offset > upload.bytes.length)
            return fail(res, 409, 'invalidRequest', { received: upload.bytes.length });
          upload.bytes = Buffer.concat([upload.bytes.subarray(0, offset), body]);
          if (upload.bytes.length < upload.size) {
            send(res, 200, { id: upload.id, status: 'partial', received: upload.bytes.length });
            hooks.afterPart?.(upload);
            return;
          }
        }
        upload.ready = true;
        const format =
          FORMATS.find((f) => f.extensions.includes(extension(upload.name)))?.id ?? null;
        return send(res, 200, {
          id: upload.id,
          status: 'ready',
          file: { name: upload.name, size: upload.bytes.length, format },
        });
      }

      if (req.method === 'POST' && path === '/v1/conversions') {
        if (!authorized) return fail(res, 401, 'invalidApiKey');
        const request = parsed as {
          uploadId: string;
          to: string;
          options?: Record<string, unknown>;
          maxCredits?: number | null;
        };
        const key = req.headers['idempotency-key'] as string | undefined;
        const normalized = JSON.stringify([
          request.uploadId,
          request.to,
          request.options ?? {},
          request.maxCredits ?? 20,
        ]);
        if (key) {
          const seen = idempotency.get(key);
          if (seen && seen.body !== normalized) return fail(res, 409, 'idempotencyKeyReused');
          if (seen)
            return send(res, 200, view(jobs.get(seen.id)!), { 'Idempotent-Replayed': 'true' });
        }
        if (request.options && 'bogus' in request.options) return fail(res, 400, 'invalidRequest');
        const upload = uploads.get(request.uploadId);
        if (!upload || !upload.ready) return fail(res, 404, 'notFound');
        uploads.delete(upload.id);
        const from = FORMATS.find((f) => f.extensions.includes(extension(upload.name)));
        if (!FORMATS.some((f) => f.id === request.to)) return fail(res, 400, 'invalidRequest');
        if (from && !from.to.includes(request.to)) return fail(res, 422, 'unsupportedConversion');
        const text = upload.bytes.toString('latin1');
        const price = text.includes('PRICEY') ? 50 : 1;
        if (price > credits) return fail(res, 402, 'notEnoughCredits');
        const maxCredits = request.maxCredits === undefined ? 20 : request.maxCredits;
        const target = FORMATS.find((f) => f.id === request.to)!;
        const zipped = text.includes('PAGES') && target.category === 'image';
        const outExtension = zipped ? 'zip' : target.extensions[0];
        const sameFormat = from?.id === request.to;
        const job: Job = {
          id: upload.id,
          to: request.to,
          from: from?.id ?? null,
          inputName: upload.name,
          input: upload.bytes,
          maxCredits,
          status: maxCredits === null || price > maxCredits ? 'quoted' : 'processing',
          reads: 0,
          credits: price,
          output: null,
          outputName: `${stem(upload.name)}${sameFormat ? '-compressed' : ''}.${outExtension}`,
          error: null,
        };
        if (job.status === 'processing') credits -= price;
        jobs.set(job.id, job);
        if (key) idempotency.set(key, { body: normalized, id: job.id });
        return send(res, 201, view(job));
      }

      const get = /^\/v1\/conversions\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && get) {
        if (!authorized) return fail(res, 401, 'invalidApiKey');
        const job = jobs.get(get[1]);
        if (!job) return fail(res, 404, 'notFound');
        if (job.status === 'processing' && ++job.reads >= 2) {
          if (job.input.toString('latin1').includes('FAIL')) {
            job.status = 'failed';
            job.error = { code: 'conversionFailed', message: 'The file could not be converted.' };
          } else {
            job.status = 'done';
            job.output = Buffer.concat([Buffer.from(`converted to ${job.to}: `), job.input]);
          }
        }
        return send(res, 200, view(job));
      }

      const download = /^\/jobs\/([^/]+)\/download$/.exec(path);
      if (req.method === 'GET' && download) {
        const job = jobs.get(download[1]);
        if (!job || job.status !== 'done' || url.searchParams.get('token') !== `dl_${job.id}`) {
          return send(res, 410, { error: 'fileExpired' });
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(job.output!.length),
        });
        res.end(job.output);
        return;
      }

      fail(res, 404, 'notFound');
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    base,
    calls,
    faults,
    jobs,
    hooks,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
