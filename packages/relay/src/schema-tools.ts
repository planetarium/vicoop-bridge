// MCP-style GraphQL Tool Generator
// Introspects PostGraphile schema → generates query + mutation tools with proper selection sets
// Also generates SDL for system prompt injection

import { tool } from 'ai';
import { z } from 'zod';
import { executeGraphQL } from './graphql-client.js';

// ── Introspection types ──────────────────────────────────────────

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

interface IntrospectionArg {
  name: string;
  description: string | null;
  type: TypeRef;
}

interface IntrospectionField {
  name: string;
  description: string | null;
  args: IntrospectionArg[];
  type: TypeRef;
}

interface IntrospectionInputField {
  name: string;
  description: string | null;
  type: TypeRef;
}

interface IntrospectionEnumValue {
  name: string;
}

interface IntrospectionType {
  kind: string;
  name: string;
  fields: IntrospectionField[] | null;
  inputFields: IntrospectionInputField[] | null;
  enumValues: IntrospectionEnumValue[] | null;
}

interface TypeInfo {
  kind: string;
  name: string;
  fields?: { name: string; type: TypeRef }[];
  inputFields?: { name: string; description: string | null; type: TypeRef }[];
  enumValues?: string[];
}

// ── Full introspection query (query + mutation + all types) ──────

const TYPE_REF_FRAGMENT = `
  kind name ofType { kind name ofType { kind name ofType { kind name } } }
`;

const INTROSPECTION_QUERY = `{
  __schema {
    queryType {
      fields {
        name description
        args { name description type { ${TYPE_REF_FRAGMENT} } }
        type { ${TYPE_REF_FRAGMENT} }
      }
    }
    mutationType {
      fields {
        name description
        args { name description type { ${TYPE_REF_FRAGMENT} } }
        type { ${TYPE_REF_FRAGMENT} }
      }
    }
    types {
      kind name
      fields { name type { ${TYPE_REF_FRAGMENT} } }
      inputFields { name description type { ${TYPE_REF_FRAGMENT} } }
      enumValues { name }
    }
  }
}`;

// ── Type utilities ───────────────────────────────────────────────

function unwrapType(typeRef: TypeRef): {
  innerType: TypeRef;
  isNonNull: boolean;
  isList: boolean;
} {
  let isNonNull = false;
  let isList = false;
  let current = typeRef;

  if (current.kind === 'NON_NULL') {
    isNonNull = true;
    current = current.ofType!;
  }

  if (current.kind === 'LIST') {
    isList = true;
    current = current.ofType!;
    if (current.kind === 'NON_NULL') {
      current = current.ofType!;
    }
  }

  return { innerType: current, isNonNull, isList };
}

function resolveNamedType(typeRef: TypeRef): string {
  let current = typeRef;
  while (current.ofType) current = current.ofType;
  return current.name ?? 'Unknown';
}

function typeRefToString(typeRef: TypeRef): string {
  if (typeRef.kind === 'NON_NULL') {
    return `${typeRefToString(typeRef.ofType!)}!`;
  }
  if (typeRef.kind === 'LIST') {
    return `[${typeRefToString(typeRef.ofType!)}]`;
  }
  return typeRef.name ?? 'String';
}

// ── Type Registry ────────────────────────────────────────────────

function buildTypeRegistry(types: IntrospectionType[]): Map<string, TypeInfo> {
  const registry = new Map<string, TypeInfo>();

  for (const t of types) {
    // Skip internal types
    if (t.name.startsWith('__')) continue;

    const info: TypeInfo = { kind: t.kind, name: t.name };

    if (t.kind === 'OBJECT' && t.fields) {
      info.fields = t.fields.map((f) => ({ name: f.name, type: f.type }));
    }
    if (t.kind === 'INPUT_OBJECT' && t.inputFields) {
      info.inputFields = t.inputFields.map((f) => ({
        name: f.name,
        description: f.description,
        type: f.type,
      }));
    }
    if (t.kind === 'ENUM' && t.enumValues) {
      info.enumValues = t.enumValues.map((v) => v.name);
    }

    registry.set(t.name, info);
  }

  return registry;
}

