// A small JSON Schema validator for tool inputs.
//
// Why write one: schema validation is a harness responsibility, and this repository shows
// each responsibility in the open. It covers the subset our tool schemas use (object,
// string, boolean, integer, number, array, enum, const, required, additionalProperties,
// string length). A production harness would use a full validator such as Ajv, or set
// `strict: true` on the tool so the API constrains the model's output to the schema.
//
// We leave `strict` off on purpose, so the model can make mistakes and the harness has
// something to catch.

import type { JsonSchema } from "../llm/model-api.ts";

export type ValidationError = { path: string; message: string };

export function validate(schema: JsonSchema, value: unknown, path = "input"): ValidationError[] {
  const errors: ValidationError[] = [];
  const fail = (message: string) => errors.push({ path, message });

  if (schema.const !== undefined && value !== schema.const) {
    fail(`must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    fail(`must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}; got ${JSON.stringify(value)}`);
    return errors;
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`must be an object; got ${typeName(value)}`);
        return errors;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "is required" });
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (sub) errors.push(...validate(sub, v, `${path}.${key}`));
        else if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${key}`, message: "is not an allowed property" });
        }
      }
      break;
    }
    case "string":
      if (typeof value !== "string") fail(`must be a string; got ${typeName(value)}`);
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength)
          fail(`must be at least ${schema.minLength} characters`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength)
          fail(`must be at most ${schema.maxLength} characters`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") fail(`must be a boolean; got ${typeName(value)}`);
      break;
    case "integer":
      if (!Number.isInteger(value)) fail(`must be an integer; got ${typeName(value)}`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`must be a number; got ${typeName(value)}`);
      break;
    case "array":
      if (!Array.isArray(value)) fail(`must be an array; got ${typeName(value)}`);
      else if (schema.items) {
        for (const [i, v] of value.entries()) errors.push(...validate(schema.items, v, `${path}[${i}]`));
      }
      break;
  }
  return errors;
}

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
