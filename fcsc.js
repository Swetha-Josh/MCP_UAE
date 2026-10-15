import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("./datasets.json", import.meta.url), "utf8")
);

export const BASE_URL = process.env.FCSC_BASE_URL ?? manifest.baseUrl;
export const datasets = manifest.datasets;

const byId = new Map(datasets.map((d) => [d.id.toUpperCase(), d]));

export function findDataset(id) {
  return byId.get(String(id).toUpperCase()) ?? null;
}

/**
 * The NSI web service serves SDMX-ML by default, so we negotiate explicitly.
 * SDMX-JSON first (structured, easy to summarise); SDMX-CSV as a fallback for
 * dataflows the service won't render as JSON.
 */
const ACCEPT = {
  data:
    "application/vnd.sdmx.data+json;version=1.0.0-wd, " +
    "application/vnd.sdmx.data+csv;version=1.0.0;q=0.9",
  // Structure queries are a different media type entirely — asking for the data
  // flavour on /dataflow/ gets a 406 from the NSI service.
  structure: "application/vnd.sdmx.structure+json;version=1.0.0, application/json;q=0.9",
};

/**
 * Cloudflare's WAF in front of FCSC rejects any path containing three or more
 * consecutive dots (403 "Attention Required") as path traversal — and SDMX keys
 * like ".A..............." are exactly that. Such keys are fetched as "all" and
 * the selection is applied locally by flattenObservations instead.
 */
const isBlockedKey = (key) => /\.{3}/.test(key);

/** Build the flat (AllDimensions) data URL for a dataset. */
export function buildUrl(dataset, { key, startPeriod, endPeriod } = {}) {
  const requested = key ?? dataset.key;
  const pathKey = isBlockedKey(requested) ? "all" : requested;
  const url = new URL(
    `${BASE_URL}/data/${dataset.agency},${dataset.id},${dataset.version}/${pathKey}`
  );
  const start = startPeriod ?? dataset.defaultStartPeriod;
  if (start) url.searchParams.set("startPeriod", start);
  if (endPeriod) url.searchParams.set("endPeriod", endPeriod);
  url.searchParams.set("dimensionAtObservation", "AllDimensions");
  return url.toString();
}

export class FcscError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