// ── Built-in scalars (excluded from SDL) ─────────────────────────

const BUILTIN_SCALARS = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
]);

// ── Selection set builder ────────────────────────────────────────

const SCALAR_KINDS = new Set(['SCALAR', 'ENUM']);

function isScalarField(fieldType: TypeRef, typeMap: Map<string, TypeInfo>): boolean {
  const namedType = resolveNamedType(fieldType);
  const { innerType } = unwrapType(fieldType);
  if (SCALAR_KINDS.has(innerType.kind)) return true;
  const info = typeMap.get(namedType);
  return info ? SCALAR_KINDS.has(info.kind) : false;
}

// Returns scalar field names for an OBJECT type (no braces)
function getScalarFields(
  typeName: string,
  typeMap: Map<string, TypeInfo>,
): string[] {
  const info = typeMap.get(typeName);
  if (!info || info.kind !== 'OBJECT' || !info.fields) return [];
  return info.fields
    .filter((f) => !f.name.startsWith('__') && f.name !== 'nodeId' && isScalarField(f.type, typeMap))
    .map((f) => f.name);
}

export function buildSelectionSet(
  typeName: string,
  typeMap: Map<string, TypeInfo>,
): string {
  const info = typeMap.get(typeName);
  if (!info) return '';

  // Connection type: { nodes { ...scalarFields } totalCount }
  if (typeName.endsWith('Connection') && info.kind === 'OBJECT') {
    const nodesField = info.fields?.find((f) => f.name === 'nodes');
    if (nodesField) {
      const innerTypeName = resolveNamedType(nodesField.type);
      const fields = getScalarFields(innerTypeName, typeMap);
      if (fields.length > 0) {
        return `{ nodes { ${fields.join(' ')} } totalCount }`;
      }
      return '{ nodes { __typename } totalCount }';
    }
  }

  // Payload type (e.g. CreateNotePayload): find the inner entity field
  if (typeName.endsWith('Payload') && info.kind === 'OBJECT') {
    for (const field of info.fields ?? []) {
      if (field.name === 'clientMutationId' || field.name === 'query') continue;
      const fieldTypeName = resolveNamedType(field.type);
      const fieldInfo = typeMap.get(fieldTypeName);
      if (fieldInfo && fieldInfo.kind === 'OBJECT' && !fieldTypeName.endsWith('Connection')) {
        const fields = getScalarFields(fieldTypeName, typeMap);
        if (fields.length > 0) {
          return `{ ${field.name} { ${fields.join(' ')} } }`;
        }
      }
    }
    // Fallback
    return '{ clientMutationId }';
  }

  // Regular OBJECT type: select scalar fields, wrapped in { }
  if (info.kind === 'OBJECT' && info.fields) {
    const fields = getScalarFields(typeName, typeMap);
    return fields.length > 0 ? `{ ${fields.join(' ')} }` : '';
  }

  // SCALAR or ENUM — no selection set needed
  return '';
}

// ── Zod schema from GraphQL type ─────────────────────────────────

