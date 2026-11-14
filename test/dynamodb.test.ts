import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { AwsEmulator } from '../lib/index.js';

describe('dynamodb', () => {
  it('creates a table, writes and queries items', async () => {
    await using aws = new AwsEmulator();
    const ddb = new DynamoDBClient(aws.clientConfig());

    await ddb.send(
      new CreateTableCommand({
        TableName: 'users',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    // Like AWS, a new table starts out CREATING.
    await waitUntilTableExists(
      { client: ddb, minDelay: 1, maxDelay: 1, maxWaitTime: 30 },
      { TableName: 'users' },
    );

    for (const sk of [1, 2, 3]) {
      await ddb.send(
        new PutItemCommand({
          TableName: 'users',
          Item: { pk: { S: 'user#1' }, sk: { N: String(sk) }, name: { S: `name-${sk}` } },
        }),
      );
    }

    const item = await ddb.send(
      new GetItemCommand({ TableName: 'users', Key: { pk: { S: 'user#1' }, sk: { N: '2' } } }),
    );
    expect(item.Item?.name).toEqual({ S: 'name-2' });

    const query = await ddb.send(
      new QueryCommand({
        TableName: 'users',
        KeyConditionExpression: 'pk = :pk AND sk >= :min',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':min': { N: '2' } },
      }),
    );
    expect(query.Items?.map((i) => i.sk?.N)).toEqual(['2', '3']);
  });
});
