import {
  schemaGuard,
  type Queryable,
  type SchemaBehindBody,
  type SchemaGuard,
} from "@windkeel/factory/ops";

export const deploymentSchema: SchemaGuard = schemaGuard();

export function primeSchemaCheck(db: Queryable): void {
  deploymentSchema.status(db).catch(() => {});
}

export function schemaRefusal(db: Queryable): Promise<SchemaBehindBody | null> {
  return deploymentSchema.refusal(db);
}
