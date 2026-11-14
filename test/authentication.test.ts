import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('authentication', () => {
  it('hands out placeholder credentials when off', async () => {
    await using aws = new AwsEmulator({ telemetry: false });
    expect(aws.credentials.accessKeyId).toBe('EMULATORPLACEHOLDER');

    const s3 = new S3Client({
      ...aws.clientConfig(),
      credentials: { accessKeyId: 'anything', secretAccessKey: 'goes' },
    });
    await expect(s3.send(new ListBucketsCommand({}))).resolves.toBeDefined();
  });

  it('accepts its own credentials and rejects others when on', async () => {
    await using aws = new AwsEmulator({ authentication: true, telemetry: false });
    expect(aws.credentials.accessKeyId).not.toBe('EMULATORPLACEHOLDER');
    expect(aws.credentials.secretAccessKey).not.toHaveLength(0);

    const signed = new S3Client(aws.clientConfig());
    await expect(signed.send(new ListBucketsCommand({}))).resolves.toBeDefined();

    const forged = new S3Client({
      ...aws.clientConfig(),
      credentials: { accessKeyId: aws.credentials.accessKeyId, secretAccessKey: 'wrong' },
    });
    await expect(forged.send(new ListBucketsCommand({}))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });

  it('exposes the certificate authority PEM', async () => {
    await using aws = new AwsEmulator({ telemetry: false });
    expect(aws.certificateAuthorityPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
  });
});
