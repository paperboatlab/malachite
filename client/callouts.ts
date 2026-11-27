// The callout kinds (Obsidian's `> [!tip] Title`, malachite#51): each with its icon (one meaning each, in
// agent-docs rebrand/icons.toml) and its colour role. An alias reads as its kind; an unknown kind as a note.
// Roles, as the rebrand has them: most in ink, a tip or a success in the app's accent, red only for harm and
// failure; a warning stays in ink (REBRAND: red is only for what failed).
import type { IconName } from "@paperboatlab/ui";

export type Role = "ink" | "accent" | "danger";
export type Kind = { kind: string; icon: IconName; role: Role };

const KINDS: [kind: string, icon: IconName, role: Role, aliases: string[]][] = [
  ["note", "note", "ink", []],
  ["abstract", "list-flat", "ink", ["summary", "tldr"]],
  ["info", "info", "ink", []],
  ["todo", "tasklist", "ink", []],
  ["tip", "lightbulb", "accent", ["hint", "important"]],
  ["success", "check", "accent", ["check", "done"]],
  ["question", "comment-unresolved", "ink", ["help", "faq"]],
  ["warning", "warning", "ink", ["caution", "attention"]],
  ["failure", "error", "danger", ["fail", "missing"]],
  ["danger", "flame", "danger", ["error"]],
  ["bug", "bug", "danger", []],
  ["example", "list-unordered", "ink", []],
  ["quote", "quote", "ink", ["cite"]],
];
const BY = new Map<string, Kind>(KINDS.flatMap(([kind, icon, role, aliases]) => [kind, ...aliases].map((a) => [a, { kind, icon, role }] as const)));

/** The kind a callout's type names (any case); a note for one it doesn't know. */
export const calloutKind = (type: string): Kind => BY.get(type.toLowerCase()) ?? BY.get("note")!;
/** Every kind with its aliases, for the docs and the tests. */
export const CALLOUT_KINDS = KINDS.map(([kind, icon, role, aliases]) => ({ kind, icon, role, aliases }));
