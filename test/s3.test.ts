import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('s3', () => {
  it('create bucket', async () => {
    await using aws = new AwsEmulator({ region: 'ap-northeast-2' });
    const s3 = new S3Client(aws.clientConfig());

    await expect(
      s3.send(
        new CreateBucketCommand({
          Bucket: 'my-bucket',
          CreateBucketConfiguration: {
            LocationConstraint: 'ap-northeast-2',
          },
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      s3.send(
        new CreateBucketCommand({
          Bucket: 'my-bucket',
          CreateBucketConfiguration: {
            LocationConstraint: 'ap-northeast-2',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('put object', async () => {
    await using aws = new AwsEmulator();
    const s3 = new S3Client(aws.clientConfig());

    await s3.send(new CreateBucketCommand({ Bucket: 'my-bucket' }));
    await expect(
      s3.send(
        new PutObjectCommand({
          Bucket: 'my-bucket',
          Key: 'foo',
          Body: 'bar',
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('get object', async () => {
    await using aws = new AwsEmulator();
    const s3 = new S3Client(aws.clientConfig());

    await s3.send(new CreateBucketCommand({ Bucket: 'my-bucket' }));
    await s3.send(
      new PutObjectCommand({
        Bucket: 'my-bucket',
        Key: 'foo',
        Body: 'bar',
      }),
    );

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: 'my-bucket',
        Key: 'foo',
      }),
    );
    const resp = await obj.Body?.transformToString('utf8');
    expect(resp).toEqual('bar');

    await expect(
      s3.send(
        new GetObjectCommand({
          Bucket: 'my-bucket',
          Key: 'not_exists',
        }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        Code: 'NoSuchKey',
      }),
    );
  });
});
