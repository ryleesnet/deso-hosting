/** Build a stable document id candidate from display label (Firestore `os_templates`). */
export function suggestHostedTemplateDocId(label: string): string {
  let s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 62);
  if (!s.length) return `tpl_${Date.now().toString(36)}`;
  // Must start with a letter (PROFILE_ID convention)
  if (!/^[a-z]/i.test(s)) {
    s = `t_${s}`.slice(0, 63);
  }
  return s.slice(0, 63).toLowerCase();
}
