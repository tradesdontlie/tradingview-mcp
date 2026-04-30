import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { legacyToolSchemaToZodShape } from '../src/tool-schema.js';

describe('legacyToolSchemaToZodShape', () => {
  it('converts legacy string fields into zod schemas', () => {
    const shape = legacyToolSchemaToZodShape({
      timeframe: { type: 'string', description: 'Timeframe' },
    });

    assert.equal(shape.timeframe.safeParse('60').success, true);
    assert.equal(shape.timeframe.safeParse(60).success, false);
  });

  it('keeps existing zod schemas unchanged', () => {
    const schema = z.string().describe('Pine source');
    const shape = legacyToolSchemaToZodShape({ source: schema });

    assert.equal(shape.source, schema);
  });

  it('makes defaulted legacy fields optional', () => {
    const shape = legacyToolSchemaToZodShape({
      filename: { type: 'string', default: '' },
      options: { type: 'object', default: {} },
      items: { type: 'array', default: [] },
    });

    assert.deepEqual(shape.filename.parse(undefined), '');
    assert.deepEqual(shape.options.parse(undefined), {});
    assert.deepEqual(shape.items.parse(undefined), []);
  });

  it('converts legacy object fields into JSON-schema-compatible records', () => {
    const shape = legacyToolSchemaToZodShape({
      inputs: { type: 'object', description: 'Input overrides' },
    });

    assert.equal(shape.inputs.safeParse({ length: 20, source: 'close' }).success, true);
  });
});
