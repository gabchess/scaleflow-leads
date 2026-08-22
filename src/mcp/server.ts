/**
 * MCP server for the ScaleFlow lead pipeline.
 *
 * Exposes the pipeline as four tools over stdio so any MCP client can drive
 * qualification. The agent in src/agent/qualify.ts is the first consumer.
 *
 * Honesty note on naming: `scrape_crunchbase` and `scrape_clutch` read the
 * capture files the Playwright scrapers produced. They do not open a browser.
 * Every response carries `captured_at` so the caller can see how old the data
 * is instead of assuming it is live.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scoreLead, type ScoreInput } from "../scoring.js";
import { CompanyTypeSchema, CountrySchema } from "../icp.js";
import { inferCompanyType } from "../pipeline/normalize.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

type RawCompany = {
  name: string;
  domain: string | null;
  country: string | null;
  headquarters: string | null;
  headcount: string | number | null;
  industry: string | null;
  funding: string | null;
  url: string;
  source: string;
  captured_at: string;
};

type SignalRecord = {
  domain: string;
  hiring_signal: boolean;
  post_signal: boolean;
  signal_url?: string;
  captured_at?: string;
};

async function readCapture(file: string): Promise<RawCompany[]> {
  const full = path.join(REPO_ROOT, "data", "raw", file);
  try {
    const parsed: unknown = JSON.parse(await readFile(full, "utf8"));
    return Array.isArray(parsed) ? (parsed as RawCompany[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Crunchbase usually reports headcount as a band. Only the low edge is
 * recoverable, so 101-250 maps to 101 and stays flagged as ambiguous for the
 * caller. A raw number, when present, is used as is. */
function headcountLowEdge(raw: string | number | null): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (!raw) return null;
  const match = /(\d+)/.exec(String(raw));
  return match ? Number(match[1]) : null;
}

function toToolResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const filterShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("max rows to return"),
  country: CountrySchema.optional().describe("restrict to one ICP country"),
  company_type: CompanyTypeSchema.optional().describe(
    "restrict to one ICP company type",
  ),
  max_headcount: z
    .number()
    .int()
    .optional()
    .describe("drop rows whose low edge exceeds this"),
};

function buildCaptureTool(file: string, label: string) {
  return async (args: {
    limit: number;
    country?: string;
    company_type?: string;
    max_headcount?: number;
  }) => {
    const rows = await readCapture(file);
    if (rows.length === 0) {
      return toToolResult({
        source: label,
        available: false,
        note: `data/raw/${file} does not exist yet. Run the ${label} scraper first.`,
        companies: [],
      });
    }

    const enriched = rows.map((row) => ({
      name: row.name,
      domain: row.domain,
      country: row.country,
      headcount_raw: row.headcount,
      headcount_low_edge: headcountLowEdge(row.headcount),
      headcount_ambiguous: String(row.headcount ?? "").includes("101-250"),
      company_type: inferCompanyType(row.industry),
      industry: row.industry,
      funding: row.funding,
      url: row.url,
      captured_at: row.captured_at,
    }));

    const filtered = enriched.filter((row) => {
      if (args.country && row.country !== args.country) return false;
      if (args.company_type && row.company_type !== args.company_type)
        return false;
      if (args.max_headcount != null) {
        if (row.headcount_low_edge == null) return false;
        if (row.headcount_low_edge > args.max_headcount) return false;
      }
      return true;
    });

    return toToolResult({
      source: label,
      available: true,
      total_captured: rows.length,
      matched: filtered.length,
      returned: Math.min(filtered.length, args.limit),
      captured_at: rows[0]?.captured_at ?? null,
      companies: filtered.slice(0, args.limit),
    });
  };
}

const server = new McpServer({ name: "scaleflow-leads", version: "0.1.0" });

server.registerTool(
  "scrape_crunchbase",
  {
    title: "Read the Crunchbase capture",
    description:
      "Returns companies captured from the Crunchbase saved search, with optional ICP filters. Reads data/raw/crunchbase.json produced by the Playwright scraper. Does not open a browser.",
    inputSchema: filterShape,
  },
  buildCaptureTool("crunchbase.json", "crunchbase"),
);

