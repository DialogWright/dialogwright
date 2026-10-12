import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { bucketBase, parseListing, S3Client, S3Error } from './client';
import { FakeS3 } from '../../testing/fakeS3';

const KEYS = { accessKeyId: 'AKIDEXAMPLETRACES', secretAccessKey: 'not-a-real-secret-key-for-the-fake-store' };
const fakes: FakeS3[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

async function store(pageSize?: number): Promise<{ fake: FakeS3; client: S3Client }> {
  const fake = await FakeS3.start({ bucket: 'traces-bucket', region: 'us-east-1', credentials: KEYS, ...(pageSize ? { pageSize } : {}) });
  fakes.push(fake);
  return { fake, client: new S3Client({ bucket: 'traces-bucket', endpoint: fake.endpoint, region: 'us-east-1', credentials: KEYS, forcePathStyle: true }) };
}

describe('the S3 client against an in-process store that checks every signature', () => {
  it('puts, gets, lists and deletes', async () => {
    const { fake, client } = await store();
    await client.put('calls/CA1/000001-000001-1.trace.jsonl', '{"a":1}\n');
    await client.put('calls/CA1/000002-000002-2.trace.jsonl', '{"a":2}\n');
    await client.put('calls/CA2/x.frames.jsonl', 'é\n');
    expect(await client.get('calls/CA1/000001-000001-1.trace.jsonl')).toBe('{"a":1}\n');
    expect(await client.get('calls/CA2/x.frames.jsonl')).toBe('é\n');
    expect(await client.get('calls/none')).toBeNull();
    const all = await client.list('calls/');
    expect(all.objects.map((o) => o.key)).toEqual(['calls/CA1/000001-000001-1.trace.jsonl', 'calls/CA1/000002-000002-2.trace.jsonl', 'calls/CA2/x.frames.jsonl']);
    expect(all.objects[2]!.size).toBe(3);
    expect((await client.list('calls/', { delimiter: '/' })).prefixes).toEqual(['calls/CA1/', 'calls/CA2/']);
    await client.delete('calls/CA2/x.frames.jsonl');
    expect([...fake.objects.keys()]).toHaveLength(2);
    // Every request was signed as the store checks it.
    expect(fake.requests.every((r) => r.status !== 403)).toBe(true);
  });

  it('reads a listing page by page', async () => {
    const { client } = await store(2);
    for (let i = 0; i < 5; i++) await client.put(`p/${i}.jsonl`, `${i}`);
    expect((await client.list('p/')).objects.map((o) => o.key)).toEqual(['p/0.jsonl', 'p/1.jsonl', 'p/2.jsonl', 'p/3.jsonl', 'p/4.jsonl']);
  });

  it('a wrong secret is refused, and the error names the store\'s code, never a key', async () => {
    const { fake } = await store();
    const wrong = new S3Client({ bucket: 'traces-bucket', endpoint: fake.endpoint, region: 'us-east-1', credentials: { ...KEYS, secretAccessKey: 'wrong-secret-value' }, forcePathStyle: true });
    const err = await wrong.put('k', 'v').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect((err as Error).message).toBe('S3 put k: 403 SignatureDoesNotMatch');
    expect((err as Error).message).not.toContain('wrong-secret-value');
    expect((err as Error).message).not.toContain(KEYS.accessKeyId);
  });

  it('a store that does not answer fails within the deadline', async () => {
    const { fake } = await store();
    fake.hang = true;
    const slow = new S3Client({ bucket: 'traces-bucket', endpoint: fake.endpoint, region: 'us-east-1', credentials: KEYS, forcePathStyle: true }, { timeoutMs: 200 });
    const began = Date.now();
    await expect(slow.get('k')).rejects.toThrow('S3 get k: no answer within 200 ms');
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('a listing past its page bound throws rather than answer with part of it', async () => {
    const { client } = await store(1);
    for (let i = 0; i < 3; i++) await client.put(`p/${i}.jsonl`, `${i}`);
    await expect(client.list('p/', { maxPages: 2 })).rejects.toThrow('S3 list p/: more than 2 pages');
    expect((await client.list('p/', { maxPages: 3 })).objects).toHaveLength(3);
  });

  it('an answer that stalls mid-body fails within the deadline as an S3Error; a store\'s odd error code is never said as it came', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'PUT') {
        res.writeHead(500, { 'content-type': 'application/xml' });
        res.end('<Error><Code>Evil<script>\nInjected</Code></Error>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      const t = setInterval(() => res.write('<Contents><Key>p/x</Key></Contents>'), 50);
      req.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const slow = new S3Client({ bucket: 'traces-bucket', endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', credentials: KEYS, forcePathStyle: true }, { timeoutMs: 300 });
      const err = await slow.get('p/x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(S3Error);
      expect((err as Error).message).toBe('S3 get p/x: no answer within 300 ms');
      await expect(slow.list('p/')).rejects.toThrow('S3 list p/: no answer within 300 ms');
      await expect(slow.put('p/y', 'v')).rejects.toThrow(/^S3 put p\/y: 500$/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('reaches a bucket by host by default, by path when asked', () => {
    expect(bucketBase({ bucket: 'b', region: 'eu-west-1', forcePathStyle: false })).toEqual({ origin: 'https://b.s3.eu-west-1.amazonaws.com', host: 'b.s3.eu-west-1.amazonaws.com', pathPrefix: '' });
    expect(bucketBase({ bucket: 'b', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true })).toEqual({ origin: 'http://127.0.0.1:9000', host: '127.0.0.1:9000', pathPrefix: '/b' });
  });

  it('reads a listing with entities and a next page', () => {
    const xml = '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken><Contents><Key>x&lt;1</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified><Size>4</Size></Contents></ListBucketResult>';
    expect(parseListing(xml)).toEqual({ objects: [{ key: 'x<1', lastModifiedMs: Date.parse('2026-10-11T00:00:00.000Z'), size: 4 }], prefixes: [], next: 'a&b' });
  });
});
