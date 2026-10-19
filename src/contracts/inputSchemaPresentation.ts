import { isDeepStrictEqual } from "node:util";

import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const literalSchemaType = (value: unknown): string | undefined => {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
};

const resolvePointer = (
  root: Readonly<Record<string, unknown>>,
  tokens: readonly string[],
): unknown => {
  let value: unknown = root;
  for (const token of tokens) {
    // A pointer can cross a resource boundary; preserve the original
    // projection rather than guess the reference scope beyond it.
    if (value !== root && isObject(value) && "$id" in value) return undefined;
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (index >= value.length) return undefined;
      value = value[index];
      continue;
    }
    if (!isObject(value) || !Object.hasOwn(value, token)) return undefined;
    value = value[token];
  }
  return value;
};

const findSchemaAnchor = (
  root: Readonly<Record<string, unknown>>,
  name: string,
): readonly string[] | undefined => {
  const scan = (
    node: unknown,
    path: readonly string[],
  ): readonly string[] | undefined => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = scan(node[index], [...path, String(index)]);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isObject(node)) return undefined;
    // Draft 2020-12: a plain-name fragment matches $anchor or $dynamicAnchor.
    if (node.$anchor === name || node.$dynamicAnchor === name) return path;
    for (const [key, child] of Object.entries(node)) {
      if (
        !schemaMaps.has(key) &&
        !schemaArrays.has(key) &&
        !schemaChildren.has(key)
      )
        continue;
      // Anchors inside a nested resource belong to that resource.
      if (isObject(child) && "$id" in child) continue;
      if (schemaMaps.has(key) && isObject(child)) {
        for (const [childName, grandChild] of Object.entries(child)) {
          const found = scan(grandChild, [...path, key, childName]);
          if (found !== undefined) return found;
        }
      } else if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const found = scan(child[index], [...path, key, String(index)]);
          if (found !== undefined) return found;
        }
      } else {
        const found = scan(child, [...path, key]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return scan(root, []);
};

/** Resolve a same-resource reference: `#`, pointer fragments, and anchors. */
export const resolveLocalSchemaReference = (
  root: Readonly<Record<string, unknown>>,
  reference: string,
): { readonly value: unknown; readonly tokens: readonly string[] } | undefined => {
  if (!reference.startsWith("#")) return undefined;
  // RFC 6901: percent-decode the whole fragment before splitting tokens, so
  // an encoded separator such as %2F still addresses a nested position.
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (fragment === "") return { value: root, tokens: [] };
  if (!fragment.startsWith("/")) {
    // Draft 2020-12 plain-name fragments resolve to the matching $anchor.
    const anchorPath = findSchemaAnchor(root, fragment);
    if (anchorPath === undefined) return undefined;
    const value = resolvePointer(root, anchorPath);
    return value === undefined
      ? undefined
      : { value, tokens: anchorPath };
  }
  const tokens = fragment
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const value = resolvePointer(root, tokens);
  return value === undefined ? undefined : { value, tokens };
};

const referencedDescription = (
  root: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
): string | undefined => {
  let value: unknown = schema;
  const active = new Set<string>();
  while (isObject(value)) {
    if (typeof value.description === "string") return value.description;
    if (typeof value.$ref !== "string" || active.has(value.$ref))
      return undefined;
    active.add(value.$ref);
    value = resolveLocalSchemaReference(root, value.$ref)?.value;
  }
  return undefined;
};

const describeSchema = (
  schema: unknown,
  root: Readonly<Record<string, unknown>>,
  describeProperty: (property: string) => string | undefined,
): unknown => {
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isObject(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              const described = describeSchema(child, root, describeProperty);
              if (key !== "properties" || !isObject(described))
                return [name, described];
              const description =
                referencedDescription(root, described) ??
                describeProperty(name);
              return [
                name,
                description === undefined
                  ? described
                  : { ...described, description },
              ];
            }),
          ),
        ];
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) => describeSchema(child, root, describeProperty)),
        ];
      if (schemaChildren.has(key))
        return [
          key,
          Array.isArray(value)
            ? value.map((child) =>
                describeSchema(child, root, describeProperty),
              )
            : describeSchema(value, root, describeProperty),
        ];
      // Annotation values and literal const/enum data are not schemas.
      return [key, value];
    }),
  );
};

