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

/** Build the flat (AllDimensions) data URL for a dataset. */
export function buildUrl(dataset, { key, startPeriod, endPeriod } = {}) {
  const url = new URL(
    `${BASE_URL}/data/${dataset.agency},${dataset.id},${dataset.version}/${key ?? dataset.key}`
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
        "Blocked by Cloudflare (HTTP 403), not by the API itself. This server's " +
          "outbound IP needs to be allowlisted by FCSC before requests will get through.",
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
export function flattenObservations(payload, limit) {
  const root = payload.data ?? payload;
  const structure = payload.structure ?? root.structures?.[0] ?? root.structure;
  const dataSet = (root.dataSets ?? payload.dataSets ?? [])[0];

  if (!structure || !dataSet?.observations) {
    throw new FcscError("Unexpected SDMX-JSON payload: no observations found.");
  }

  const dimensions = structure.dimensions?.observation ?? [];
  const obsAttributes = structure.attributes?.observation ?? [];
  const entries = Object.entries(dataSet.observations);

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
 * Summarise an SDMX structure message as dimensions in key order, each with a
 * sample of its codelist. `references=all` pulls in every codelist, which can
 * run to hundreds of kilobytes — far too much to hand back verbatim.
 */
export function summariseStructure(payload, { maxCodes = 12 } = {}) {
  const root = payload.data ?? payload;
  const dsd = (root.dataStructures ?? [])[0];
  if (!dsd) return null;

  const codelists = new Map(
    (root.codelists ?? []).map((cl) => [`${cl.agencyID}:${cl.id}`, cl])
  );

  const components = dsd.dataStructureComponents ?? {};
  const dimensions = [
    ...(components.dimensionList?.dimensions ?? []),
    ...(components.dimensionList?.timeDimensions ?? []),
  ].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  return dimensions.map((dim) => {
    // Enumerations arrive as URNs like "urn:…Codelist=FCSA:CL_FREQ(1.0)".
    const urn = dim.localRepresentation?.enumeration ?? "";
    const ref = urn.match(/Codelist=([^:]+):([^(]+)/);
    const codelist = ref ? codelists.get(`${ref[1]}:${ref[2]}`) : null;
    const codes = codelist?.codes ?? [];
    return {
      id: dim.id,
      name: dim.name ?? dim.id,
      position: dim.position ?? null,
      codelistId: codelist?.id ?? null,
      totalCodes: codes.length,
      codes: codes.slice(0, maxCodes).map((c) => `${c.id} (${c.name ?? ""})`.trim()),
    };
  });
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
