import { z } from "zod";

export const ARTIFACT_LIMITS = Object.freeze({
  blocks: 8,
  metrics: 8,
  tableRows: 30,
  tableColumns: 8,
  listItems: 16,
  keyValues: 20,
  links: 12,
  cards: 16,
  cardLinks: 4,
  chartSeries: 4,
  chartPoints: 60,
});

const title = z.string().max(120).nullable().describe("Short optional section heading; use null when unnecessary");
const tone = z.enum(["neutral", "positive", "negative", "warning"]);
const httpUrl = z.string().regex(/^https?:\/\/[^\s]+$/i);

const metricsBlock = z.object({
  type: z.literal("metrics"),
  title,
  items: z.array(z.object({
    label: z.string().max(80),
    value: z.string().max(120),
    detail: z.string().max(180).nullable(),
    tone,
  }).strict()).min(1).max(ARTIFACT_LIMITS.metrics),
}).strict();

const tableBlock = z.object({
  type: z.literal("table"),
  title,
  columns: z.array(z.string().max(80)).min(1).max(ARTIFACT_LIMITS.tableColumns),
  rows: z.array(z.array(z.string().max(240)).min(1).max(ARTIFACT_LIMITS.tableColumns)).max(ARTIFACT_LIMITS.tableRows),
}).strict();

const listBlock = z.object({
  type: z.literal("list"),
  title,
  items: z.array(z.object({
    title: z.string().max(160),
    detail: z.string().max(360).nullable(),
    tag: z.string().max(40).nullable(),
    tone,
  }).strict()).min(1).max(ARTIFACT_LIMITS.listItems),
}).strict();

const keyValueBlock = z.object({
  type: z.literal("key_value"),
  title,
  items: z.array(z.object({
    label: z.string().max(100),
    value: z.string().max(300),
  }).strict()).min(1).max(ARTIFACT_LIMITS.keyValues),
}).strict();

const textBlock = z.object({
  type: z.literal("text"),
  title,
  body: z.string().max(1_200),
  tone,
}).strict();

const linksBlock = z.object({
  type: z.literal("links"),
  title,
  items: z.array(z.object({
    label: z.string().max(160),
    url: httpUrl,
    detail: z.string().max(240).nullable(),
  }).strict()).min(1).max(ARTIFACT_LIMITS.links),
}).strict();

const cardsBlock = z.object({
  type: z.literal("cards"),
  title,
  items: z.array(z.object({
    title: z.string().max(160),
    subtitle: z.string().max(160).nullable(),
    detail: z.string().max(500).nullable(),
    imageUrl: httpUrl.nullable(),
    links: z.array(z.object({
      label: z.string().max(80),
      url: z.string().regex(/^(?:https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/i),
    }).strict()).max(ARTIFACT_LIMITS.cardLinks),
  }).strict()).min(1).max(ARTIFACT_LIMITS.cards),
}).strict();

const chartBlock = z.object({
  type: z.literal("chart"),
  title,
  chartType: z.enum(["line", "bar"]),
  xLabel: z.string().max(80).nullable(),
  yLabel: z.string().max(80).nullable(),
  series: z.array(z.object({
    name: z.string().max(80),
    tone,
    points: z.array(z.object({
      label: z.string().max(80),
      value: z.number().finite(),
    }).strict()).min(1).max(ARTIFACT_LIMITS.chartPoints),
  }).strict()).min(1).max(ARTIFACT_LIMITS.chartSeries).describe("Series should use the same ordered point labels so they share one x-axis"),
}).strict();

export const artifactBlockSchema = z.discriminatedUnion("type", [
  metricsBlock,
  tableBlock,
  listBlock,
  keyValueBlock,
  textBlock,
  linksBlock,
  cardsBlock,
  chartBlock,
]);

export const artifactSpecSchema = z.object({
  title: z.string().min(1).max(120).describe("Concise title describing the returned data"),
  subtitle: z.string().max(220).nullable().describe("One-line context or null"),
  source: z.string().max(120).nullable().describe("Name of the real tool or data source, or null"),
  blocks: z.array(artifactBlockSchema).min(1).max(ARTIFACT_LIMITS.blocks),
}).strict();
