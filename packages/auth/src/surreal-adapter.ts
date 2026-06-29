import { env } from "@perry-starter/env/server";
import { type CustomAdapter, createAdapterFactory } from "better-auth/adapters";

// Custom better-auth adapter over SurrealDB-over-HTTP. There is NO official
// SurrealDB adapter in better-auth, so this is built with createAdapterFactory
// and driven entirely by the @perry-starter/env/server SURREAL_* contract. It
// runs ONLY on the cloud worker tier (standard Cloudflare Workers / native
// fetch) — never the Perry daemon. There is no DATABASE_URL.

interface SqlResult {
  result: unknown;
  status: "OK" | "ERR";
  time: string;
}

interface WhereClause {
  connector: "AND" | "OR";
  field: string;
  operator: string;
  value: unknown;
}

const basicAuth = (): string =>
  `Basic ${btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)}`;

const runSql = async (query: string): Promise<SqlResult[]> => {
  const response = await fetch(`${env.SURREAL_URL}/sql`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "surreal-ns": env.SURREAL_NS,
      "surreal-db": env.SURREAL_DB,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: query,
  });
  // A non-2xx (auth failure, bad namespace, 5xx) yields a non-array error body;
  // calling .find on it would surface an opaque "rows.find is not a function".
  // Fail loudly with the transport status instead.
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `SurrealDB HTTP request failed: ${response.status} ${response.statusText} ${detail}`.trim()
    );
  }
  // HTTP 200 != success: SurrealDB returns one result object per statement, each
  // carrying its own status. A non-array body (or a per-statement "ERR") is a
  // failure even at HTTP 200.
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(
      `SurrealDB returned an unexpected non-array body: ${JSON.stringify(body)}`
    );
  }
  const rows = body as SqlResult[];
  const failed = rows.find((row) => row.status === "ERR");
  if (failed) {
    throw new Error(`SurrealQL statement failed: ${String(failed.result)}`);
  }
  return rows;
};

const toSurql = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "NONE";
  }
  if (value instanceof Date) {
    return `d${JSON.stringify(value.toISOString())}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toSurql(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${toSurql(item)}`
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
};

const clauseSql = (clause: WhereClause): string => {
  const field = clause.field;
  const value = toSurql(clause.value);
  switch (clause.operator) {
    case "ne":
      return `${field} != ${value}`;
    case "lt":
      return `${field} < ${value}`;
    case "lte":
      return `${field} <= ${value}`;
    case "gt":
      return `${field} > ${value}`;
    case "gte":
      return `${field} >= ${value}`;
    case "in":
      return `${field} IN ${value}`;
    case "not_in":
      return `${field} NOT IN ${value}`;
    case "contains":
      return `${field} CONTAINS ${value}`;
    case "starts_with":
      return `string::starts_with(${field}, ${value})`;
    case "ends_with":
      return `string::ends_with(${field}, ${value})`;
    default:
      return `${field} = ${value}`;
  }
};

const buildWhere = (where: WhereClause[]): string => {
  if (where.length === 0) {
    return "";
  }
  const parts = where.map((clause, index) =>
    index === 0 ? clauseSql(clause) : `${clause.connector} ${clauseSql(clause)}`
  );
  return ` WHERE ${parts.join(" ")}`;
};

const records = (rows: SqlResult[]): Record<string, unknown>[] => {
  const first = rows[0]?.result;
  return Array.isArray(first) ? (first as Record<string, unknown>[]) : [];
};

const firstRecord = (rows: SqlResult[]): Record<string, unknown> | undefined =>
  records(rows)[0];

export const surrealAdapter = createAdapterFactory({
  config: {
    adapterId: "surreal",
    adapterName: "SurrealDB (HTTP)",
  },
  adapter: ({ getModelName }) => {
    const table = (model: string): string =>
      JSON.stringify(getModelName(model));

    const ops = {
      create: async ({
        model,
        data,
      }: {
        model: string;
        data: Record<string, unknown>;
      }) => {
        const rows = await runSql(
          `CREATE type::table(${table(model)}) CONTENT ${toSurql(data)} RETURN AFTER;`
        );
        return firstRecord(rows) ?? data;
      },
      findOne: async ({
        model,
        where,
      }: {
        model: string;
        where: WhereClause[];
      }) => {
        const rows = await runSql(
          `SELECT * FROM type::table(${table(model)})${buildWhere(where)} LIMIT 1;`
        );
        return firstRecord(rows) ?? null;
      },
      findMany: async ({
        model,
        where,
        limit,
        offset,
        sortBy,
      }: {
        model: string;
        where?: WhereClause[];
        limit?: number;
        offset?: number;
        sortBy?: { field: string; direction: "asc" | "desc" };
      }) => {
        const order = sortBy
          ? ` ORDER BY ${sortBy.field} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`
          : "";
        const limitClause = typeof limit === "number" ? ` LIMIT ${limit}` : "";
        const startClause =
          typeof offset === "number" ? ` START ${offset}` : "";
        const rows = await runSql(
          `SELECT * FROM type::table(${table(model)})${buildWhere(where ?? [])}${order}${limitClause}${startClause};`
        );
        return records(rows);
      },
      update: async ({
        model,
        where,
        update,
      }: {
        model: string;
        where: WhereClause[];
        update: Record<string, unknown>;
      }) => {
        const rows = await runSql(
          `UPDATE type::table(${table(model)})${buildWhere(where)} MERGE ${toSurql(update)} RETURN AFTER;`
        );
        return firstRecord(rows) ?? null;
      },
      updateMany: async ({
        model,
        where,
        update,
      }: {
        model: string;
        where: WhereClause[];
        update: Record<string, unknown>;
      }) => {
        const rows = await runSql(
          `UPDATE type::table(${table(model)})${buildWhere(where)} MERGE ${toSurql(update)} RETURN AFTER;`
        );
        return records(rows).length;
      },
      delete: async ({
        model,
        where,
      }: {
        model: string;
        where: WhereClause[];
      }) => {
        await runSql(
          `DELETE type::table(${table(model)})${buildWhere(where)};`
        );
      },
      deleteMany: async ({
        model,
        where,
      }: {
        model: string;
        where: WhereClause[];
      }) => {
        const rows = await runSql(
          `DELETE type::table(${table(model)})${buildWhere(where)} RETURN BEFORE;`
        );
        return records(rows).length;
      },
      count: async ({
        model,
        where,
      }: {
        model: string;
        where?: WhereClause[];
      }) => {
        const rows = await runSql(
          `SELECT count() AS count FROM type::table(${table(model)})${buildWhere(where ?? [])} GROUP ALL;`
        );
        const value = firstRecord(rows)?.count;
        return typeof value === "number" ? value : 0;
      },
    };

    return ops as unknown as CustomAdapter;
  },
});
