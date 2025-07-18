import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HonoHub } from "kolenkainc-honohub-react";
import type { AnyDrizzleDB } from "drizzle-graphql";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SanitizedHub, ValueOf } from "kolenkainc-honohub";

export type TemplateGeneratorProps<Database extends AnyDrizzleDB<any>> = {
  basePath: string;
  build: BuildOptions;
  config: SanitizedHub<Database>;
  override?: string;
};

/**
 * Represents the build options for the HonoHub admin panel.
 */
export type BuildOptions = {
  /**
   * The cache directory path.
   */
  cache: string;
  /**
   * The output directory path.
   */
  outDir: string;
};

export async function generateReactTemplates<
  Database extends AnyDrizzleDB<any>,
>({ config, build, basePath, override }: TemplateGeneratorProps<Database>) {
  const pluginProps: NonNullable<HonoHub["plugins"]> = {};

  for (const page in config.routes) {
    const route = config.routes[page];

    const importProps =
      typeof route.import === "string"
        ? { module: route.import, component: "default" }
        : route.import;

    pluginProps[route.path] = {
      label: route.label,
      icon: route.icon,
      import: `import('${importProps.module}').then((mod) => mod.${importProps.component})`,
      props:
        (route.props && typeof route.props === "function"
          ? route.props(config)
          : route.props) ?? {},
    };
  }

  // Creating the dir
  await mkdir(build.cache, { recursive: true });

  const stats = {
    version: "0.0.0",
    hono: "0.0.0",
    collections: config.collections.length,
    plugins: config.plugins.length,
    routes: 0,
  };

  try {
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf-8"),
    );
    stats.version = getPackageVersion(pkg, "honohub");
    stats.hono = getPackageVersion(pkg, "hono");
  } catch (e) {
    console.error("Failed to read package.json", e);
  }

  await Promise.all([
    // HTML file
    writeFile(
      join(process.cwd(), build.cache, "./index.html"),
      htmlTemplateCode,
      {
        flag: "w+",
      },
    ),
    // Component file
    writeFile(
      join(process.cwd(), build.cache, "./main.jsx"),
      refinePluginImports(
        jsTemplateCode({
          importStatement: override,
          props: {
            basePath,
            serverUrl: config.serverUrl,
            plugins: pluginProps,
            stats,
            collections: config.collections.map((collection) => {
              const columns = getTableColumns(collection.schema);

              const fieldMap: Record<
                string,
                {
                  name: string;
                  label: string;
                  type: string;
                  required: boolean;
                }
              > = {};

              for (const [key, column] of Object.entries(columns)) {
                const { name, notNull, dataType } = column as any;

                fieldMap[name] = {
                  name: key,
                  label: name,
                  type: dataType,
                  required: notNull,
                };
              }

              const collectionColumns =
                collection.admin.columns?.map((col: any) => {
                  let tmp: ValueOf<typeof fieldMap>;
                  if (typeof col === "string") tmp = fieldMap[String(col)];
                  tmp = { ...fieldMap[String(col.name)], ...col };

                  return {
                    name: tmp.name,
                    label: tmp.label,
                    type: tmp.type,
                  };
                }) ?? Object.values(fieldMap);

              const fields =
                collection.admin.fields?.map((col: any) => {
                  if (typeof col === "string") return fieldMap[String(col)];
                  return { ...fieldMap[String(col.name)], ...col };
                }) ?? Object.values(fieldMap);

              return {
                slug: collection.slug,
                label:
                  collection.admin.label ?? getTableName(collection.schema),
                columns: collectionColumns,
                fields: fields,
                actions: Array.isArray(collection.admin.actions)
                  ? collection.admin.actions.map(
                      ({ action, ...props }) => props,
                    )
                  : [],
              };
            }),
          },
        }),
        pluginProps,
      ),
      {
        flag: "w+",
      },
    ),
  ]);
}

type JSTemplateProps = {
  importStatement?: string;
  props: HonoHub;
};

const jsTemplateCode = ({
  props,
  importStatement = 'import {HonoHub} from "@honohub/react";import "@honohub/react/index.esm.css";',
}: JSTemplateProps) =>
  `import React from "react";import ReactDOM from "react-dom/client";${importStatement};const props=${JSON.stringify(
    props,
  )};ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><HonoHub {...props} /></React.StrictMode>);`;

const htmlTemplateCode = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>HonoHub</title></head><body><div id="root" ></div><script type="module" src="./main.jsx"></script></body></html>`;

function getPackageVersion(pkgJson: any, pkgName: string) {
  const version =
    pkgJson.dependencies?.[pkgName] ??
    pkgJson.devDependencies?.[pkgName] ??
    pkgJson.peerDependencies?.[pkgName] ??
    "0.0.0";

  return version.replace(/^[\^~]/, "");
}

function refinePluginImports(template: string, plugins: Record<string, any>) {
  let refinedTemplate = template;

  for (const plugin of Object.values(plugins)) {
    const startIndex = refinedTemplate.indexOf(`"${plugin.import}"`);

    if (startIndex === -1) continue;

    refinedTemplate =
      refinedTemplate.slice(0, startIndex) +
      plugin.import +
      refinedTemplate.slice(startIndex + plugin.import.length + 2);
  }

  return refinedTemplate;
}