function graphqlTypeToZod(
  typeRef: TypeRef,
  typeMap: Map<string, TypeInfo>,
): z.ZodTypeAny {
  const { innerType, isNonNull, isList } = unwrapType(typeRef);

  let base: z.ZodTypeAny;

  if (innerType.kind === 'SCALAR') {
    switch (innerType.name) {
      case 'Int':
        base = z.number().int();
        break;
      case 'Float':
        base = z.number();
        break;
      case 'String':
        base = z.string();
        break;
      case 'Boolean':
        base = z.boolean();
        break;
      case 'ID':
        base = z.union([z.string(), z.number()]);
        break;
      case 'Datetime':
      case 'Cursor':
      case 'BigInt':
      case 'JSON':
        base = z.string().describe(`GraphQL ${innerType.name} as string`);
        break;
      default:
        base = z.string().describe(`GraphQL scalar ${innerType.name}`);
        break;
    }
  } else if (innerType.kind === 'ENUM') {
    const enumInfo = typeMap.get(innerType.name ?? '');
    if (enumInfo?.enumValues && enumInfo.enumValues.length > 0) {
      base = z.enum(enumInfo.enumValues as [string, ...string[]]);
    } else {
      base = z.string().describe(`Enum ${innerType.name}`);
    }
  } else if (innerType.kind === 'INPUT_OBJECT') {
    // Build a proper Zod object for INPUT_OBJECT types
    const inputInfo = typeMap.get(innerType.name ?? '');
    if (inputInfo?.inputFields) {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const field of inputInfo.inputFields) {
        shape[field.name] = graphqlTypeToZod(field.type, typeMap);
      }
      base = z.object(shape).describe(`Input type ${innerType.name}`);
    } else {
      base = z.record(z.unknown()).describe(`Input type ${innerType.name}`);
    }
  } else {
    base = z.string().describe(`GraphQL type ${innerType.kind} ${innerType.name ?? 'unknown'}`);
  }

  if (isList) {
    base = z.array(base);
  }

  if (!isNonNull) {
    base = base.optional();
  }

  return base;
}

// ── Skip rules ───────────────────────────────────────────────────

const SKIPPED_QUERY_FIELDS = new Set([
  '__schema', '__type', 'query', 'nodeId', 'node',
]);

function shouldSkipQuery(name: string): boolean {
  return SKIPPED_QUERY_FIELDS.has(name) || name.startsWith('__');
}

// Skip Relay nodeId-based mutations (keep ByField versions)
function shouldSkipMutation(name: string, allMutationNames: Set<string>): boolean {
  if (name.startsWith('__')) return true;

  // If there's a "ById" version of an update/delete, skip the non-ById version
  // e.g., skip "updateNote" if "updateNoteById" exists
  if ((name.startsWith('update') || name.startsWith('delete')) && !name.includes('By')) {
    const byIdVariant = `${name}ById`;
    if (allMutationNames.has(byIdVariant)) return true;
  }

  return false;
}

// Skip Relay nodeId-based singular queries if ByField versions exist
function shouldSkipRelayQuery(name: string, allQueryNames: Set<string>): boolean {
  // Check if this is a singular query (like "account", "note") that has a ByField version
  // PostGraphile generates both `note(nodeId)` and `noteById(id)`
  const byWalletAddress = `${name}ByWalletAddress`;
  const byId = `${name}ById`;

  if (allQueryNames.has(byId) || allQueryNames.has(byWalletAddress)) {
    return true;
  }

  return false;
}

// ── Mutation input flattening ────────────────────────────────────

interface FlattenedMutation {
  zodSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  reassemble: (flatArgs: Record<string, unknown>) => Record<string, unknown>;
  description: string;
}

