import { describe, expect, it } from 'vitest';
import { DynamoRepo, NotImplementedError, SqliteRepo, createSqliteRepo } from './index.js';

describe('createSqliteRepo', () => {
  it("defaults to ':memory:' and works", async () => {
    const repo = createSqliteRepo();
    expect(repo).toBeInstanceOf(SqliteRepo);
    expect(await repo.listCases()).toEqual([]);
    expect(await repo.listJobs()).toEqual([]);
    repo.close();
  });
});

describe('DynamoRepo stub', () => {
  it('constructs but every method throws not implemented', async () => {
    const repo = new DynamoRepo({ region: 'ap-south-1' });
    expect(repo.table).toBe('standin');
    await expect(repo.listCases()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(repo.getJob('j')).rejects.toThrow(/not implemented/);
    expect(() => repo.close()).not.toThrow();
  });
});
