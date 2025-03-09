import type { AnyDrizzleDB } from "drizzle-graphql";
import {
  type Column,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  getTableName,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { Table } from "drizzle-orm/table";
import { createInsertSchema } from "drizzle-zod";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type {
  CollectionAction,
  CollectionConfig,
  Query,
  SanitizedCollection,
  TableColumns,
} from "../types";

export function drizzleCollection<
  T extends Table,
  U extends string | number | symbol = TableColumns<T>,
>(config: CollectionConfig<T, U>): SanitizedCollection<T, U> {
  const columns = getTableColumns(config.schema);
  const queryKeyColumn =
    config.queryKey && config.queryKey in columns
      ? columns[config.queryKey as TableColumns<T>]
      : Object.values(columns).find((column) => column.primary);

  if (!queryKeyColumn)
    throw new Error(
      `Unable to find primary key for ${getTableName(config.schema)} table!`,
    );

  const {
    schema,
    slug = getTableName(schema),
    admin = {},
    queryKey = queryKeyColumn.name as U,
    access = () => true,
    defaultSort,
    listSearchableFields = [],
    pagination = false,
    plugins = [],
    hooks = {},
  } = config;

  // Checking if paginations are correct
  if (pagination) {
    if (pagination.defaultLimit && pagination.defaultLimit <= 0)
      throw new Error("defaultLimit must be greater than zero.");
    if (pagination.maxLimit && pagination.maxLimit <= 0)
      throw new Error("maxLimit must be greater than zero.");
    if (
      pagination.maxLimit &&
      pagination.defaultLimit &&
      pagination.maxLimit < pagination.defaultLimit
    )
      throw new Error("maxLimit must be greater than defaultLimit.");
  }

  const actions: CollectionAction<T, U>[] = [];
  const bulkDeleteAction: CollectionAction<T, U> = {
    name: "bulk_delete",
    label: "Bulk Delete",
    icon: "TrashIcon",
    level: true,
    action: ({ items, db, config }) => {
      const entries = [];

      for (const item of items) {
        if (item && typeof item === "object" && config.queryKey in item)
          // @ts-expect-error
          entries.push(item[config.queryKey]);
        else
          new HTTPException(400, {
            message: `Unable to find the query key '${queryKeyColumn.name}' in the given entries.`,
          });
      }

      // @ts-expect-error
      db.delete(config.schema)
        .where(inArray(queryKeyColumn, entries))
        .execute();
    },
  };

  if (admin && admin.actions !== false) {
    actions.push(
      bulkDeleteAction,
      ...(Array.isArray(admin.actions) ? admin.actions : []),
    );
  }

  let sanitizedConfig: SanitizedCollection<T, U> = {
    slug,
    admin: {
      ...admin,
      label: admin.label ?? slug,
      actions,
    },
    schema,
    queryKey,
    access,
    defaultSort,
    listSearchableFields,
    pagination,
    plugins,
    hooks,
    // @ts-expect-error
    driver: (db, collection) => new DrizzleDriver(db, collection),
  };

  for (const plugin of plugins) {
    try {
      // @ts-expect-error
      const tmp = plugin.register?.(sanitizedConfig);

      // @ts-expect-error
      sanitizedConfig = tmp;
    } catch (e) {
      console.error(`[${plugin.name}] Collection Plugin Registration Error`, e);
    }
  }

  return sanitizedConfig;
}

export class DrizzleDriver<
  Database extends AnyDrizzleDB<any>,
  T extends Table,
> {
  db;
  collection;
  queryKey: Column<any, object, object>;

  // Prepared Queries
  collectionDocumentCount;
  collectionRetrieveQuery;
  collectionDeleteQuery: any;

  // Columns Map
  columns;

  // Validation
  collectionInsertSchema: ZodType;

  constructor(db: Database, collection: SanitizedCollection<T>) {
    this.db = db as NeonHttpDatabase;
    this.collection = collection;

    this.columns = getTableColumns(this.collection.schema);
    this.queryKey = this.columns[this.collection.queryKey];

    // Generating the zod validation
    this.collectionInsertSchema = createInsertSchema(this.collection.schema);

    if (this.collection.admin.fields) {
      const pickFields = this.collection.admin.fields.reduce<{
        [K in TableColumns<T>]?: true;
      }>((acc, field) => {
        let key = field;
        if (typeof field === "object" && "name" in field) key = field.name;

        acc[key as TableColumns<T>] = true;
        return acc;
      }, {});

      this.collectionInsertSchema = createInsertSchema(
        this.collection.schema,
      ).pick(
        // @ts-expect-error
        pickFields,
      );
    }
    // Collection Document Count
    this.collectionDocumentCount = this.db
      .select({ count: count() })
      .from(this.collection.schema)
      .prepare(`${this.collection.slug}_count_query`);

    // Collection Retrieve Query
    this.collectionRetrieveQuery = this.db
      .select()
      .from(this.collection.schema)
      .where(eq(this.queryKey, sql.placeholder("id")))
      .prepare(`${this.collection.slug}_retrieve_query`);

    // Collection Delete Query
    this.collectionDeleteQuery = this.db
      .delete(this.collection.schema)
      .where(eq(this.queryKey, sql.placeholder("id")))
      .$dynamic();

    if (
      "$returningId" in this.collectionDeleteQuery &&
      typeof this.collectionDeleteQuery.$returningId === "function"
    ) {
      this.collectionDeleteQuery = this.collectionDeleteQuery.$returningId();
    } else {
      this.collectionDeleteQuery = this.collectionDeleteQuery.returning();
    }

    this.collectionDeleteQuery = this.collectionDeleteQuery.prepare(
      `${this.collection.slug}_delete_query`,
    );
  }

  async list(query: Query) {
    const records = this.db.select().from(this.collection.schema).$dynamic();
    const recordsCount = this.db
      .select({ count: count() })
      .from(this.collection.schema);

    if (query.search && this.collection.listSearchableFields.length > 0) {
      records.where(
        or(
          ...this.collection.listSearchableFields.map((field) =>
            ilike(this.columns[field], `%${query.search}%`),
          ),
        ),
      );
    }

    // Sorting the data
    const sortBy = query.sortBy ?? this.collection.defaultSort;
    let sortByInString = String(sortBy);

    let order: typeof desc;
    if (sortByInString.startsWith("-")) {
      sortByInString = sortByInString.slice(1);
      order = desc;
    } else {
      order = asc;
    }

    if (sortBy && sortByInString in this.collection.schema) {
      records.orderBy(order(this.columns[sortByInString]));
    }

    let results: T["$inferSelect"][];
    let totalDocuments: number;
    let payload:
      | T["$inferSelect"][]
      | { results: T["$inferSelect"][]; count: number };

    if (this.collection.pagination) {
      if (
        this.collection.pagination.maxLimit &&
        query.limit > this.collection.pagination.maxLimit
      )
        throw new HTTPException(400, {
          message: "The limit value exceeds the maximum allowed limit.",
        });

      records.limit(query.limit).offset(query.offset);

      [results, totalDocuments] = await Promise.all([
        records.execute(),
        recordsCount.then((res) => res[0].count),
      ]);

      payload = { results, count: totalDocuments };
    } else payload = await records.execute();

    return payload;
  }

  async count() {
    return await this.collectionDocumentCount
      .execute()
      .then((records) => records[0].count);
  }

  async validate(values: unknown) {
    // Parsing the value
    const result = await this.collectionInsertSchema.safeParseAsync(values);

    if (!result.success) {
      throw new HTTPException(400, {
        res: new Response(JSON.stringify(result.error), {
          status: 400,
        }),
      });
    }

    return result.data;
  }

  async create(values: T["$inferInsert"]) {
    // Saving the record
    const createdDocQuery = this.db
      .insert(this.collection.schema)
      .values(values)
      .$dynamic();

    if (
      "$returningId" in createdDocQuery &&
      typeof createdDocQuery.$returningId === "function"
    ) {
      return await createdDocQuery.$returningId().execute();
    }

    return await createdDocQuery.returning().execute();
  }

  async retrieve(id: string | number) {
    return await this.collectionRetrieveQuery
      .execute({
        id,
      })
      .then((records) => records[0]);
  }

  async update(id: string | number, values: T["$inferInsert"]) {
    // Updating the record
    const updatedDocQuery = this.db
      .update(this.collection.schema)
      .set(values)
      .where(eq(this.queryKey, id))
      .$dynamic();

    if (
      "$returningId" in updatedDocQuery &&
      typeof updatedDocQuery.$returningId === "function"
    ) {
      return await updatedDocQuery.$returningId().execute();
    }
    return await updatedDocQuery.returning().execute();
  }

  async delete(id: string | number) {
    return await this.collectionDeleteQuery.execute({
      id,
    });
  }
}