function flattenMutationInput(
  mutationField: IntrospectionField,
  typeMap: Map<string, TypeInfo>,
): FlattenedMutation | null {
  // PostGraphile mutations take a single `input` argument
  const inputArg = mutationField.args.find((a) => a.name === 'input');
  if (!inputArg) return null;

  const inputTypeName = resolveNamedType(inputArg.type);
  const inputType = typeMap.get(inputTypeName);
  if (!inputType?.inputFields) return null;

  const name = mutationField.name;
  const shape: Record<string, z.ZodTypeAny> = {};
  const description = mutationField.description ?? `Mutation ${name}`;

  // Detect pattern: create, update, delete
  if (name.startsWith('create')) {
    // CreateXInput has { clientMutationId?, <entity>: <EntityInput>! }
    // Find the entity input field (not clientMutationId)
    const entityField = inputType.inputFields.find((f) => f.name !== 'clientMutationId');
    if (!entityField) return null;

    const entityInputTypeName = resolveNamedType(entityField.type);
    const entityInputType = typeMap.get(entityInputTypeName);
    if (!entityInputType?.inputFields) return null;

    // Expose entity input fields directly
    for (const field of entityInputType.inputFields) {
      let zodType = graphqlTypeToZod(field.type, typeMap);
      if (field.description) zodType = zodType.describe(field.description);
      shape[field.name] = zodType;
    }

    const entityFieldName = entityField.name;

    return {
      zodSchema: z.object(shape),
      reassemble: (flatArgs) => ({
        input: { [entityFieldName]: flatArgs },
      }),
      description,
    };
  }

  if (name.startsWith('update') && name.includes('By')) {
    // UpdateXByIdInput has { clientMutationId?, id!, <entity>Patch: <EntityPatch>! }
    const identifyingFields: IntrospectionInputField[] = [];
    let patchField: IntrospectionInputField | null = null;

    for (const field of inputType.inputFields) {
      if (field.name === 'clientMutationId') continue;
      if (field.name.endsWith('Patch')) {
        patchField = field;
      } else {
        identifyingFields.push(field);
      }
    }

    // Add identifying fields (e.g., id) as required params
    for (const field of identifyingFields) {
      let zodType = graphqlTypeToZod(field.type, typeMap);
      if (field.description) zodType = zodType.describe(field.description);
      shape[field.name] = zodType;
    }

    // Add patch fields as optional params
    if (patchField) {
      const patchTypeName = resolveNamedType(patchField.type);
      const patchType = typeMap.get(patchTypeName);
      if (patchType?.inputFields) {
        for (const field of patchType.inputFields) {
          let zodType = graphqlTypeToZod(field.type, typeMap);
          // Make all patch fields optional
          if (!zodType.isOptional()) {
            zodType = zodType.optional();
          }
          if (field.description) zodType = zodType.describe(field.description);
          shape[field.name] = zodType;
        }
      }

      const patchFieldName = patchField.name;
      const identifyingFieldNames = identifyingFields.map((f) => f.name);

      return {
        zodSchema: z.object(shape),
        reassemble: (flatArgs) => {
          const input: Record<string, unknown> = {};
          const patch: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(flatArgs)) {
            if (value === undefined) continue;
            if (identifyingFieldNames.includes(key)) {
              input[key] = value;
            } else {
              patch[key] = value;
            }
          }

          input[patchFieldName] = patch;
          return { input };
        },
        description,
      };
    }

    // No patch field — just expose all non-clientMutationId fields directly
    return {
      zodSchema: z.object(shape),
      reassemble: (flatArgs) => ({ input: flatArgs }),
      description,
    };
  }

  if (name.startsWith('delete') && name.includes('By')) {
    // DeleteXByIdInput has { clientMutationId?, id! }
    for (const field of inputType.inputFields) {
      if (field.name === 'clientMutationId') continue;
      let zodType = graphqlTypeToZod(field.type, typeMap);
      if (field.description) zodType = zodType.describe(field.description);
      shape[field.name] = zodType;
    }

    return {
      zodSchema: z.object(shape),
      reassemble: (flatArgs) => ({ input: flatArgs }),
      description,
    };
  }

  // Generic fallback: expose all input fields directly
  for (const field of inputType.inputFields) {
    if (field.name === 'clientMutationId') continue;
    let zodType = graphqlTypeToZod(field.type, typeMap);
    if (field.description) zodType = zodType.describe(field.description);
    shape[field.name] = zodType;
  }

  return {
    zodSchema: z.object(shape),
    reassemble: (flatArgs) => ({ input: flatArgs }),
    description,
  };
}

// ── SDL generation ───────────────────────────────────────────────

const SDL_EXCLUDED_PREFIXES = ['__'];
const SDL_EXCLUDED_TYPES = new Set([
  'Query', 'Mutation', 'Subscription',
  'PageInfo', 'Node', 'Boolean', 'String', 'Int', 'Float', 'ID',
]);

