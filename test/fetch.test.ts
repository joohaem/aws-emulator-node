import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('fetch()', () => {
  it('sends raw HTTP requests to the emulator', async () => {
    await using aws = new AwsEmulator({ telemetry: false });
    const s3 = new S3Client({ ...aws.clientConfig(), forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: 'raw' }));
    await s3.send(new PutObjectCommand({ Bucket: 'raw', Key: 'k', Body: 'raw body' }));

    // Authentication is off, so an unsigned request carrying any SigV4 scope is routed.
    const response = await aws.fetch('https://s3.us-east-1.amazonaws.com/raw/k', {
      headers: {
        authorization:
          'AWS4-HMAC-SHA256 Credential=EMULATORPLACEHOLDER/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=00',
        'x-amz-date': '20260101T000000Z',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('raw body');
  });
});