server.registerTool(
  "scrape_clutch",
  {
    title: "Read the Clutch capture",
    description:
      "Returns companies captured from Clutch.co directory listings, with optional ICP filters. Reads data/raw/clutch.json. Reports available:false when the capture does not exist yet, instead of an empty list that would look like a real zero result.",
    inputSchema: filterShape,
  },
  buildCaptureTool("clutch.json", "clutch"),
);

server.registerTool(
  "check_signals",
  {
    title: "Look up intent signals for a domain",
    description:
      "Returns the hiring signal and the post signal for one company domain, from data/raw/signals.json. Returns known:false when the domain has not been checked, which is different from a company that was checked and has no signal.",
    inputSchema: {
      domain: z
        .string()
        .min(3)
        .describe("company domain, lowercase, no www and no protocol"),
    },
  },
  async ({ domain }: { domain: string }) => {
    const full = path.join(REPO_ROOT, "data", "raw", "signals.json");
    let records: SignalRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(full, "utf8"));
      if (Array.isArray(parsed)) records = parsed as SignalRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return toToolResult({
        domain,
        known: false,
        note: "data/raw/signals.json does not exist yet. Run the intent signal step first.",
      });
    }

    const wanted = domain.toLowerCase().replace(/^www\./, "");
    const hit = records.find((r) => r.domain?.toLowerCase() === wanted);
    if (!hit) {
      return toToolResult({
        domain: wanted,
        known: false,
        note: "domain not checked yet",
      });
    }
    return toToolResult({
      domain: wanted,
      known: true,
      hiring_signal: hit.hiring_signal === true,
      post_signal: hit.post_signal === true,
      signal_url: hit.signal_url ?? null,
      signal_type:
        hit.hiring_signal && hit.post_signal
          ? "both"
          : hit.hiring_signal
            ? "hiring"
            : hit.post_signal
              ? "post"
              : "none",
      captured_at: hit.captured_at ?? null,
    });
  },
);

server.registerTool(
  "score_lead",
  {
    title: "Score one lead against the ICP",
    description:
      "Scores a single candidate 0 to 100 against the ICP and returns the reasons and the blockers behind the number. A lead carrying any blocker is never qualified, whatever the score says. This is the tool that makes the decision auditable.",
    inputSchema: {
      name: z.string().min(1),
      domain: z.string().min(3),
      country: z
        .string()
        .describe("two letter country, expects US, UK, CA or AU"),
      headcount: z.number().int().describe("integer headcount, not a band"),
      company_type: z.string().describe("one of the four ICP company types"),
      hiring_signal: z.boolean().default(false),
      post_signal: z.boolean().default(false),
      signal_url: z.string().optional(),
      decision_maker_title: z.string().optional(),
      has_vp_sales: z.boolean().default(false),
      email_status: z
        .string()
        .optional()
        .describe("valid, risky, invalid or unknown"),
    },
  },
  async (args: Record<string, unknown>) => {
    const input: ScoreInput = {
      company: {
        name: args.name as string,
        domain: args.domain as string,
        country: args.country as never,
        headcount: args.headcount as number,
        company_type: args.company_type as never,
      },
      signals: {
        hiring_signal: args.hiring_signal === true,
        post_signal: args.post_signal === true,
        signal_url: args.signal_url as string | undefined,
      },
      decision_maker_title:
        (args.decision_maker_title as string | undefined) ?? null,
      has_vp_sales: args.has_vp_sales === true,
      email_status: (args.email_status as string | undefined) ?? null,
    };
    const result = scoreLead(input);
    return toToolResult({ name: args.name, domain: args.domain, ...result });
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stderr on purpose: stdout carries the MCP wire protocol and must stay clean.
  console.error("scaleflow-leads MCP server ready on stdio (4 tools)");
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
