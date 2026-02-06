/**
 * @file schemas.ts
 * @description Defines the runtime validation schemas for LLM tools using a recursive type system.
 * This maps TypeScript interfaces to JSON Schemas understood by Gemini.
 *
 * @external-interactions
 * - Used by `llm-manager.ts` to generate tool definitions for the AI model.
 * - Used by `verifier.ts` (optionally) for runtime checks.
 *
 * @pitfalls
 * - `MappedFieldSchema` is complex and recursive. Debugging type errors here can be tricky.
 */
import { FunctionDeclaration, SchemaType } from '@google/generative-ai';

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'any_value';

export interface FieldSchema {
  type: FieldType;
  description: string;
  required?: boolean;
  enum?: string[];
  items?: FieldSchema; // For arrays
  properties?: Record<string, FieldSchema>; // For objects
}

export interface EntitySchema {
  name: string;
  description: string;
  fields: Record<string, FieldSchema>;
}

// Define ValidFieldKeys to include common fields and exclude internal ones if needed
export type ValidFieldKeys<T> = Exclude<keyof T, 'created_at' | 'updated_at'>;

type MappedFieldSchema<T> = {
  description: string;
  required?: boolean;
  enum?: string[];
} & (
    NonNullable<T> extends string ? { type: 'string' } :
    NonNullable<T> extends number ? { type: 'number' } :
    NonNullable<T> extends boolean ? { type: 'boolean' } :
    NonNullable<T> extends Array<infer U> ? { type: 'array'; items: MappedFieldSchema<U> } :
    NonNullable<T> extends object ? { type: 'object'; properties: { [K in keyof NonNullable<T>]: MappedFieldSchema<NonNullable<T>[K]> } } :
    { type: FieldType } // Fallback
  );

export function defineSchema<T>(schema: Omit<EntitySchema, 'fields'> & { fields: { [K in ValidFieldKeys<T>]: MappedFieldSchema<T[K]> } }): EntitySchema {
  return schema as unknown as EntitySchema;
}

export function generateReplaceTool(schema: EntitySchema): FunctionDeclaration {
  return {
    name: `replace${schema.name}`,
    description: `Replace the entire ${schema.name}. ${schema.description}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: toJsonSchemaProperties(schema.fields),
      required: Object.entries(schema.fields)
        .filter(([_, f]) => f.required)
        .map(([k]) => k),
    }
  };
}

export function generatePatchTool(schema: EntitySchema): FunctionDeclaration {
  return {
    name: `patch${schema.name}`,
    description: `Patch the ${schema.name}. Use JSON Patch format.`,
    parameters: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          op: { type: SchemaType.STRING, enum: ["add", "remove", "replace", "move", "copy", "test"], format: "enum" as any },
          path: { type: SchemaType.STRING, description: "JSON Pointer path (e.g. /label/medium)" },
          value: { type: SchemaType.STRING, description: "Value to set (can be JSON object)" }
        },
        required: ["op", "path", "value"]
      }
    }
  };
}

function toJsonSchemaProperties(fields: Record<string, FieldSchema>): any {
  const props: any = {};
  for (const [key, field] of Object.entries(fields)) {
    props[key] = {
      type: mapFieldType(field.type),
      description: field.description
    };
    if (field.enum) props[key].enum = field.enum;
    if (field.items) {
      props[key].items = toJsonSchemaProperties({ item: field.items }).item;
      if (field.items.properties) {
        props[key].items.required = Object.entries(field.items.properties)
          .filter(([_, f]) => f.required)
          .map(([k]) => k);
      }
    }
    if (field.properties) {
      props[key].properties = toJsonSchemaProperties(field.properties);
      props[key].required = Object.entries(field.properties)
        .filter(([_, f]) => f.required)
        .map(([k]) => k);
    }
  }
  return props;
}

function mapFieldType(type: FieldType): SchemaType {
  switch (type) {
    case 'string': return SchemaType.STRING;
    case 'number': return SchemaType.NUMBER;
    case 'boolean': return SchemaType.BOOLEAN;
    case 'array': return SchemaType.ARRAY;
    case 'object': return SchemaType.OBJECT;
    default: return SchemaType.STRING;
  }
}