const objectBranch = (
  root: Readonly<Record<string, unknown>>,
  branch: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  // Reference siblings evaluate separately from the target in 2020-12, so a
  // merged object could accept inputs the branch rejects.
  const resolved =
    isObject(branch) && typeof branch.$ref === "string"
      ? Object.keys(branch).length === 1
        ? resolveLocalSchemaReference(root, branch.$ref)?.value
        : undefined
      : branch;
  return isObject(resolved) &&
    resolved.type === "object" &&
    isObject(resolved.properties)
    ? resolved
    : undefined;
};

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const sharedRequiredProperties = (
  branches: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const [first = [], ...others] = branches.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const inputGroup = (branch: Readonly<Record<string, unknown>>): string => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  return [...required, ...optional].join(" + ");
};

type SchemaNormalization = {
  readonly schema: unknown;
  readonly changed: boolean;
};

const isBooleanLiteralSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (typeof schema.const === "boolean" ||
    (Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((value) => typeof value === "boolean")));

const isBooleanSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (schema.type === "boolean" || isBooleanLiteralSchema(schema));

const preserveSharedDefault = (
  schema: Record<string, unknown>,
  branches: readonly unknown[],
): void => {
  if (schema.default !== undefined) return;
  const defaults = branches
    .filter(isObject)
    .map((branch) => branch.default)
    .filter((value) => value !== undefined);
  if (
    defaults.length > 0 &&
    defaults.every((value) => isDeepStrictEqual(value, defaults[0]))
  )
    schema.default = defaults[0];
};

const referencesChangingTarget = (
  node: unknown,
  root: unknown,
  active: ReadonlySet<string> = new Set(),
): boolean => {
  // A local reference hides the target's widening from the branch that uses
  // it. Treat such a sensitive branch as changed so its constraint is dropped.
  if (Array.isArray(node))
    return node.some((child) => referencesChangingTarget(child, root, active));
  if (!isObject(node)) return false;
  if (typeof node.$ref === "string" && !active.has(node.$ref)) {
    const nestedActive = new Set([...active, node.$ref]);
    const target = resolveLocalSchemaReference(
      root as Readonly<Record<string, unknown>>,
      node.$ref,
    )?.value;
    if (target !== undefined) {
      if (
        normalizeAdvertisedSchema(target, root, nestedActive).changed
      )
        return true;
      if (referencesChangingTarget(target, root, nestedActive)) return true;
    }
    // Reference siblings evaluate alongside the target in 2020-12, so keep
    // inspecting the remaining entries below.
  }
  return Object.entries(node).some(([key, child]) => {
    if (key === "const" || key === "enum" || key === "$ref") return false;
    // References inside a nested resource address that resource only.
    if (isObject(child) && "$id" in child) return false;
    return referencesChangingTarget(child, root, active);
  });
};

// Inside a nested resource, references resolve against that resource's own
// root rather than the outer schema.
const nestedResourceRoot = (child: unknown, root: unknown): unknown =>
  isObject(child) && "$id" in child ? child : root;

