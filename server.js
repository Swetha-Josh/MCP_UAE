import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  BASE_URL,
  FcscError,
  buildUrl,
  datasets,
  fetchSdmx,
  findDataset,
  flattenObservations,
  summariseStructure,
  toTable,
} from "./fcsc.js";

const server = new McpServer({
  name: "fcsc-statistics",
  version: "1.0.0",
});

const text = (body) => ({ content: [{ type: "text", text: body }] });
const failure = (body) => ({ content: [{ type: "text", text: body }], isError: true });

/**
 * The catalogue is 50 dataflows, so we expose one generic data tool driven by
 * datasets.json rather than 50 near-identical tools. Claude discovers what
 * exists with listDatasets, then reads it with getDatasetData.
 */

server.registerTool(
  "listDatasets",
  {
    title: "List FCSC datasets",
    description:
      "Lists the official UAE statistics datasets available from FCSC, optionally " +
      "filtered by topic or a free-text search over dataset names and KPIs. " +
      "Use this first to find the datasetId to pass to getDatasetData.",
    inputSchema: {
      topic: z
        .string()
        .optional()
        .describe('Filter by main or sub topic, e.g. "Economy", "Labor Force", "Tourism".'),
      search: z
        .string()
        .optional()
        .describe('Free-text filter over dataset name, KPI and dataflow id, e.g. "unemployment".'),
    },
  },
  async ({ topic, search }) => {
    const needle = search?.toLowerCase();
    const topicNeedle = topic?.toLowerCase();

    const matches = datasets.filter((dataset) => {
      if (topicNeedle) {
        const topics = `${dataset.mainTopic} ${dataset.subTopic}`.toLowerCase();
        if (!topics.includes(topicNeedle)) return false;
      }
      if (needle) {
        const haystack = [dataset.id, dataset.name, ...dataset.kpis].join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    if (matches.length === 0) {
      return text(`No datasets matched. ${datasets.length} datasets are available in total.`);
    }

    const lines = matches.map((dataset) => {
      const kpis = dataset.kpis.length ? ` [KPIs: ${dataset.kpis.join(", ")}]` : "";
      return `${dataset.id} — ${dataset.name} (${dataset.mainTopic} / ${dataset.subTopic}` +
        `, from ${dataset.defaultStartPeriod ?? "n/a"})${kpis}`;
    });

    return text(`${matches.length} of ${datasets.length} datasets:\n\n${lines.join("\n")}`);
  }
);

server.registerTool(
  "getDatasetData",
  {
    title: "Get FCSC dataset observations",
    description:
      "Fetches official observations for one FCSC dataset from the UAE statistics " +
      "SDMX API (flat flavour) and returns them as a labelled table. Always cite " +
      "these figures as official FCSC data.",
    inputSchema: {
      datasetId: z
        .string()
        .describe('Dataflow id from listDatasets, e.g. "DF_NA_ISIC_CON" or "DF_CPI_ANN".'),
      startPeriod: z
        .string()
        .optional()
        .describe('Earliest period, e.g. "2020", "2020-Q1" or "2020-01". Defaults to the dataset default.'),
      endPeriod: z.string().optional().describe("Latest period, same format as startPeriod."),
      key: z
        .string()
        .optional()
        .describe(
          "Advanced: SDMX dimension key overriding the default, dot-separated with " +
            'empty segments meaning "all", e.g. ".A.............".'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum observations to return. Defaults to 100."),
    },
  },
  async ({ datasetId, startPeriod, endPeriod, key, limit }) => {
    const dataset = findDataset(datasetId);
    if (!dataset) {
      const suggestions = datasets
        .filter((d) => d.id.includes(String(datasetId).toUpperCase()))
        .slice(0, 5)
        .map((d) => d.id);
      return failure(
        `Unknown datasetId "${datasetId}". ` +
          (suggestions.length
            ? `Did you mean: ${suggestions.join(", ")}?`
            : "Call listDatasets to see the available ids.")
      );
    }

    const url = buildUrl(dataset, { key, startPeriod, endPeriod });

    let result;
    try {
      result = await fetchSdmx(url);
    } catch (error) {
      if (error instanceof FcscError) return failure(`${error.message}\n\nRequested: ${url}`);
      throw error;
    }

    const header =
      `${dataset.name} (${dataset.id} v${dataset.version})\n` +
      `Source: FCSC — ${dataset.mainTopic} / ${dataset.subTopic}\n${url}\n`;

    if (result.kind === "csv") {
      const lines = result.payload.trim().split("\n");
      const body = lines.slice(0, limit + 1).join("\n");
      const omitted = Math.max(0, lines.length - 1 - limit);
      return text(
        `${header}\n${body}` + (omitted ? `\n\n(${omitted} further rows omitted.)` : "")
      );
    }

    if (result.kind === "xml") {
      return failure(
        `${header}\nThe service returned SDMX-ML instead of JSON or CSV, which this ` +
          "server cannot parse yet. The dataflow may not support JSON output."
      );
    }

    let rows;
    let total;
    try {
      ({ rows, total } = flattenObservations(result.payload, limit));
    } catch (error) {
      if (error instanceof FcscError) return failure(`${error.message}\n\nRequested: ${url}`);
      throw error;
    }

    const omitted = total - rows.length;
    return text(
      `${header}\n${toTable(rows)}` +
        (omitted > 0 ? `\n\nShowing ${rows.length} of ${total} observations.` : "")
    );
  }
);

server.registerTool(
  "getDatasetStructure",
  {
    title: "Get FCSC dataset structure",
    description:
      "Returns the dimensions and codelists for one FCSC dataset. Use this when you " +
      "need to build a filtered `key` for getDatasetData, or to explain what " +
      "breakdowns a dataset offers.",
    inputSchema: {
      datasetId: z.string().describe('Dataflow id from listDatasets, e.g. "DF_CPI_ANN".'),
    },
  },
  async ({ datasetId }) => {
    const dataset = findDataset(datasetId);
    if (!dataset) {
      return failure(`Unknown datasetId "${datasetId}". Call listDatasets to see available ids.`);
    }

    const url =
      `${BASE_URL}/dataflow/${dataset.agency}/${dataset.id}/${dataset.version}?references=all`;

    let result;
    try {
      result = await fetchSdmx(url, { flavour: "structure" });
    } catch (error) {
      if (error instanceof FcscError) return failure(`${error.message}\n\nRequested: ${url}`);
      throw error;
    }

    const header =
      `Structure for ${dataset.name} (${dataset.id} v${dataset.version})\n` +
      `Default key: ${dataset.key}\n${url}\n`;

    const dimensions = result.kind === "json" ? summariseStructure(result.payload) : null;
    if (!dimensions) {
      return failure(
        `${header}\nCould not read the structure message ` +
          `(received ${result.kind}). The service may not support JSON structure queries.`
      );
    }

    const body = dimensions
      .map((dim) => {
        const sample = dim.codes.length
          ? `\n    ${dim.codes.join("\n    ")}` +
            (dim.totalCodes > dim.codes.length
              ? `\n    … ${dim.totalCodes - dim.codes.length} more`
              : "")
          : "";
        const codelist = dim.codelistId ? ` — ${dim.codelistId} (${dim.totalCodes} codes)` : "";
        return `${dim.position ?? "?"}. ${dim.id} — ${dim.name}${codelist}${sample}`;
      })
      .join("\n");

    return text(
      `${header}\nDimensions in key order (a key is these joined by "." ` +
        `with empty segments meaning "all"):\n\n${body}`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the JSON-RPC channel under stdio transport — log to stderr only.
console.error(`✅ FCSC MCP server ready — ${datasets.length} datasets from ${BASE_URL}`);
