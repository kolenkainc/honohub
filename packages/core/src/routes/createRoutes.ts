import { zValidator } from "@hono/zod-validator";
import type { AnyDrizzleDB } from "drizzle-graphql";
import { asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { createInsertSchema } from "drizzle-zod";
import { type Env, Hono, type Schema } from "hono";
import { HTTPException } from "hono/http-exception";
import type { BlankSchema } from "hono/types";
import { z } from "zod";
import type { SanitizedCollection, SanitizedHub } from "../types";

export function createRoutes<
  Database extends AnyDrizzleDB<any>,
  U extends Table,
  E extends Env = Env,
  P extends Schema = BlankSchema,
  I extends string = string,
>(config: SanitizedHub<Database>, collection: SanitizedCollection<U>) {
  // Creating a new app
  let app = new Hono<E, P, I>().use(async (c, next) => {
    // Checking if we have access
    const hasAccess = await collection.access(c);

    // Throwing error if the req don't have access
    if (!hasAccess) throw new HTTPException(403, { message: "Access denied" });

    await next();
  });

  // Database instance
  const db = config.db as NeonHttpDatabase;

  // Generating the zod validation
  let collectionInsertSchema = createInsertSchema(collection.schema);

  if (collection.admin.fields)
    // @ts-expect-error
    collectionInsertSchema = collectionInsertSchema.pick(
      collection.admin.fields.reduce((acc, field) => {
        let key = field;
        if (typeof field === "object" && "name" in field) key = field.name;

        // @ts-expect-error
        acc[key] = true;
        return acc;
      }, {}),
    );

  // Prepared queries
  // Collection Document Count
  const collectionDocumentCount = db
    .select({ count: count() })
    // @ts-expect-error
    .from(collection.schema)
    .prepare(`${collection.slug}_count_query`);

  // Collection Retrieve Query
  const collectionRetrieveQuery = db
    .select()
    // @ts-expect-error
    .from(collection.schema)
    .where(eq(collection.queryKey, sql.placeholder("id")))
    .prepare(`${collection.slug}_retrieve_query`);

  // Collection Delete Query
  const collectionDeleteQuery = db
    .delete(collection.schema)
    .where(eq(collection.queryKey, sql.placeholder("id")))
    .$dynamic();

  if ("$returningId" in collectionDeleteQuery) {
    // @ts-expect-error
    collectionDeleteQuery.$returningId?.();
  } else {
    collectionDeleteQuery.returning();
  }

  collectionDeleteQuery.prepare(`${collection.slug}_delete_query`);

  const defaultLimit =
    (typeof collection.pagination !== "boolean"
      ? collection.pagination?.defaultLimit
      : undefined) ?? 10;

  const queryValidationSchema = z.object({
    limit: z.coerce.number().nonnegative().default(defaultLimit),
    offset: z.coerce.number().nonnegative().default(0),
    search: z.string().optional(),
    sortBy: z.string().optional(),
  });

  // List records endpoint
  app.get("/", zValidator("query", queryValidationSchema), async (c) => {
    for (const hook of collection.hooks.beforeRead ?? []) {
      await hook({
        context: c,
      });
    }

    const query = c.req.valid("query");

    // @ts-expect-error
    const records = db.select().from(collection.schema).$dynamic();
    // @ts-expect-error
    const recordsCount = db.select({ count: count() }).from(collection.schema);

    if (query.search && collection.listSearchableFields.length > 0) {
      records.where(
        or(
          ...collection.listSearchableFields.map((field) =>
            // @ts-expect-error
            ilike(collection.schema[field], `%${query.search}%`),
          ),
        ),
      );
    }

    // Sorting the data
    const sortBy = query.sortBy ?? collection.defaultSort;
    let sortByInString = String(sortBy);

    let order: typeof desc;
    if (sortByInString.startsWith("-")) {
      sortByInString = sortByInString.slice(1);
      order = desc;
    } else {
      order = asc;
    }

    if (sortBy && sortByInString in collection.schema) {
      // @ts-expect-error
      records.orderBy(order(collection.schema[sortByInString]));
    }

    let results: any[];
    let totalDocuments: number;
    let payload: any[] | { results: any[]; count: number };

    if (collection.pagination) {
      if (
        collection.pagination.maxLimit &&
        query.limit > collection.pagination.maxLimit
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

    for (const hook of collection.hooks.afterRead ?? []) {
      const res = await hook({
        context: c,
        doc: payload,
      });

      // @ts-ignore
      if (res !== undefined) payload = res;
    }

    return c.json(payload);
  });

  // List records endpoint
  app.get("/count", async (c) =>
    c.json({
      count: await collectionDocumentCount
        .execute()
        .then((records) => records[0].count),
    }),
  );

  // Create record endpoint
  app.post("/", async (c) => {
    // Getting the raw data
    let raw = await (c.req.header("Content-Type") === "application/json"
      ? c.req.json()
      : c.req.formData());

    if (!raw)
      throw new HTTPException(404, {
        message: "Request body is missing or empty",
      });

    for (const hook of collection.hooks.beforeValidate ?? []) {
      const res = await hook({
        context: c,
        data: raw,
      });
      if (res !== undefined) raw = res;
    }

    // Parsing the value
    const parsedData = await collectionInsertSchema.safeParseAsync(raw);

    if (!parsedData.success) {
      return c.json(parsedData, 400);
    }

    let data = parsedData.data;

    for (const hook of collection.hooks.beforeChange ?? []) {
      const res = await hook({
        context: c,
        data,
      });

      if (res !== undefined) data = res;
    }

    // Saving the record
    const createdDocQuery = db
      .insert(collection.schema)
      .values(data)
      .$dynamic();

    if (
      "$returningId" in createdDocQuery &&
      typeof createdDocQuery.$returningId === "function"
    ) {
      createdDocQuery.$returningId?.();
    } else {
      createdDocQuery.returning();
    }

    let createdDoc: any = await createdDocQuery.execute();

    for (const hook of collection.hooks.afterChange ?? []) {
      const res = await hook({
        context: c,
        doc: createdDoc,
        previousDoc: data,
      });

      if (res !== undefined) createdDoc = res;
    }

    // Returning the response
    // @ts-ignore
    return c.json(createdDoc);
  });

  // Retrieve record endpoint
  app.get("/:id", async (c) => {
    for (const hook of collection.hooks.beforeRead ?? []) {
      await hook({
        context: c,
      });
    }

    // Getting the record
    let record = await collectionRetrieveQuery
      .execute({
        id: c.req.param("id"),
      })
      .then((records) => records[0]);

    if (!record)
      throw new HTTPException(404, { message: "Document not found" });

    for (const hook of collection.hooks.afterRead ?? []) {
      const res = await hook({
        context: c,
        doc: record,
      });

      // @ts-ignore
      if (res !== undefined) record = res;
    }

    // Returning the response
    return c.json(record);
  });

  // Update record endpoint
  app.put("/:id", async (c) => {
    // Getting the raw data
    let raw = await (c.req.header("Content-Type") === "application/json"
      ? c.req.json()
      : c.req.formData());

    if (!raw)
      throw new HTTPException(404, {
        message: "Request body is missing or empty",
      });

    // Getting the original document
    const record = await collectionRetrieveQuery
      .execute({
        id: c.req.param("id"),
      })
      .then((records) => records[0]);

    if (!record)
      throw new HTTPException(404, { message: "Document not found" });

    for (const hook of collection.hooks.beforeValidate ?? []) {
      const res = await hook({
        context: c,
        data: raw,
        originalDoc: record,
      });
      if (res !== undefined) raw = res;
    }

    // Parsing the value
    const parsedData = await collectionInsertSchema.safeParseAsync(raw);

    if (!parsedData.success) {
      return c.json(parsedData, 400);
    }

    let data = parsedData.data;

    for (const hook of collection.hooks.beforeChange ?? []) {
      const res = await hook({
        context: c,
        data,
        originalDoc: record,
      });

      if (res !== undefined) data = res;
    }

    // Updating the record
    const updatedDocQuery = db
      .update(collection.schema)
      .set(data)
      .where(eq(collection.queryKey, c.req.param("id")))
      .$dynamic();

    if (
      "$returningId" in updatedDocQuery &&
      typeof updatedDocQuery.$returningId === "function"
    ) {
      updatedDocQuery.$returningId?.();
    } else {
      updatedDocQuery.returning();
    }

    let updatedDoc: any = await updatedDocQuery.execute();

    for (const hook of collection.hooks.afterChange ?? []) {
      const res = await hook({
        context: c,
        doc: updatedDoc,
        previousDoc: data,
      });
      if (res !== undefined) updatedDoc = res;
    }

    // Returning the response
    // @ts-ignore
    return c.json(updatedDoc);
  });

  // Delete record endpoint
  app.delete("/:id", async (c) => {
    for (const hook of collection.hooks.beforeDelete ?? []) {
      await hook({ context: c });
    }

    // Deleting the record
    let deletedDoc: any = await collectionDeleteQuery.execute({
      id: c.req.param("id"),
    });

    for (const hook of collection.hooks.afterDelete ?? []) {
      const res = await hook({ context: c, doc: deletedDoc });
      if (res !== undefined) deletedDoc = res;
    }

    // Returning the response
    // @ts-ignore
    return c.json(deletedDoc);
  });

  // Actions

  if (collection.admin.actions.length > 0) {
    const actionRouter = new Hono<E, P, I>();

    for (const { name, action } of collection.admin.actions ?? []) {
      actionRouter.post(
        `/${name}`,
        zValidator(
          "json",
          z.object({
            items: z.array(z.any()).min(1).max(100),
          }),
        ),
        async (c) => {
          const { items } = c.req.valid("json");

          try {
            await action({ items, context: c, db, config: collection });
          } catch (err) {
            console.error(err);
            throw new HTTPException(400, {
              message: "Unable to complete the action!",
            });
          }

          return c.json(null);
        },
      );
    }

    app.route("/actions", actionRouter);
  }

  // Applying the plugins
  for (const plugin of collection.plugins) {
    try {
      const tmp = plugin.bootstrap?.({ app, config: collection });
      if (tmp) app = tmp;
    } catch (e) {
      console.error(`[${plugin.name}] Collection Plugin Bootstrap Error`, e);
    }
  }

  return app;
}
