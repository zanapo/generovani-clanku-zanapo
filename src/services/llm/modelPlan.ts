import type { ManualStage } from "../agents/stages.js";

export type ModelPlanKey = ManualStage | "topic_ideas";

type ModelPlanItem = {
  model: string;
  note: string;
  estimatedCostUsd: string;
};

export const AVAILABLE_MODELS = [
  { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", costHint: "nejlevnější, nižší kvalita" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", costHint: "levný, dobrý poměr cena/výkon" },
  { id: "gpt-4.1", label: "GPT-4.1", costHint: "nejlepší kvalita, vyšší cena" }
] as const;

export const MODEL_PLAN: Record<ModelPlanKey, ModelPlanItem> = {
  topic_ideas: {
    model: process.env.OPENAI_MODEL_TOPIC_IDEAS ?? "gpt-4.1-nano",
    note: "rychlý brainstorming témat",
    estimatedCostUsd: "~$0.001-0.005"
  },
  deep_research: {
    model: process.env.OPENAI_MODEL_DEEP_RESEARCH ?? "gpt-4.1",
    note: "nejvyšší kvalita pro výzkum",
    estimatedCostUsd: "~$0.02-0.09"
  },
  outline_planner: {
    model: process.env.OPENAI_MODEL_OUTLINE ?? "gpt-4.1-mini",
    note: "struktura a logika osnovy",
    estimatedCostUsd: "~$0.003-0.015"
  },
  content_writer: {
    model: process.env.OPENAI_MODEL_WRITER ?? "gpt-4.1",
    note: "hlavní kvalita textu",
    estimatedCostUsd: "~$0.03-0.12"
  },
  seo_editor: {
    model: process.env.OPENAI_MODEL_SEO_EDITOR ?? "gpt-4.1",
    note: "čitelnost + SEO + konverze",
    estimatedCostUsd: "~$0.02-0.08"
  },
  html_validator: {
    model: process.env.OPENAI_MODEL_HTML_VALIDATOR ?? "gpt-4.1-mini",
    note: "kontrola struktury a HTML",
    estimatedCostUsd: "~$0.002-0.01"
  },
  final_packager: {
    model: process.env.OPENAI_MODEL_FINAL_PACKAGER ?? "gpt-4.1-mini",
    note: "finální sjednocení výstupu",
    estimatedCostUsd: "~$0.002-0.01"
  }
};

export function resolveModelForStage(stage: ModelPlanKey): string {
  return MODEL_PLAN[stage].model;
}
