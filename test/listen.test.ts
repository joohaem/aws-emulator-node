import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('listen()', () => {
  it('serves the emulator over a local HTTP endpoint until close()', async () => {
    const aws = new AwsEmulator({ telemetry: false });
    const endpoint = await aws.listen();
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const s3 = new S3Client({
      region: aws.region,
      credentials: aws.credentials,
      endpoint,
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'over-http' }));
    await s3.send(new PutObjectCommand({ Bucket: 'over-http', Key: 'k', Body: 'via socket' }));
    const object = await s3.send(new GetObjectCommand({ Bucket: 'over-http', Key: 'k' }));
    expect(await object.Body?.transformToString()).toBe('via socket');
    s3.destroy();

    await aws.close();
    await expect(fetch(endpoint)).rejects.toThrow();
  });
});
