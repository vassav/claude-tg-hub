// AskUserQuestion helpers, shared by headless.mjs / interposer.mjs / hub.mjs.
// The engine offers AskUserQuestion as an ORDINARY can_use_tool (with
// requires_user_interaction:true) and the choices live inside input.questions —
// there is no options field on the wire. The ONLY channel for the user's pick is
// updatedInput.answers: { [question text]: "label" | "l1, l2" }. The tool itself
// asks nothing; its call() reads answers straight out of its own input.
const S = v => (typeof v === 'string' ? v : '');

// Normalize an AskUserQuestion input, or null if it isn't a usable ask (wrong tool /
// malformed / outside the 1..4 questions x 2..4 options contract) → caller falls back
// to plain Allow/Deny.
export function askOf(tool, input) {
  if (tool !== 'AskUserQuestion') return null;
  const qs = Array.isArray(input?.questions) ? input.questions : null;
  if (!qs || !qs.length || qs.length > 4) return null;
  const out = [];
  for (const q of qs) {
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (!S(q?.question) || opts.length < 2 || opts.length > 4) return null;
    out.push({
      question: S(q.question), header: S(q.header).slice(0, 12), multiSelect: !!q.multiSelect,
      options: opts.map(o => ({ label: S(o?.label), description: S(o?.description) })),
    });
  }
  return { questions: out };
}

// picks[qi] = indices of the options chosen for question qi. Indices survive the hub
// round-trip: askOf preserves order/arity 1:1, so they still address the ORIGINAL input
// — which is where we read the labels from, so the key (question text) and the value
// (label) match the tool's own input byte-for-byte. Never round-trip that text through
// Telegram's render (escape/truncate would silently break the match).
export function buildAnswers(input, picks) {
  const answers = {};
  (Array.isArray(input?.questions) ? input.questions : []).forEach((q, qi) => {
    const labels = (picks?.[qi] || []).map(oi => q?.options?.[oi]?.label).filter(l => S(l));
    if (labels.length) answers[S(q?.question)] = labels.join(', ');
  });
  return { ...input, answers };
}