const normalizeAdvertisedSchema = (
  value: unknown,
  root: unknown = value,
  active: ReadonlySet<string> = new Set(),
): SchemaNormalization => {
  if (!isObject(value)) return { schema: value, changed: false };

  const node: Record<string, unknown> = { ...value };
  let changed = false;
  const normalizeMap = (map: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(map).map(([name, child]) => {
        const result = normalizeAdvertisedSchema(
          child,
          nestedResourceRoot(child, root),
          active,
        );
        changed ||= result.changed;
        return [name, result.schema];
      }),
    );
  const normalizeList = (list: readonly unknown[]) =>
      list.map((child) => {
        const result = normalizeAdvertisedSchema(
          child,
          nestedResourceRoot(child, root),
          active,
        );
        changed ||= result.changed;
        return result;
      });

  for (const [key, child] of Object.entries(value)) {
    if (schemaMaps.has(key) && isObject(child)) {
      node[key] = normalizeMap(child);
    } else if (
      schemaArrays.has(key) &&
      key !== "anyOf" &&
      key !== "oneOf" &&
      Array.isArray(child)
    ) {
      node[key] = normalizeList(child).map((result) => result.schema);
    } else if (
      schemaChildren.has(key) &&
      key !== "not" &&
      key !== "if" &&
      key !== "then" &&
      key !== "else"
    ) {
      const results = Array.isArray(child)
        ? normalizeList(child)
        : [
            normalizeAdvertisedSchema(
              child,
              nestedResourceRoot(child, root),
              active,
            ),
          ];
      const nestedChanged =
        results.some((result) => result.changed) ||
        (key === "contains" &&
          referencesChangingTarget(child, root, active));
      if (
        key === "contains" &&
        nestedChanged &&
        value.maxContains !== undefined
      ) {
        delete node.contains;
        delete node.minContains;
        delete node.maxContains;
        changed = true;
      } else {
        node[key] = Array.isArray(child)
          ? results.map((result) => result.schema)
          : results[0]?.schema;
        changed ||= nestedChanged;
      }
    }
  }

  if (typeof node.const === "boolean") {
    delete node.const;
    if (node.type === undefined) node.type = "boolean";
    changed = true;
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((item) => typeof item === "boolean")
  ) {
    delete node.enum;
    if (node.type === undefined) node.type = "boolean";
    changed = true;
  }
  if (node.const === "") {
    delete node.const;
    if (node.type === undefined) node.type = "string";
    changed = true;
  }
  if (Array.isArray(node.enum) && node.enum.some((item) => item === "")) {
    // An empty enum member is rejected by Gemini function declarations; widen
    // to every member type so canonical-valid values stay accepted.
    const members = node.enum;
    delete node.enum;
    if (
      node.type === undefined &&
      node.anyOf === undefined &&
      node.oneOf === undefined
    ) {
      const types = [...new Set(members.map(literalSchemaType))];
      const defined = types.filter((type): type is string => type !== undefined);
      if (defined.length === types.length) {
        if (defined.length === 1) node.type = defined[0];
        else if (defined.length > 1)
          node.anyOf = defined.map((type) => ({ type }));
      }
    }
    changed = true;
  }

  const negated = Object.hasOwn(value, "not")
    ? normalizeAdvertisedSchema(
        value.not,
        nestedResourceRoot(value.not, root),
        active,
      )
    : undefined;
  if (
    negated?.changed ||
    referencesChangingTarget(value.not, root, active)
  ) {
    // Widening a predicate under `not` narrows the containing schema.
    changed = true;
    delete node.not;
  } else if (negated !== undefined) {
    node.not = negated.schema;
  }

  const conditional = Object.hasOwn(value, "if")
    ? normalizeAdvertisedSchema(
        value.if,
        nestedResourceRoot(value.if, root),
        active,
      )
    : undefined;
  const thenBranch = Object.hasOwn(value, "then")
    ? normalizeAdvertisedSchema(
        value.then,
        nestedResourceRoot(value.then, root),
        active,
      )
    : undefined;
  const elseBranch = Object.hasOwn(value, "else")
    ? normalizeAdvertisedSchema(
        value.else,
        nestedResourceRoot(value.else, root),
        active,
      )
    : undefined;
  if (
    conditional?.changed ||
    referencesChangingTarget(value.if, root, active)
  ) {
    // Changing the predicate can route canonical-valid inputs into a rejecting branch.
    changed = true;
    delete node.if;
    delete node.then;
    delete node.else;
    // The conditional no longer evaluates its branches, so any unevaluated
    // guard would now reject inputs the branches used to cover.
    delete node.unevaluatedProperties;
    delete node.unevaluatedItems;
  } else {
    if (conditional !== undefined) node.if = conditional.schema;
    if (thenBranch !== undefined) {
      node.then = thenBranch.schema;
      changed ||= thenBranch.changed;
    }
    if (elseBranch !== undefined) {
      node.else = elseBranch.schema;
      changed ||= elseBranch.changed;
    }
  }

  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = value[combinator];
    if (!Array.isArray(branches)) continue;
    const normalized = normalizeList(branches);
    const schemas = normalized.map((result) => result.schema);
    const branchesChanged =
      normalized.some((result) => result.changed) ||
      branches.some((branch) => referencesChangingTarget(branch, root, active));
    if (combinator === "oneOf" && branchesChanged) {
      const booleanLiteralsOnly = branches.every(isBooleanLiteralSchema);
      if (booleanLiteralsOnly) {
        node.type = "boolean";
        preserveSharedDefault(node, schemas);
        delete node.oneOf;
        changed = true;
        continue;
      }
      // `anyOf` retains branch guidance without allowing widened branches to
      // reject inputs that were accepted by exactly one canonical branch.
      delete node.oneOf;
      if (Array.isArray(node.anyOf)) {
        const existingAllOf = Array.isArray(node.allOf) ? node.allOf : [];
        node.allOf = [...existingAllOf, { anyOf: schemas }];
      } else {
        node.anyOf = schemas;
      }
      changed = true;
      continue;
    }
    if (
      branchesChanged &&
      schemas.length > 0 &&
      schemas.every(isBooleanSchema)
    ) {
      node.type = "boolean";
      preserveSharedDefault(node, schemas);
      delete node[combinator];
      changed = true;
      continue;
    }
    node[combinator] = schemas;
    changed ||= branchesChanged;
  }

  return { schema: node, changed };
};

// Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root, and
// clients then drop the tool or advertise it without parameters. Present a
// root union of strict object groups as one object whose properties are the
// union of the groups. The canonical Zod schema still enforces the exact group.
const flattenRootObjectUnion = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const { anyOf, oneOf, ...rest } = root;
  const alternatives = Array.isArray(anyOf) ? anyOf : oneOf;
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  )
    return root;
  const branches = alternatives.map((branch) => objectBranch(root, branch));
  if (!branches.every((branch) => branch !== undefined)) return root;
  const variants = new Map<string, unknown[]>();
  for (const branch of branches)
    for (const [name, schema] of Object.entries(branch.properties ?? {})) {
      const known = variants.get(name) ?? [];
      if (!known.some((seen) => isDeepStrictEqual(seen, schema)))
        known.push(schema);
      variants.set(name, known);
    }
  const required = sharedRequiredProperties(branches);
  // A coarse property minimum rejects underspecified objects. Partner fields
  // and exact group membership remain enforced by the canonical runtime parser.
  const fewestRequired = Math.min(
    ...branches.map((branch) => requiredProperties(branch).length),
  );
  // Groups that differ only in property values add no caller guidance.
  const groups = [...new Set(branches.map(inputGroup))];
  const description = [
    typeof rest.description === "string" ? rest.description : undefined,
    groups.length > 1
      ? `Provide a complete input group: ${groups.join("; ")}.`
      : undefined,
  ].filter((text) => text !== undefined);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = rest;
  return {
    ...presentation,
    type: "object",
    ...(description.length > 0 ? { description: description.join(" ") } : {}),
    properties: Object.fromEntries(
      [...variants].map(([name, schemas]) => [
        name,
        schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(fewestRequired > 0 ? { minProperties: fewestRequired } : {}),
    ...(branches.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

// Collect references and anchors from schema positions only: literal
// annotation data (examples, defaults) is not a schema, so any `$ref` inside
// it must not influence advertised normalization.
const collectSchemaReferences = (
  node: unknown,
  refs: Set<string>,
  path: readonly string[],
): void => {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectSchemaReferences(child, refs, [...path, String(index)]),
    );
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#"))
    refs.add(node.$ref);
  for (const [key, child] of Object.entries(node)) {
    if (
      !schemaMaps.has(key) &&
      !schemaArrays.has(key) &&
      !schemaChildren.has(key)
    )
      continue;
    // Fragment references inside a nested resource address that resource,
    // never the outer schema; do not collect them.
    if (isObject(child) && "$id" in child) continue;
    if (schemaMaps.has(key) && isObject(child)) {
      for (const [name, grandChild] of Object.entries(child))
        collectSchemaReferences(grandChild, refs, [...path, key, name]);
    } else if (Array.isArray(child)) {
      child.forEach((grandChild, index) =>
        collectSchemaReferences(grandChild, refs, [...path, key, String(index)]),
      );
    } else {
      collectSchemaReferences(child, refs, [...path, key]);
    }
  }
};

// A reference whose target position the structural pass removed cannot keep
// its `$ref` (clients that compile the schema could not load it), so the
// widened target is inlined at every caller instead.
const inlineReferences = (
  node: unknown,
  dangling: ReadonlyMap<string, unknown>,
): unknown => {
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((child) => {
      const next = inlineReferences(child, dangling);
      changed ||= next !== child;
      return next;
    });
    return changed ? mapped : node;
  }
  if (!isObject(node)) return node;
  if (
    typeof node.$ref === "string" &&
    dangling.has(node.$ref) &&
    Object.keys(node).length === 1
  )
    return dangling.get(node.$ref);
  let changed = false;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (schemaMaps.has(key) && isObject(child)) {
      let mapChanged = false;
      const map: Record<string, unknown> = {};
      for (const [name, grandChild] of Object.entries(child)) {
        const next = inlineReferences(grandChild, dangling);
        map[name] = next;
        mapChanged ||= next !== grandChild;
      }
      rebuilt[key] = mapChanged ? map : child;
      changed ||= mapChanged;
    } else if (schemaArrays.has(key) || schemaChildren.has(key)) {
      const next = inlineReferences(child, dangling);
      rebuilt[key] = next;
      changed ||= next !== child;
    } else {
      rebuilt[key] = child;
    }
  }
  return changed ? rebuilt : node;
};

// Positive local references can address positions the structural walk never
// visits (for example a root-level annotation), which would leave the target's
// empty-string literal advertised. Normalize every referenced target too.
// All change decisions are computed against the immutable source schema before
// any writeback, so rewriting one target cannot mask another target's change.
const normalizeReferencedTargets = (
  advertised: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const refs = new Set<string>();
  collectSchemaReferences(source, refs, []);
  const writes: Array<[readonly string[], unknown]> = [];
  const dangling = new Map<string, unknown>();
  const processed = new Set<string>();
  const queue = [...refs];
  while (queue.length > 0) {
    const reference = queue.shift();
    if (reference === undefined || processed.has(reference)) continue;
    processed.add(reference);
    const resolved = resolveLocalSchemaReference(source, reference);
    if (resolved === undefined || !isObject(resolved.value)) continue;
    // Targets reached only through other unwalked targets need the same
    // treatment as directly referenced ones.
    const nested = new Set<string>();
    collectSchemaReferences(resolved.value, nested, resolved.tokens);
    for (const nestedRef of nested)
      if (!processed.has(nestedRef)) queue.push(nestedRef);
    const presented = resolvePointer(advertised, resolved.tokens);
    if (presented === undefined) {
      // The position was removed by the structural pass; inline the widened
      // target at its callers rather than dangling.
      const removed = normalizeAdvertisedSchema(
        resolved.value,
        source,
        new Set([reference]),
      );
      dangling.set(reference, removed.schema);
      continue;
    }
    const result = normalizeAdvertisedSchema(
      resolved.value,
      source,
      new Set([reference]),
    );
    if (!result.changed) continue;
    // Prefer the presented node at the same position so injected property
    // descriptions survive the writeback.
    const replacement = isObject(presented)
      ? normalizeAdvertisedSchema(
          presented,
          source,
          new Set([reference]),
        ).schema
      : result.schema;
    writes.push([resolved.tokens, replacement]);
  }
  // Apply shallow writes first so a parent replacement cannot restore an
  // un-widened descendant; deeper writes then override their own positions.
  writes.sort((a, b) => a[0].length - b[0].length);
  for (const [tokens, replacement] of writes)
    assignAtPath(advertised, tokens, replacement);
  return dangling.size > 0 ? (inlineReferences(advertised, dangling) as Record<string, unknown>) : advertised;
};

const assignAtPath = (
  container: Record<string, unknown> | unknown[],
  tokens: readonly string[],
  replacement: unknown,
): void => {
  if (tokens.length === 0) return;
  const [head, ...rest] = tokens;
  if (Array.isArray(container)) {
    if (head === undefined || !/^(?:0|[1-9]\d*)$/u.test(head)) return;
    const index = Number(head);
    if (index >= container.length) return;
    if (rest.length === 0) {
      container[index] = replacement;
      return;
    }
    const child = container[index];
    const copy = Array.isArray(child)
      ? [...child]
      : isObject(child)
        ? { ...child }
        : undefined;
    if (copy === undefined) return;
    container[index] = copy;
    assignAtPath(copy, rest, replacement);
    return;
  }
  if (head === undefined) return;
  if (rest.length === 0) {
    container[head] = replacement;
    return;
  }
  const child = container[head];
  const copy = Array.isArray(child)
    ? [...child]
    : isObject(child)
      ? { ...child }
      : undefined;
  if (copy === undefined) return;
  container[head] = copy;
  assignAtPath(copy, rest, replacement);
};

const advertisedSchema = (
  input: unknown,
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const schema = normalizeAdvertisedSchema(input).schema as Record<
    string,
    unknown
  >;
  return normalizeReferencedTargets(schema, source);
};

/** Describe canonical input fields and present the root as one object. */
export const presentInputJsonSchema = (  root: Record<string, unknown>,
  describeProperty: (property: string) => string | undefined,
): Record<string, unknown> => {
  const flattened = flattenRootObjectUnion(root);
  const described = describeSchema(flattened, flattened, describeProperty);
  if (!isObject(described))
    return advertisedSchema(flattened, root);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = described;
  const rootDependencies = isObject(described.dependentRequired)
    ? described.dependentRequired
    : isObject(described.dependencies)
      ? described.dependencies
      : undefined;
  const dependencyGuidance =
    rootDependencies === undefined
      ? []
      : Object.entries(rootDependencies).flatMap(([property, partners]) =>
          Array.isArray(partners) &&
          partners.every((partner) => typeof partner === "string")
            ? [
                `When ${property} is provided, also provide ${partners.join(" and ")}.`,
              ]
            : [],
        );
  if (dependencyGuidance.length === 0)
    return advertisedSchema(presentation, root);
  const description = [
    typeof presentation.description === "string"
      ? presentation.description
      : undefined,
    ...dependencyGuidance,
  ].filter((text) => text !== undefined);
  return advertisedSchema(
    {
      ...presentation,
      description: description.join(" "),
    },
    root,
  );
};
