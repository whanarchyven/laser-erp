/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as http from "../http.js";
import type * as jobFiles from "../jobFiles.js";
import type * as jobs from "../jobs.js";
import type * as lib_cad from "../lib/cad.js";
import type * as lib_cypcutLog from "../lib/cypcutLog.js";
import type * as lib_lxdsGeometry from "../lib/lxdsGeometry.js";
import type * as lib_parseLxds from "../lib/parseLxds.js";
import type * as lib_progress from "../lib/progress.js";
import type * as lib_rates from "../lib/rates.js";
import type * as lib_sheetNames from "../lib/sheetNames.js";
import type * as lib_sheets from "../lib/sheets.js";
import type * as lib_timing from "../lib/timing.js";
import type * as nomenclature from "../nomenclature.js";
import type * as presets from "../presets.js";
import type * as stand from "../stand.js";
import type * as wipe from "../wipe.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  http: typeof http;
  jobFiles: typeof jobFiles;
  jobs: typeof jobs;
  "lib/cad": typeof lib_cad;
  "lib/cypcutLog": typeof lib_cypcutLog;
  "lib/lxdsGeometry": typeof lib_lxdsGeometry;
  "lib/parseLxds": typeof lib_parseLxds;
  "lib/progress": typeof lib_progress;
  "lib/rates": typeof lib_rates;
  "lib/sheetNames": typeof lib_sheetNames;
  "lib/sheets": typeof lib_sheets;
  "lib/timing": typeof lib_timing;
  nomenclature: typeof nomenclature;
  presets: typeof presets;
  stand: typeof stand;
  wipe: typeof wipe;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
