export const MANUAL_STAGES = [
  "deep_research",
  "outline_planner",
  "content_writer",
  "seo_editor",
  "html_validator",
  "final_packager"
] as const;

export type ManualStage = (typeof MANUAL_STAGES)[number];

export function isManualStage(value: string): value is ManualStage {
  return MANUAL_STAGES.includes(value as ManualStage);
}
