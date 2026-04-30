import { z } from 'zod';

function isZodSchema(value) {
  return value && typeof value === 'object' && typeof value.safeParse === 'function';
}

function legacyFieldToZod(field) {
  if (isZodSchema(field)) {
    return field;
  }

  const spec = field && typeof field === 'object' ? field : {};
  const type = spec.type || 'any';
  let schema;

  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    schema = z.enum(spec.enum.map(String));
  } else if (type === 'string') {
    schema = z.string();
  } else if (type === 'number') {
    schema = z.number();
  } else if (type === 'integer') {
    schema = z.number().int();
  } else if (type === 'boolean') {
    schema = z.boolean();
  } else if (type === 'array') {
    schema = z.array(z.any());
  } else if (type === 'object') {
    schema = z.record(z.string(), z.any());
  } else {
    schema = z.any();
  }

  if (spec.description) {
    schema = schema.describe(spec.description);
  }

  if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
    if (spec.default === null) {
      schema = schema.nullable();
    }
    schema = schema.optional().default(spec.default);
  }

  return schema;
}

export function legacyToolSchemaToZodShape(schema) {
  if (!schema || typeof schema !== 'object' || isZodSchema(schema)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).map(([name, field]) => [name, legacyFieldToZod(field)])
  );
}

export function installLegacyToolSchemaSupport(server) {
  const originalTool = server.tool.bind(server);

  server.tool = function patchedTool(name, description, inputSchema, callback) {
    if (typeof inputSchema === 'function') {
      return originalTool(name, description, inputSchema);
    }

    if (inputSchema && typeof inputSchema === 'object' && typeof callback === 'function') {
      return originalTool(name, description, legacyToolSchemaToZodShape(inputSchema), callback);
    }

    return originalTool(...arguments);
  };

  return server;
}