export async function fetchSdmx(url, { timeoutMs = 30_000, flavour = "data" } = {}) {
  // Node's fetch sends "Accept-Language: *" by default, and the NSI service fails
  // SDMX-JSON requests carrying "*" with a bare "languageTag1" error. curl sends
  // no Accept-Language and gets the SDMX-ML default, so it never hits this.
  const headers = { Accept: ACCEPT[flavour], "Accept-Language": "en" };
  if (process.env.FCSC_API_KEY) {
    headers["Ocp-Apim-Subscription-Key"] = process.env.FCSC_API_KEY;
  }

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const reason = cause.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : cause.message;
    throw new FcscError(`Could not reach the FCSC statistics service (${reason}).`, { url });
  }

  const body = await response.text();

  if (!response.ok) {
    // Cloudflare fronts this host and rejects datacenter IPs outright. That
    // failure looks nothing like an API error, so name it precisely.
    if (response.status === 403 && /cloudflare|attention required/i.test(body)) {
      throw new FcscError(
        "Blocked by Cloudflare (HTTP 403), not by the API itself — either this " +
          "server's outbound IP is not allowlisted or the URL tripped a WAF rule. " +
          `Cloudflare Ray ID: ${response.headers.get("cf-ray") ?? "unknown"}.`,
        { status: 403, url }
      );
    }
    throw new FcscError(
      `FCSC returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      { status: response.status, url }
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return { kind: "json", payload: JSON.parse(body) };
  }
  if (contentType.includes("csv")) {
    return { kind: "csv", payload: body };
  }
  // Content negotiation was ignored and we got SDMX-ML back.
  return { kind: "xml", payload: body };
}

/**
 * Flatten an SDMX-JSON message into labelled rows.
 * Handles both the 1.0 shape (top-level `structure`/`dataSets`) and the 2.0
 * shape (`data.structures[0]`/`data.dataSets`).
 */
export function flattenObservations(payload, limit, key) {
  const root = payload.data ?? payload;
  const structure = payload.structure ?? root.structures?.[0] ?? root.structure;
  const dataSet = (root.dataSets ?? payload.dataSets ?? [])[0];

  if (!structure || !dataSet?.observations) {
    throw new FcscError("Unexpected SDMX-JSON payload: no observations found.");
  }

  const dimensions = structure.dimensions?.observation ?? [];
  const obsAttributes = structure.attributes?.observation ?? [];
  let entries = Object.entries(dataSet.observations);

  // A key buildUrl fetched as "all" still has to be honoured: keep only the
  // observations whose code matches each non-empty key segment ("A", "A+Q").
  if (key && isBlockedKey(key)) {
    const seriesDims = dimensions.filter((dim) => dim.id !== "TIME_PERIOD");
    const filters = key.split(".").flatMap((segment, position) => {
      if (!segment) return [];
      const dim = dimensions.find((d) => d.keyPosition === position) ?? seriesDims[position];
      const index = dimensions.indexOf(dim);
      return index === -1 ? [] : [{ index, codes: new Set(segment.split("+")) }];
    });
    entries = entries.filter(([obsKey]) => {
      const indices = obsKey.split(":").map(Number);
      return filters.every(({ index, codes }) =>
        codes.has(dimensions[index].values[indices[index]]?.id)
      );
    });
  }

  const rows = entries.slice(0, limit).map(([key, values]) => {
    const indices = key.split(":").map(Number);
    const row = {};
    dimensions.forEach((dim, i) => {
      const value = dim.values[indices[i]];
      row[dim.name ?? dim.id] = value?.name ?? value?.id ?? null;
    });
    row.value = values[0];
    obsAttributes.forEach((attr, i) => {
      const value = attr.values?.[values[i + 1]];
      if (value) row[attr.name ?? attr.id] = value.name ?? value.id;
    });
    return row;
  });

  return { rows, total: entries.length };
}

/**
 * Read a dataset's dimensions from a one-observation data query.
 *
 * FCSC's /dataflow endpoint answers JSON requests with the dataflow alone (no
 * DSD, no codelists, references=all ignored) and refuses structure+json 2.0, so
 * a structure query can't describe the key. The SDMX-JSON data message carries
 * every dimension with its key position and labelled codes, so ask for that.
 * Codes listed are the ones the dataset actually uses.
 */
export async function fetchDimensions(dataset, { maxCodes = 12 } = {}) {
  const base = buildUrl(dataset, { key: "all" });
  let url = `${base}&lastNObservations=1`;
  let result;
  try {
    result = await fetchSdmx(url);
  } catch (error) {
    // Retry without lastNObservations in case the service rejects it; a
    // Cloudflare block or network failure would only fail again.
    if (!(error instanceof FcscError) || !error.status || error.status === 403) throw error;
    url = base;
    result = await fetchSdmx(url);
  }

  const root = result.kind === "json" ? result.payload.data ?? result.payload : null;
  const structure = root && (result.payload.structure ?? root.structures?.[0] ?? root.structure);
  const observed = structure?.dimensions?.observation;
  if (!observed) return { url, kind: result.kind, dimensions: null };

  const dimensions = observed
    .filter((dim) => dim.id !== "TIME_PERIOD")
    .map((dim, index) => {
      const values = dim.values ?? [];
      return {
        id: dim.id,
        name: dim.name ?? dim.id,
        position: dim.keyPosition ?? index,
        totalCodes: values.length,
        codes: values.slice(0, maxCodes).map((v) => `${v.id} (${v.name ?? ""})`),
      };
    })
    .sort((a, b) => a.position - b.position);

  return { url, kind: result.kind, dimensions };
}

/** Render rows as a compact pipe table — cheaper to read than JSON. */
export function toTable(rows) {
  if (rows.length === 0) return "(no observations)";
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = (row, col) => String(row[col] ?? "");
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cell(row, col).length))
  );
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  return [
    line(columns),
    widths.map((w) => "-".repeat(w)).join("-+-"),
    ...rows.map((row) => line(columns.map((col) => cell(row, col)))),
  ].join("\n");
}
