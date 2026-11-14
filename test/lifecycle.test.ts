import { CreateBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('lifecycle', () => {
  it('is disposed at the end of an `await using` block', async () => {
    let escaped: AwsEmulator | undefined;
    {
      await using aws = new AwsEmulator({ telemetry: false });
      escaped = aws;
      expect(aws.closed).toBe(false);
    }
    expect(escaped.closed).toBe(true);
  });

  it('implements Symbol.asyncDispose via close()', async () => {
    const aws = new AwsEmulator({ telemetry: false });
    expect(typeof aws[Symbol.asyncDispose]).toBe('function');
    await aws[Symbol.asyncDispose]();
    expect(aws.closed).toBe(true);
  });

  it('close() is idempotent', async () => {
    const aws = new AwsEmulator({ telemetry: false });
    const first = aws.close();
    expect(aws.close()).toBe(first);
    await first;
    await expect(aws.close()).resolves.toBeUndefined();
  });

  it('rejects requests after close()', async () => {
    const aws = new AwsEmulator({ telemetry: false });
    const s3 = new S3Client(aws.clientConfig());
    await aws.close();

    await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/closed/);
    expect(() => aws.credentials).toThrow(/closed/);
    await expect(aws.listen()).rejects.toThrow(/closed/);
  });

  it('waits for in-flight requests before closing', async () => {
    const aws = new AwsEmulator({ telemetry: false });
    const s3 = new S3Client(aws.clientConfig());
    const pending = s3.send(new ListBucketsCommand({}));
    // Let the request reach the native layer before closing.
    await new Promise((resolve) => setImmediate(resolve));
    await aws.close();
    await expect(pending).resolves.toMatchObject({ $metadata: { httpStatusCode: 200 } });
  });

  it('gives every instance isolated state', async () => {
    await using a = new AwsEmulator({ telemetry: false });
    await using b = new AwsEmulator({ telemetry: false });
    const s3a = new S3Client({ ...a.clientConfig(), forcePathStyle: true });
    const s3b = new S3Client({ ...b.clientConfig(), forcePathStyle: true });

    await s3a.send(new CreateBucketCommand({ Bucket: 'only-in-a' }));

    const inA = await s3a.send(new ListBucketsCommand({}));
    const inB = await s3b.send(new ListBucketsCommand({}));
    expect(inA.Buckets?.map((bucket) => bucket.Name)).toEqual(['only-in-a']);
    expect(inB.Buckets ?? []).toEqual([]);
  });
});
