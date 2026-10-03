// E-C3 代码流水线：校验跨度、类型覆盖、自问自答合并、术语校正（护栏 v2）、引用、模板渲染。不调用模型。
import { lev, low } from '../ea2/common.mts';
export type Raw = { items?: any[]; replacements?: any[]; anchors?: any[] };
export type Item = { id: number; unit: number; type: string; span: string; answers: number | null; overridden?: boolean; answeredBy?: number; repaired?: { from: string; to: string }[] };
export const TYPES = ['事实', '问题', '探路', '假设', '决定', '约束'];
const keep = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
export function squash(s: string) { let out = ''; const idx: number[] = []; for (let i = 0; i < s.length; i++) if (keep(s[i])) { out += s[i].toLowerCase(); idx.push(i); } return { out, idx }; }
/** span 是否是 transcript 的（忽略空白与标点的）子串；是则返回 transcript 里的原文片段。 */
export function verbatim(transcript: string, span: string): string | null {
  const T = squash(transcript), S = squash(span).out; if (S.length < 2) return null; const at = T.out.indexOf(S); if (at < 0) return null;
  let end = T.idx[at + S.length - 1] + 1; let k = 0; while (end < transcript.length && !keep(transcript[end]) && !/\s/.test(transcript[end]) && k < 3) { end++; k++; } // 带上紧随其后的标点（如问号）
  return transcript.slice(T.idx[at], end);
}
const QEND = /[？?]\s*$|[吗吧呢]\s*$/;
export function cleanItems(raw: Raw, transcripts: Record<number, string>) {
  const out: Item[] = []; let dropped = 0, overridden = 0;
  for (const r of raw.items ?? []) {
    const unit = Number(r?.unit), id = Number(r?.id); if (!Number.isInteger(unit) || !Number.isInteger(id) || !transcripts[unit] || !TYPES.includes(String(r?.type)) || typeof r?.span !== 'string') { dropped++; continue; }
    const v = verbatim(transcripts[unit], r.span); if (!v) { dropped++; continue; }
    const it: Item = { id, unit, type: String(r.type), span: v, answers: Number.isInteger(Number(r.answers)) && r.answers !== null ? Number(r.answers) : null };
    if ((it.type === '事实' || it.type === '决定') && QEND.test(it.span)) { it.type = '假设'; it.overridden = true; overridden++; }
    out.push(it);
  }
  // 自问自答：answers 指向更早的问题/探路
  for (const b of out) if (b.answers !== null) { const a = out.find((x) => x.id === b.answers); if (a && (a.type === '问题' || a.type === '探路') && (a.unit < b.unit || (a.unit === b.unit && a.id < b.id))) a.answeredBy = b.id; }
  return { items: out, dropped, overridden };
}
const TOK = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/g;
export function guardReplacements(items: Item[], reps: any[], ctx: string) {
  const accepted: { from: string; to: string }[] = [], rejected: { from: string; to: string; why: string }[] = []; const lc = ctx.toLowerCase(); const ctxToks = [...new Set(ctx.match(TOK) ?? [])];
  for (const r of reps ?? []) {
    const from = typeof r?.from === 'string' ? r.from.replace(/^`|`$/g, '') : '', to = typeof r?.to === 'string' ? r.to.replace(/^`|`$/g, '') : '';
    const lf = low(from), lt = low(to); const dist = lf && lt ? lev(lf, lt) / Math.max(lf.length, lt.length) : 1;
    const why = !from || !to ? 'shape' : !items.some((i) => i.span.includes(from)) ? 'from-not-substring' : lc.includes(from.toLowerCase()) ? 'from-in-context' : !ctx.includes(to) ? 'to-not-in-context' : dist > 0.5 ? 'too-far'
      : !/[A-Za-z]/.test(from) || !/[A-Za-z]/.test(to) ? 'not-latin' : (to.match(/\//g) ?? []).length > (from.match(/\//g) ?? []).length || (!to.includes('*') && from.includes('*')) ? 'concretizes'
      : ctxToks.filter((t) => { const l = low(t); return l && lev(lf, l) / Math.max(lf.length, l.length) <= 0.5; }).length >= 2 ? 'ambiguous' : '';
    if (why) rejected.push({ from, to, why }); else { accepted.push({ from, to }); for (const i of items) if (i.span.includes(from)) { i.span = i.span.split(from).join(to); (i.repaired ??= []).push({ from, to }); } }
  }
  return { accepted, rejected };
}
const REF = /(那个|这个|那条|这条|刚才|上面|你说的|你提到|第[一二三四五六七八九十0-9]+(个|种|点|条|项)|方案\s*[A-Za-z0-9])/;
export function acceptAnchors(anchors: any[], transcripts: Record<number, string>, ctxLines: string[]) {
  const ok: { unit: number; text: string; lines: number[] }[] = [], rej: string[] = [];
  for (const a of anchors ?? []) { const unit = Number(a?.unit); const lines: number[] = Array.isArray(a?.lines) ? a.lines.map(Number) : [];
    if (!transcripts[unit] || !REF.test(transcripts[unit])) { rej.push('no-reference-marker'); continue; }
    const s = [...new Set(lines)].sort((x, y) => x - y); if (!s.length || s.length > 5 || !s.every((x, i) => Number.isInteger(x) && x >= 1 && x <= ctxLines.length && (i === 0 || x === s[i - 1] + 1))) { rej.push('bad-lines'); continue; }
    ok.push({ unit, lines: s, text: s.map((n) => ctxLines[n - 1]).join('\n') }); }
  return { ok, rej };
}
const strip = (s: string) => s.replace(/[？?。.\s]+$/, '').trim();
export function render(items: Item[], anchors: { unit: number; text: string }[]) {
  const lines: string[] = []; const prov: number[][] = []; const live = items.filter((i) => !i.answeredBy);
  for (let k = 0; k < live.length; k++) { const it = live[k];
    if (it.type === '探路') { const grp = [it]; while (k + 1 < live.length && live[k + 1].type === '探路') grp.push(live[++k]); lines.push(`请检查/查明：${grp.map((g) => strip(g.span)).join('；')}`); prov.push(grp.map((g) => g.unit)); continue; }
    const t = strip(it.span);
    lines.push(it.type === '事实' ? `已知：${t}` : it.type === '问题' ? `请检查/查明：${t}` : it.type === '假设' ? `我的判断（假设）：${t}，请检验` : it.type === '决定' ? `已决定：${t}` : `约束：${t}`); prov.push([it.unit]);
    for (const a of anchors.filter((x) => x.unit === it.unit && !lines.includes(`> 引用：${x.text}`))) lines.push(`> 引用：${a.text.replace(/\n/g, '\n> ')}`); }
  return { prompt: lines.join('\n'), prov };
}
export function run(raw: Raw, transcripts: Record<number, string>, ctx: string, useCtx: boolean) {
  const c = cleanItems(raw, transcripts); const ctxLines = ctx.split('\n').filter((l) => l.trim());
  const rep = useCtx ? guardReplacements(c.items, raw.replacements ?? [], ctx) : { accepted: [], rejected: [] as any[] }; const anc = useCtx ? acceptAnchors(raw.anchors ?? [], transcripts, ctxLines) : { ok: [], rej: [] as string[] };
  const r = render(c.items, anc.ok); return { items: c.items, dropped: c.dropped, overridden: c.overridden, replacements: rep, anchors: anc, prompt: r.prompt };
}
