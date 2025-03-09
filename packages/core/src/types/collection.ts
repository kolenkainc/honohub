import type { AnyDrizzleDB } from "drizzle-graphql";
import type { Table } from "drizzle-orm";
import type { Context, Env, Hono, Schema } from "hono";
import type { BlankSchema, Input } from "hono/types";
import type { JSONValue } from "hono/utils/types";
import type { Prettify, Promisify } from "./utils";

export type TableColumns<T extends Table> = keyof T["_"]["columns"];

/** Manage all aspects of a data collection */
export type CollectionConfig<
  T extends Table = Table,
  U extends string | number | symbol = TableColumns<T>,
> = {
  /**
   * The collection slug
   * @default tableName
   */
  slug?: string;
  /**
   * The key to use for querying
   * @default pk Tables primary key
   */
  queryKey?: U;
  schema: T;
  /**
   * Access control
   */
  access?: <
    E extends Env = Env,
    P extends string = string,
    I extends Input = Input,
  >(
    c: Context<E, P, I>,
  ) => Promisify<boolean>;
  /**
   * Default sort order
   */
  defaultSort?: U | `-${U & string}`;
  /**
   * Fields to be searched via the full text search
   */
  listSearchableFields?: U[];
  /**
   * Collection admin options
   */
  admin?: Partial<CollectionAdminProps<T, U>>;
  /**
   * Pagination options
   * @default false
   */
  pagination?: CollectionPagination | false;
  /**
   * Hooks to modify HonoHub functionality
   */
  hooks?: Partial<CollectionHooks<T["$inferInsert"]>>;
  plugins?: CollectionPlugin<T>[];
  driver?: (db: unknown, collection: SanitizedCollection<T, U>) => Driver;
};

/** Sanitized collection configuration */
export type SanitizedCollection<
  T extends Table = Table,
  U extends string | number | symbol = TableColumns<T>,
> = Prettify<
  Required<Omit<CollectionConfig<T, U>, "defaultSort" | "admin" | "driver">> & {
    defaultSort?: U | `-${U & string}`;
    admin: CollectionAdminProps<T, U> & { actions: CollectionAction<T, U>[] };
    driver: (db: unknown, collection: SanitizedCollection<T, U>) => Driver;
  }
>;

export interface Driver<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  db: unknown;
  collection: SanitizedCollection;
  list: (query: Query) => Promise<T[] | { results: T[]; count: number }>;
  count: () => Promise<number>;
  validate: (data: unknown) => Promise<T>;
  create: (data: T) => Promise<T>;
  retrieve: (id: string | number) => Promise<T>;
  update: (id: string | number, data: Partial<T>) => Promise<T>;
  delete: (id: string | number) => Promise<T>;
}

export type Query = {
  limit: number;
  offset: number;
  search?: string;
  sortBy?: string;
};

/** Collection pagination options */
export type CollectionPagination = {
  /**
   * Default limit for pagination
   * @default 10
   * @minimum 1
   * @maximum maxLimit
   */
  defaultLimit: number;
  /**
   * Maximum limit for pagination
   * @minimum 1
   */
  maxLimit?: number;
};

export type CollectionAdminProps<
  T extends Table = Table,
  U extends string | number | symbol = TableColumns<T>,
> = {
  /**
   * Label configuration
   */
  label: string | { singular: string; plural: string };
  /**
   * Default columns to show in list view
   */
  columns?: (U | { name: U; label: string; type?: string })[];
  fields?: (
    | U
    | {
        name: U;
        label: string;
        type?: string;
        required?: boolean;
        description?: string;
      }
  )[];
  /**
   * Quick actions to perform on the collection from the UI
   * @default false
   */
  actions?: boolean | CollectionAction<T, U>[];
};

export type CollectionAction<
  T extends Table = Table,
  U extends string | number | symbol = TableColumns<T>,
> = {
  name: string;
  label?: string;
  icon?: string;
  action: <
    Database extends AnyDrizzleDB<any> = AnyDrizzleDB<any>,
    E extends Env = Env,
    P extends string = string,
    I extends Input = Input,
  >(props: {
    db: Database;
    items: unknown[];
    context: Context<E, P, I>;
    config: SanitizedCollection<T, U>;
  }) => Promisify<void>;
  level?: boolean | { title: string; message: string };
};

export type CollectionPlugin<
  T extends Table = Table,
  U extends string | number | symbol = TableColumns<T>,
> = {
  name: string;
  register?: (
    config: SanitizedCollection<T, U>,
  ) => SanitizedCollection<T, U> | undefined;
  bootstrap?: <
    E extends Env = Env,
    P extends Schema = BlankSchema,
    I extends string = string,
  >(props: {
    app: Hono<E, P, I>;
    config: SanitizedCollection<T, U>;
  }) => Hono<E, P, I> | undefined;
};

export type CollectionHooks<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  beforeOperation: CollectionBeforeOperationHook[];
  beforeValidate: CollectionBeforeValidateHook<T>[];
  beforeChange: CollectionBeforeChangeHook<T>[];
  afterChange: CollectionAfterChangeHook<T>[];
  beforeRead: CollectionBeforeReadHook[];
  afterRead: CollectionAfterReadHook<T>[];
  beforeDelete: CollectionBeforeDeleteHook[];
  afterDelete: CollectionAfterDeleteHook<T>[];
  afterOperation: CollectionAfterOperationHook[];
};

export type CollectionBeforeOperationHook = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
}) => Promisify<void>;

export type CollectionBeforeValidateHook<
  T extends Record<string, unknown> = Record<string, unknown>,
> = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  data: JSONValue;
  originalDoc?: T;
}) => Promisify<JSONValue>;

export type CollectionBeforeChangeHook<
  T extends Record<string, unknown> = Record<string, unknown>,
> = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  data: T;
  originalDoc?: T;
}) => Promisify<T>;

export type CollectionAfterChangeHook<
  T extends Record<string, unknown> = Record<string, unknown>,
> = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  doc: T;
  previousDoc: T;
}) => Promisify<JSONValue | undefined>;

export type CollectionBeforeReadHook = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
}) => Promisify<void>;

export type CollectionAfterReadHook<
  T extends Record<string, unknown> = Record<string, unknown>,
> = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  doc: T | { results: T[]; count: number };
}) => Promisify<JSONValue | undefined>;

export type CollectionBeforeDeleteHook = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
}) => Promisify<void>;

/**
 * Runs immediately after the delete operation removes
 * records from the database. Returned values are discarded.
 */
export type CollectionAfterDeleteHook<
  T extends Record<string, unknown> = Record<string, unknown>,
> = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  doc: T;
}) => Promisify<JSONValue | undefined>;

export type CollectionAfterOperationHook = <
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(props: {
  context: Context<E, P, I>;
  result: unknown;
}) => Promisify<JSONValue>;
