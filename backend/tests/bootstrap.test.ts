import { describe, expect, it } from 'vitest';
import { bootstrapApplication } from '../src/bootstrap.js';
import { initializeModelIndexes } from '../src/database/indexes.js';

describe('application bootstrap', () => {
  it('connects and initializes indexes before creating the app', async () => {
    const order: string[] = [];
    const app = { name: 'test-app' };

    const result = await bootstrapApplication({
      connect: async () => {
        order.push('connect');
      },
      initializeIndexes: async () => {
        order.push('indexes');
      },
      createApp: () => {
        order.push('createApp');
        return app;
      },
    });

    expect(result).toBe(app);
    expect(order).toEqual(['connect', 'indexes', 'createApp']);
  });

  it('does not create the app when index initialization fails', async () => {
    let appCreated = false;

    await expect(
      bootstrapApplication({
        connect: async () => undefined,
        initializeIndexes: async () => {
          throw new Error('index build failed');
        },
        createApp: () => {
          appCreated = true;
          return {};
        },
      }),
    ).rejects.toThrow('index build failed');

    expect(appCreated).toBe(false);
  });

  it('waits for every model index to initialize', async () => {
    const initialized: string[] = [];

    await expect(
      initializeModelIndexes([
        {
          modelName: 'First',
          init: async () => {
            initialized.push('First');
          },
        },
        {
          modelName: 'Second',
          init: async () => {
            initialized.push('Second');
          },
        },
      ]),
    ).resolves.toBeUndefined();

    expect(initialized).toEqual(['First', 'Second']);
  });

  it('propagates an index initialization failure', async () => {
    await expect(
      initializeModelIndexes([
        {
          modelName: 'Working',
          init: async () => undefined,
        },
        {
          modelName: 'Broken',
          init: async () => {
            throw new Error('Broken index failed');
          },
        },
      ]),
    ).rejects.toThrow('Broken index failed');
  });
});