function shouldExcludeFromSDL(typeName: string): boolean {
  if (SDL_EXCLUDED_TYPES.has(typeName)) return true;
  if (BUILTIN_SCALARS.has(typeName)) return true;
  for (const prefix of SDL_EXCLUDED_PREFIXES) {
    if (typeName.startsWith(prefix)) return true;
  }
  // Exclude Edge, Connection, Payload types (covered by convention docs)
  if (typeName.endsWith('Edge')) return true;
  if (typeName.endsWith('Connection')) return true;
  if (typeName.endsWith('Payload')) return true;
  return false;
}

export function generateSDL(
  queryFields: IntrospectionField[],
  mutationFields: IntrospectionField[] | null,
  typeMap: Map<string, TypeInfo>,
): string {
  const lines: string[] = [];

  // Entity OBJECT types (e.g., Note, Account)
  for (const [name, info] of typeMap) {
    if (info.kind !== 'OBJECT') continue;
    if (shouldExcludeFromSDL(name)) continue;

    lines.push(`type ${name} {`);
    for (const field of info.fields ?? []) {
      if (field.name === 'nodeId') continue;
      lines.push(`  ${field.name}: ${typeRefToString(field.type)}`);
    }
    lines.push('}');
    lines.push('');
  }

  // Query type
  const queryEntries = queryFields.filter((f) => !shouldSkipQuery(f.name));
  if (queryEntries.length > 0) {
    lines.push('type Query {');
    for (const field of queryEntries) {
      const args = field.args
        .map((a) => `${a.name}: ${typeRefToString(a.type)}`)
        .join(', ');
      const argsStr = args ? `(${args})` : '';
      lines.push(`  ${field.name}${argsStr}: ${typeRefToString(field.type)}`);
    }
    lines.push('}');
    lines.push('');
  }

  // Mutation type
  if (mutationFields && mutationFields.length > 0) {
    const mutEntries = mutationFields.filter((f) => !f.name.startsWith('__'));
    if (mutEntries.length > 0) {
      lines.push('type Mutation {');
      for (const field of mutEntries) {
        const args = field.args
          .map((a) => `${a.name}: ${typeRefToString(a.type)}`)
          .join(', ');
        const argsStr = args ? `(${args})` : '';
        lines.push(`  ${field.name}${argsStr}: ${typeRefToString(field.type)}`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  // INPUT_OBJECT types
  for (const [name, info] of typeMap) {
    if (info.kind !== 'INPUT_OBJECT') continue;
    if (shouldExcludeFromSDL(name)) continue;

    lines.push(`input ${name} {`);
    for (const field of info.inputFields ?? []) {
      lines.push(`  ${field.name}: ${typeRefToString(field.type)}`);
    }
    lines.push('}');
    lines.push('');
  }

  // ENUM types
  for (const [name, info] of typeMap) {
    if (info.kind !== 'ENUM') continue;
    if (shouldExcludeFromSDL(name)) continue;
    if (BUILTIN_SCALARS.has(name)) continue;

    lines.push(`enum ${name} {`);
    for (const value of info.enumValues ?? []) {
      lines.push(`  ${value}`);
    }
    lines.push('}');
    lines.push('');
  }

  // Custom SCALARs
  for (const [name, info] of typeMap) {
    if (info.kind !== 'SCALAR') continue;
    if (BUILTIN_SCALARS.has(name)) continue;
    if (name.startsWith('__')) continue;
    lines.push(`scalar ${name}`);
  }

  return lines.join('\n').trim();
}

// ── Schema cache ─────────────────────────────────────────────────
// Cache the introspection result (schema structure) and tools for the
// lifetime of the process. Tools read the bearer token from
// AsyncLocalStorage at execution time, so they are user-independent.

interface CachedSchema {
  queryFields: IntrospectionField[];
  mutationFields: IntrospectionField[];
  allQueryNames: Set<string>;
  allMutationNames: Set<string>;
  typeMap: Map<string, TypeInfo>;
  sdl: string;
  // Pre-computed per-field metadata (everything except the execute closure)
  queryToolDefs: Array<{
    toolName: string;
    description: string;
    argsSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
    fieldName: string;
    fieldArgs: IntrospectionArg[];
    selectionSet: string;
  }>;
  mutationToolDefs: Array<{
    toolName: string;
    description: string;
    flattened: FlattenedMutation;
    mutationName: string;
    mutationArgs: IntrospectionArg[];
    selectionSet: string;
  }>;
}

let cachedSchema: CachedSchema | null = null;

export function invalidateToolCache(): void {
  cachedSchema = null;
  cachedTools = null;
}

async function getOrBuildSchema(): Promise<CachedSchema> {
  if (cachedSchema) return cachedSchema;

  // 1. Full introspection (only needs to run once — schema is the same for all users)
  const result = await executeGraphQL<{
    __schema: {
      queryType: { fields: IntrospectionField[] } | null;
      mutationType: { fields: IntrospectionField[] } | null;
      types: IntrospectionType[];
    };
  }>(INTROSPECTION_QUERY);

  if (result.errors) {
    throw new Error(`Introspection failed: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  const schema = result.data!.__schema;
  const queryFields = schema.queryType?.fields ?? [];
  const mutationFields = schema.mutationType?.fields ?? [];
  const allQueryNames = new Set(queryFields.map((f) => f.name));
  const allMutationNames = new Set(mutationFields.map((f) => f.name));

  // 2. Build type registry
  const typeMap = buildTypeRegistry(schema.types);

  // 3. Pre-compute query tool definitions
  const queryToolDefs: CachedSchema['queryToolDefs'] = [];
  for (const field of queryFields) {
    if (shouldSkipQuery(field.name)) continue;
    if (shouldSkipRelayQuery(field.name, allQueryNames)) continue;

    const returnTypeName = resolveNamedType(field.type);
    const selectionSet = buildSelectionSet(returnTypeName, typeMap);
    const returnTypeStr = typeRefToString(field.type);

    const description = field.description
      ? `${field.description} (returns ${returnTypeStr})`
      : `Query ${field.name} (returns ${returnTypeStr})`;

    const argsShape: Record<string, z.ZodTypeAny> = {};
    for (const arg of field.args) {
      let zodType = graphqlTypeToZod(arg.type, typeMap);
      if (arg.description) zodType = zodType.describe(arg.description);
      argsShape[arg.name] = zodType;
    }

    queryToolDefs.push({
      toolName: `query_${field.name}`,
      description,
      argsSchema: z.object(argsShape),
      fieldName: field.name,
      fieldArgs: field.args,
      selectionSet,
    });
  }

  // 4. Pre-compute mutation tool definitions
  const mutationToolDefs: CachedSchema['mutationToolDefs'] = [];
  for (const field of mutationFields) {
    if (shouldSkipMutation(field.name, allMutationNames)) continue;

    const returnTypeName = resolveNamedType(field.type);
    const selectionSet = buildSelectionSet(returnTypeName, typeMap);
    const returnTypeStr = typeRefToString(field.type);

    const flattened = flattenMutationInput(field, typeMap);
    if (!flattened) continue;

    const description = `${flattened.description} (returns ${returnTypeStr})`;

    mutationToolDefs.push({
      toolName: `mutate_${field.name}`,
      description,
      flattened,
      mutationName: field.name,
      mutationArgs: field.args,
      selectionSet,
    });
  }

  // 5. Generate SDL
  const sdl = generateSDL(queryFields, mutationFields, typeMap);

  cachedSchema = {
    queryFields, mutationFields, allQueryNames, allMutationNames,
    typeMap, sdl, queryToolDefs, mutationToolDefs,
  };
  return cachedSchema;
}

// ── Main: build tools + SDL ──────────────────────────────────────

// Cached tools + SDL, built once at first call.
// Tool execute functions read the bearer token from AsyncLocalStorage
// at execution time, so a single set of tools works for all users.
let cachedTools: { tools: Record<string, ReturnType<typeof tool>>; sdl: string } | null = null;

export async function getSchemaTools(): Promise<{
  tools: Record<string, ReturnType<typeof tool>>;
  sdl: string;
}> {
  if (cachedTools) return cachedTools;

  const schema = await getOrBuildSchema();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // ── Query tools ──
  for (const def of schema.queryToolDefs) {
    tools[def.toolName] = tool({
      description: def.description,
      inputSchema: def.argsSchema,
      execute: async (args) => {
        const usedArgs = def.fieldArgs.filter((a) => args[a.name] !== undefined);

        const varDefs = usedArgs
          .map((a) => `$${a.name}: ${typeRefToString(a.type)}`)
          .join(', ');

        const argsList = usedArgs
          .map((a) => `${a.name}: $${a.name}`)
          .join(', ');

        const selectionPart = def.selectionSet ? ` ${def.selectionSet}` : '';
        const argsPart = argsList ? `(${argsList})` : '';

        const fullQuery = varDefs
          ? `query Q(${varDefs}) { ${def.fieldName}${argsPart}${selectionPart} }`
          : `{ ${def.fieldName}${selectionPart} }`;

        const variables: Record<string, unknown> = {};
        for (const a of usedArgs) {
          variables[a.name] = args[a.name];
        }

        const queryResult = await executeGraphQL(
          fullQuery,
          Object.keys(variables).length > 0 ? variables : undefined,
        );

        if (queryResult.errors) {
          return { error: queryResult.errors.map((e) => e.message).join('; ') };
        }
        return queryResult.data;
      },
    });
  }

  // ── Mutation tools ──
  for (const def of schema.mutationToolDefs) {
    tools[def.toolName] = tool({
      description: def.description,
      inputSchema: def.flattened.zodSchema,
      execute: async (args) => {
        const reassembled = def.flattened.reassemble(args);

        const varDefs = def.mutationArgs
          .map((a) => `$${a.name}: ${typeRefToString(a.type)}`)
          .join(', ');

        const argsList = def.mutationArgs
          .map((a) => `${a.name}: $${a.name}`)
          .join(', ');

        const selectionPart = def.selectionSet ? ` ${def.selectionSet}` : '';

        const fullMutation = `mutation M(${varDefs}) { ${def.mutationName}(${argsList})${selectionPart} }`;

        const queryResult = await executeGraphQL(
          fullMutation,
          reassembled,
        );

        if (queryResult.errors) {
          return { error: queryResult.errors.map((e) => e.message).join('; ') };
        }
        return queryResult.data;
      },
    });
  }

  // ── Raw GraphQL escape hatch ──
  tools['execute_graphql'] = tool({
    description:
      'Execute an arbitrary GraphQL query or mutation against the PostGraphile API. ' +
      'Use this for complex queries the auto-generated tools cannot handle, ' +
      'or when you need custom field selections, nested relations, or multiple operations in one request. ' +
      'The full GraphQL schema is provided in the system prompt.',
    inputSchema: z.object({
      query: z.string().describe('The GraphQL query or mutation string'),
      variables: z
        .string()
        .optional()
        .describe('JSON string of variables for the query'),
    }),
    execute: async ({ query, variables }) => {
      let parsedVars: Record<string, unknown> | undefined;
      if (variables) {
        try {
          parsedVars = JSON.parse(variables);
        } catch {
          return { error: 'Invalid JSON in variables parameter' };
        }
      }

      const queryResult = await executeGraphQL(query, parsedVars);

      if (queryResult.errors) {
        return { error: queryResult.errors.map((e) => e.message).join('; ') };
      }
      return queryResult.data;
    },
  });

  cachedTools = { tools, sdl: schema.sdl };
  return cachedTools;
}
