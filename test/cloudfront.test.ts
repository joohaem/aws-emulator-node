import { Buffer } from 'node:buffer';
import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateFunctionCommand,
  CreateOriginAccessControlCommand,
  TestFunctionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('cloudfront', () => {
  it('s3 origin', async () => {
    await using aws = new AwsEmulator({ telemetry: false, closeTimeout: 5_000 });
    const s3 = new S3Client(aws.clientConfig());
    const cloudfront = new CloudFrontClient(aws.clientConfig());

    await s3.send(new CreateBucketCommand({ Bucket: 'cached-site-bucket' }));
    await s3.send(
      new PutObjectCommand({
        Bucket: 'cached-site-bucket',
        Key: 'index.html',
        Body: 'hello v1',
        ContentType: 'text/html',
      }),
    );

    const oac = await cloudfront.send(
      new CreateOriginAccessControlCommand({
        OriginAccessControlConfig: {
          Name: 'cached-site-oac',
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      }),
    );
    const { Distribution } = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: 'cached-site',
          Comment: 'S3 origin with the managed CachingOptimized policy',
          Enabled: true,
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: 'cached-site-origin',
                DomainName: 'cached-site-bucket.s3.us-east-1.amazonaws.com',
                S3OriginConfig: { OriginAccessIdentity: '' },
                OriginAccessControlId: oac.OriginAccessControl?.Id,
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: 'cached-site-origin',
            ViewerProtocolPolicy: 'allow-all',
            // Managed-CachingOptimized
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
          },
        },
      }),
    );
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: 'cached-site-bucket',
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: 'arn:aws:s3:::cached-site-bucket/*',
              Condition: { StringEquals: { 'AWS:SourceArn': Distribution?.ARN } },
            },
          ],
        }),
      }),
    );

    const miss = await aws.fetch(`https://${Distribution?.DomainName}/index.html`);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('x-cache')).toBe('Miss from cloudfront');
    expect(await miss.text()).toBe('hello v1');

    const hit = await aws.fetch(`https://${Distribution?.DomainName}/index.html`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-cache')).toBe('Hit from cloudfront');
    expect(await hit.text()).toBe('hello v1');

    // The origin changes, but the edge keeps answering from its cache until the TTL runs out.
    await s3.send(
      new PutObjectCommand({ Bucket: 'cached-site-bucket', Key: 'index.html', Body: 'hello v2' }),
    );
    const stale = await aws.fetch(`https://${Distribution?.DomainName}/index.html`);
    expect(stale.headers.get('x-cache')).toBe('Hit from cloudfront');
    expect(await stale.text()).toBe('hello v1');
  });

  it('cloudfront function (TestFunction)', async () => {
    await using aws = new AwsEmulator({ telemetry: false, closeTimeout: 5_000 });
    const cloudfront = new CloudFrontClient(aws.clientConfig());

    const { ETag } = await cloudfront.send(
      new CreateFunctionCommand({
        Name: 'version-router',
        FunctionConfig: {
          Comment: 'Prefix the URI with the x-version header, v1 by default',
          Runtime: 'cloudfront-js-2.0',
        },
        FunctionCode: Buffer.from(`function handler(event) {
  const request = event.request;
  const version = request.headers['x-version'] ? request.headers['x-version'].value : 'v1';
  request.uri = '/' + version + request.uri;
  return request;
}
`),
      }),
    );

    const v2 = await cloudfront.send(
      new TestFunctionCommand({
        Name: 'version-router',
        IfMatch: ETag,
        Stage: 'DEVELOPMENT',
        EventObject: Buffer.from(
          JSON.stringify({
            version: '1.0',
            context: { eventType: 'viewer-request' },
            viewer: { ip: '198.51.100.10' },
            request: {
              method: 'GET',
              uri: '/index.html',
              headers: { 'x-version': { value: 'v2' } },
              cookies: {},
              querystring: {},
            },
          }),
        ),
      }),
    );
    expect(v2.TestResult?.FunctionErrorMessage).toBeFalsy();
    expect(JSON.parse(v2.TestResult?.FunctionOutput ?? '{}').request.uri).toBe('/v2/index.html');

    const fallback = await cloudfront.send(
      new TestFunctionCommand({
        Name: 'version-router',
        IfMatch: ETag,
        Stage: 'DEVELOPMENT',
        EventObject: Buffer.from(
          JSON.stringify({
            version: '1.0',
            context: { eventType: 'viewer-request' },
            viewer: { ip: '198.51.100.10' },
            request: {
              method: 'GET',
              uri: '/index.html',
              headers: {},
              cookies: {},
              querystring: {},
            },
          }),
        ),
      }),
    );
    expect(fallback.TestResult?.FunctionErrorMessage).toBeFalsy();
    expect(JSON.parse(fallback.TestResult?.FunctionOutput ?? '{}').request.uri).toBe(
      '/v1/index.html',
    );
  });
});
