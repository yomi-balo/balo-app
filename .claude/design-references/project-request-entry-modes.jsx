import { useState, useEffect, useRef } from "react";
import {
  X, Check, ChevronLeft, ChevronDown, Search, Sparkles, Upload, Bold, Italic,
  Heading2, Heading3, List, ListOrdered, Link2, FileText, Image as ImageIcon,
  AlertTriangle, RefreshCw, CheckCircle2, MessageSquare, User, Star,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Design reference — project request panel, entry-point-driven modes  */
/* Tickets: routing-by-entry-point (A) and case → project conversion (B) */
/* Copy in this prototype is illustrative; the tickets' copy wins.      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Mock data                                                           */
/* ------------------------------------------------------------------ */

const EXPERT = {
  name: "Priya Raman",
  first: "Priya",
  initials: "PR",
  headline: "Service Cloud architect, 11 years on the platform",
  certs: ["Application Architect", "Service Cloud Consultant", "Agentforce Specialist"],
};

const CASE = { id: "C-1042", subject: "Omni-Channel routing for priority cases" };

const PROJECT_TYPES = [
  "Implementation", "Integration", "Optimisation", "Data migration",
  "Health check", "Training & enablement", "Managed support",
];

const PRODUCTS = [
  "Sales Cloud", "Service Cloud", "Experience Cloud", "Marketing Cloud", "Data Cloud",
  "Agentforce", "Revenue Cloud (CPQ)", "Field Service", "Tableau", "MuleSoft",
];

const MAX_FILES = 4;
const MAX_MB = 5;

const CASE_FILES = [
  { name: "omni-queue-config.png", size: 1.2, kind: "image", source: "case" },
  { name: "routing-test-results.pdf", size: 3.4, kind: "pdf", source: "case" },
  { name: "call-transcript-14-sep.pdf", size: 0.8, kind: "pdf", source: "case" },
  { name: "full-debug-log.pdf", size: 7.9, kind: "pdf", source: "case" },
];

const MOCK_UPLOADS = [
  { name: "support-team-structure.pdf", size: 1.1, kind: "pdf" },
  { name: "current-queues.png", size: 0.6, kind: "image" },
  { name: "sla-targets.pdf", size: 2.2, kind: "pdf" },
];

const CASE_SUMMARY = `Problem
Priority cases from our enterprise queue aren't reaching senior agents. Omni-Channel routes by queue only, so P1s wait behind routine work during peak hours.

Resolved in the case
- Fixed capacity settings on the Billing and Returns queues
- Confirmed skills-based routing is the right model for our setup

What's left
- Move the remaining three queues to skills-based routing
- Build a Flow that escalates P1 cases after 15 minutes unassigned
- Run UAT with the support leads before go-live

Likely scope
Around 3–4 weeks, including a handover session for our admin.`;

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function Avatar({ initials, size = 40 }) {
  return (
    <div
      className="flex items-center justify-center rounded-full bg-blue-600 text-white font-semibold flex-shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </div>
  );
}

function Chip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-700 text-xs font-medium px-2 py-1">
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="text-slate-400 hover:text-slate-700"
          aria-label={`Remove ${children}`}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

function SectionLabel({ children, optional, hint }) {
  return (
    <div className="mb-2">
      <div className="text-sm font-semibold text-slate-900">
        {children}
        {optional && <span className="font-normal text-slate-500"> (optional)</span>}
      </div>
      {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

function MultiSelect({ placeholder, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const toggle = (o) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  const filtered = options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => setOpen(true)}
        className={`flex flex-wrap items-center gap-1.5 rounded-lg border bg-white px-3 py-2 cursor-text ${
          open ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"
        }`}
        style={{ minHeight: 44 }}
      >
        <Search size={16} className="text-slate-400" />
        {value.map((v) => (
          <Chip key={v} onRemove={() => toggle(v)}>{v}</Chip>
        ))}
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={value.length ? "" : placeholder}
          className="flex-1 min-w-0 text-sm outline-none bg-transparent placeholder-slate-400"
          style={{ minWidth: 80 }}
        />
        <ChevronDown size={16} className="text-slate-400" />
      </div>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg py-1 overflow-auto" style={{ maxHeight: 220 }}>
          {filtered.length === 0 && <div className="px-3 py-2 text-sm text-slate-500">No matches</div>}
          {filtered.map((o) => {
            const on = value.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => toggle(o)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-slate-800 hover:bg-slate-50"
              >
                {o}
                {on && <Check size={15} className="text-blue-600" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recipient blocks                                                    */
/* ------------------------------------------------------------------ */

function ExpertCard({ fromCase, unavailable, onMatchInstead }) {
  return (
    <div className="rounded-xl border border-blue-500 bg-blue-50 p-4">
      <div className="flex items-start gap-3">
        <Avatar initials={EXPERT.initials} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-900">{EXPERT.name}</span>
            {fromCase && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white border border-blue-200 text-blue-700 text-xs font-medium px-1.5 py-0.5">
                <MessageSquare size={11} /> Your expert on {CASE.id}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-600 mt-0.5">{EXPERT.headline}</div>
        </div>
      </div>
      {unavailable && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 flex gap-2.5">
          <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900">
            <div className="font-semibold">{EXPERT.first} isn't taking new projects right now.</div>
            <div className="mt-0.5">Your brief is saved. We can match you with someone with similar experience instead.</div>
            <button
              type="button"
              onClick={onMatchInstead}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1.5 font-medium"
            >
              <Sparkles size={13} /> Get matched instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MatchCard() {
  return (
    <div className="rounded-xl border border-blue-500 bg-blue-50 p-4 flex items-start gap-3">
      <div className="flex items-center justify-center rounded-full bg-white border border-blue-200 text-blue-600 flex-shrink-0" style={{ width: 40, height: 40 }}>
        <Sparkles size={18} />
      </div>
      <div>
        <div className="text-sm font-semibold text-slate-900">Find me an expert</div>
        <div className="text-xs text-slate-600 mt-0.5">We'll match you with the right fit for this work.</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

function Stepper({ current }) {
  const steps = ["Start", "Describe", "Review"];
  return (
    <div className="flex items-center gap-2 text-sm">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className="bg-slate-200" style={{ width: 20, height: 1 }} />}
            <div
              className={`flex items-center justify-center rounded-full text-xs font-semibold ${
                done ? "bg-blue-600 text-white" : active ? "border border-blue-400 bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"
              }`}
              style={{ width: 22, height: 22 }}
            >
              {done ? <Check size={13} strokeWidth={3} /> : i + 1}
            </div>
            <span className={active ? "font-semibold text-slate-900" : "text-slate-500"}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}

function RequestPanel({ entry, unavailable, searchQuery, onClose }) {
  const isCase = entry === "case";
  const isSearch = entry === "search";

  const [step, setStep] = useState("describe");
  const [route, setRoute] = useState(isSearch ? "match" : "direct");
  const [title, setTitle] = useState(
    isSearch ? searchQuery : isCase ? "Skills-based routing rollout for Service Cloud" : ""
  );
  const [body, setBody] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [genCount, setGenCount] = useState(isCase ? 1 : 0);
  const [types, setTypes] = useState(isCase ? ["Optimisation"] : []);
  const [products, setProducts] = useState(isCase ? ["Service Cloud"] : []);
  const [files, setFiles] = useState(
    isCase ? CASE_FILES.map((f) => ({ ...f, selected: f.size <= MAX_MB })) : []
  );
  const [uploadIdx, setUploadIdx] = useState(0);
  const [budgetMin, setBudgetMin] = useState("");
  const [budgetMax, setBudgetMax] = useState("");
  const [timeline, setTimeline] = useState("");

  // Simulated streaming of the AI case summary
  useEffect(() => {
    if (!genCount) return;
    const reduce = typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setBody(CASE_SUMMARY); setStreaming(false); return; }
    setBody("");
    setStreaming(true);
    let i = 0;
    const id = setInterval(() => {
      i += 5;
      setBody(CASE_SUMMARY.slice(0, i));
      if (i >= CASE_SUMMARY.length) { clearInterval(id); setStreaming(false); }
    }, 18);
    return () => clearInterval(id);
  }, [genCount]);

  const direct = route === "direct";
  const blocked = direct && unavailable;
  const selected = files.filter((f) => f.selected);
  const atCap = selected.length >= MAX_FILES;

  const reason = streaming
    ? "Drafting your brief…"
    : blocked
    ? `${EXPERT.first} isn't available`
    : !title.trim()
    ? "Add a project title"
    : !body.trim()
    ? "Describe what you need"
    : null;

  const toggleFile = (name) =>
    setFiles((fs) =>
      fs.map((f) => {
        if (f.name !== name || f.size > MAX_MB) return f;
        if (!f.selected && atCap) return f;
        return { ...f, selected: !f.selected };
      })
    );

  const addUpload = () => {
    if (atCap) return;
    const m = MOCK_UPLOADS[uploadIdx % MOCK_UPLOADS.length];
    const name = uploadIdx >= MOCK_UPLOADS.length ? m.name.replace(".", `-${uploadIdx}.`) : m.name;
    setFiles((fs) => [...fs, { ...m, name, source: "upload", selected: true }]);
    setUploadIdx((n) => n + 1);
  };

  const removeUpload = (name) => setFiles((fs) => fs.filter((f) => f.name !== name));

  const sendLabel = direct ? `Send to ${EXPERT.first}` : "Send for matching";
  const expertWord = direct ? EXPERT.first : "your expert";

  /* ---------------- Sent ---------------- */
  if (step === "sent") {
    return (
      <PanelShell current={3} onClose={onClose}>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16">
          <CheckCircle2 size={44} className="text-blue-600" />
          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            {direct ? `Sent to ${EXPERT.first}` : "Sent for matching"}
          </h2>
          <p className="mt-2 text-sm text-slate-600" style={{ maxWidth: 320 }}>
            {direct
              ? `${EXPERT.first} will review your brief and reply with a proposal. We'll email you when it arrives.`
              : "Our team will review your brief and introduce a matched expert, usually within a day."}
          </p>
          {isCase && (
            <p className="mt-3 text-xs text-slate-500">This project is linked to case {CASE.id}.</p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-6 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Done
          </button>
        </div>
      </PanelShell>
    );
  }

  /* ---------------- Review ---------------- */
  if (step === "review") {
    return (
      <PanelShell current={2} onClose={onClose}
        footer={
          <>
            <button type="button" onClick={() => setStep("describe")}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Back
            </button>
            <button type="button" onClick={() => setStep("sent")}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-sm font-semibold text-white">
              {sendLabel}
            </button>
          </>
        }
      >
        <div className="px-7 py-6 space-y-6">
          <div>
            <SectionLabel>Sending to</SectionLabel>
            {direct ? (
              <div className="flex items-center gap-3">
                <Avatar initials={EXPERT.initials} size={32} />
                <div>
                  <div className="text-sm font-medium text-slate-900">{EXPERT.name}</div>
                  <div className="text-xs text-slate-500">Replies with a proposal</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center rounded-full bg-blue-50 text-blue-600" style={{ width: 32, height: 32 }}>
                  <Sparkles size={15} />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Balo matching</div>
                  <div className="text-xs text-slate-500">A matched expert is introduced, usually within a day</div>
                </div>
              </div>
            )}
          </div>
          <div>
            <SectionLabel>{title}</SectionLabel>
            <div className="text-sm text-slate-700 whitespace-pre-wrap rounded-lg bg-slate-50 border border-slate-100 p-4">{body}</div>
          </div>
          {(types.length > 0 || products.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {[...types, ...products].map((t) => <Chip key={t}>{t}</Chip>)}
            </div>
          )}
          {selected.length > 0 && (
            <div>
              <SectionLabel>Attachments</SectionLabel>
              <ul className="space-y-1.5">
                {selected.map((f) => (
                  <li key={f.name} className="flex items-center gap-2 text-sm text-slate-700">
                    {f.kind === "image" ? <ImageIcon size={15} className="text-slate-400" /> : <FileText size={15} className="text-slate-400" />}
                    {f.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(budgetMin || budgetMax || timeline) && (
            <div className="grid grid-cols-2 gap-4 text-sm">
              {(budgetMin || budgetMax) && (
                <div>
                  <div className="text-xs text-slate-500">Budget</div>
                  <div className="text-slate-900">A${budgetMin || "?"} – A${budgetMax || "?"}</div>
                </div>
              )}
              {timeline && (
                <div>
                  <div className="text-xs text-slate-500">Timeline</div>
                  <div className="text-slate-900">{timeline}</div>
                </div>
              )}
            </div>
          )}
          {isCase && (
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <MessageSquare size={13} /> Linked to case {CASE.id}, {CASE.subject.toLowerCase()}
            </div>
          )}
        </div>
      </PanelShell>
    );
  }

  /* ---------------- Describe ---------------- */
  const intro = direct
    ? `Tell ${EXPERT.first} what you need.`
    : "Tell us what you need and we'll match you with the right expert.";

  return (
    <PanelShell current={1} onClose={onClose}
      footer={
        <>
          <span className="text-xs text-slate-500">{reason || ""}</span>
          <button
            type="button"
            disabled={!!reason}
            onClick={() => setStep("review")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              reason ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            Continue to review
          </button>
        </>
      }
    >
      <div className="px-7 py-6">
        {!isCase && (
          <button type="button" className="flex items-center gap-1 text-sm font-medium text-blue-600 mb-5">
            <ChevronLeft size={16} /> Change entry method
          </button>
        )}
        {isCase && (
          <div className="mb-5 inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
            <MessageSquare size={12} /> Converting case {CASE.id} to a project
          </div>
        )}

        <p className="text-sm text-slate-900 mb-4">{intro}</p>

        {/* Recipient */}
        <div className="mb-2">
          {direct ? (
            <ExpertCard fromCase={isCase} unavailable={unavailable} onMatchInstead={() => setRoute("match")} />
          ) : (
            <MatchCard />
          )}
        </div>
        <div className="text-xs text-slate-500 mb-1">
          {direct
            ? `${EXPERT.first} will review your brief and reply with a proposal.`
            : "Our team reviews your brief and introduces a matched expert, usually within a day."}
        </div>
        {!isSearch && !(direct && unavailable) && (
          <button
            type="button"
            onClick={() => setRoute(direct ? "match" : "direct")}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {direct ? "Get matched with someone else instead" : `Send to ${EXPERT.first} instead`}
          </button>
        )}

        {/* Title */}
        <div className="mt-6">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project title" className={inputCls} />
          {isSearch && searchQuery && title === searchQuery && (
            <div className="text-xs text-slate-500 mt-1.5">Started from your search. Edit it as needed.</div>
          )}
        </div>

        {/* Description */}
        <div className="mt-6">
          <div className="flex items-end justify-between mb-2 gap-3">
            <div className="text-sm font-semibold text-slate-900">What do you need?</div>
            {isCase && (
              <button
                type="button"
                disabled={streaming}
                onClick={() => setGenCount((n) => n + 1)}
                title="Replaces the current text"
                className={`inline-flex items-center gap-1 text-xs font-medium ${streaming ? "text-slate-300" : "text-blue-600 hover:underline"}`}
              >
                <RefreshCw size={12} /> Redraft from case
              </button>
            )}
          </div>
          <div className={`rounded-lg border bg-white ${streaming ? "border-blue-300" : "border-slate-200"} focus-within:border-blue-500`}>
            <div className="flex items-center gap-1 border-b border-slate-100 bg-slate-50 px-2 py-1.5 rounded-t-lg text-slate-500">
              {[Bold, Italic, null, Heading2, Heading3, null, List, ListOrdered, null, Link2].map((Icon, i) =>
                Icon ? (
                  <button key={i} type="button" className="p-1.5 rounded hover:bg-slate-200"><Icon size={15} /></button>
                ) : (
                  <span key={i} className="bg-slate-200 mx-1" style={{ width: 1, height: 16 }} />
                )
              )}
              {isCase && (
                <span className="ml-auto inline-flex items-center gap-1 rounded bg-blue-50 text-blue-700 text-xs font-medium px-1.5 py-0.5">
                  <Sparkles size={11} /> AI draft
                </span>
              )}
            </div>
            <textarea
              value={body}
              readOnly={streaming}
              onChange={(e) => setBody(e.target.value)}
              rows={isCase ? 14 : 7}
              className="w-full resize-y rounded-b-lg px-3 py-3 text-sm text-slate-800 leading-relaxed outline-none"
              style={{ fontFamily: "inherit" }}
            />
          </div>
          <div className="text-xs text-slate-500 mt-1.5">
            {isCase
              ? streaming
                ? `Summarising your case messages and call transcripts…`
                : "Drafted from your case history. Review and edit it, since it goes out under your name."
              : "Keep it as short as you like. A rough sketch is fine."}
          </div>
        </div>

        {/* Project type */}
        <div className="mt-6">
          <SectionLabel optional hint={isCase ? "Prefilled from your case. Change as needed." : "Pick the categories that best describe this work. It helps us scope it."}>
            Project type
          </SectionLabel>
          <MultiSelect placeholder="Filter project types…" options={PROJECT_TYPES} value={types} onChange={setTypes} />
        </div>

        {/* Products */}
        <div className="mt-6">
          <SectionLabel optional hint={isCase ? "Prefilled from your case. Change as needed." : "Which products does this touch? Same list as expert search."}>
            Salesforce products
          </SectionLabel>
          <MultiSelect placeholder="Filter products…" options={PRODUCTS} value={products} onChange={setProducts} />
        </div>

        {/* Attachments */}
        <div className="mt-6">
          <SectionLabel optional hint={`PDF, PNG, JPEG or WEBP, up to ${MAX_FILES} files, ${MAX_MB} MB each.`}>
            Attach documents
          </SectionLabel>

          {isCase && (
            <div className="mb-3">
              <div className="text-xs font-medium text-slate-700 mb-1.5">From case {CASE.id}</div>
              <ul className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                {files.filter((f) => f.source === "case").map((f) => {
                  const tooBig = f.size > MAX_MB;
                  const lockOut = !f.selected && atCap && !tooBig;
                  return (
                    <li key={f.name}>
                      <label className={`flex items-center gap-3 px-3 py-2.5 text-sm ${tooBig || lockOut ? "text-slate-400" : "text-slate-800 cursor-pointer hover:bg-slate-50"}`}>
                        <input
                          type="checkbox"
                          checked={f.selected}
                          disabled={tooBig || lockOut}
                          onChange={() => toggleFile(f.name)}
                          className="accent-blue-600"
                        />
                        {f.kind === "image" ? <ImageIcon size={15} className="text-slate-400" /> : <FileText size={15} className="text-slate-400" />}
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className={`text-xs ${tooBig ? "text-amber-600" : "text-slate-400"}`}>
                          {tooBig ? `${f.size} MB, over ${MAX_MB} MB` : `${f.size} MB`}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {files.filter((f) => f.source === "upload").length > 0 && (
            <ul className="mb-3 rounded-lg border border-slate-200 divide-y divide-slate-100">
              {files.filter((f) => f.source === "upload").map((f) => (
                <li key={f.name} className="flex items-center gap-3 px-3 py-2.5 text-sm text-slate-800">
                  {f.kind === "image" ? <ImageIcon size={15} className="text-slate-400" /> : <FileText size={15} className="text-slate-400" />}
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-slate-400">{f.size} MB</span>
                  <button type="button" onClick={() => removeUpload(f.name)} className="text-slate-400 hover:text-slate-700" aria-label={`Remove ${f.name}`}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={addUpload}
            disabled={atCap}
            className={`w-full rounded-xl border-2 border-dashed px-4 py-6 text-center ${
              atCap ? "border-slate-200 bg-slate-50 cursor-not-allowed" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50"
            }`}
          >
            <Upload size={18} className={`mx-auto ${atCap ? "text-slate-300" : "text-slate-500"}`} />
            <div className={`mt-2 text-sm font-semibold ${atCap ? "text-slate-400" : "text-slate-900"}`}>
              {atCap ? `You've reached ${MAX_FILES} files` : "Drag files here or browse"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {atCap ? "Deselect or remove one to add another." : `${selected.length} of ${MAX_FILES} files selected`}
            </div>
          </button>
        </div>

        {/* Budget & timeline */}
        <div className="mt-6 mb-2">
          <SectionLabel optional hint={`Helps ${expertWord} scope and price the work.`}>
            Budget & timeline
          </SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600 mb-1 block">Min budget (A$)</label>
              <input inputMode="numeric" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value.replace(/[^0-9]/g, ""))} placeholder="5,000" className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-slate-600 mb-1 block">Max budget (A$)</label>
              <input inputMode="numeric" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value.replace(/[^0-9]/g, ""))} placeholder="15,000" className={inputCls} />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-xs text-slate-600 mb-1 block">Timeline</label>
            <input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="e.g. Go-live by end of Q3" className={inputCls} />
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function PanelShell({ current, onClose, footer, children }) {
  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-7 py-4 border-b border-slate-100">
        <Stepper current={current} />
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
      {footer && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-7 py-4 bg-white">{footer}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Backdrop pages (the three entry points)                             */
/* ------------------------------------------------------------------ */

function SearchPage({ query, setQuery, onOpen }) {
  return (
    <div className="mx-auto px-6 pt-20" style={{ maxWidth: 680 }}>
      <h1 className="text-3xl font-semibold text-slate-900">Find a Salesforce expert</h1>
      <p className="mt-2 text-slate-600">Describe the problem. We'll find the people who've solved it before.</p>
      <div className="mt-6 flex gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <Search size={18} className="text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 outline-none text-sm" />
        </div>
        <button type="button" onClick={onOpen} className="rounded-xl bg-blue-600 hover:bg-blue-700 px-4 text-sm font-semibold text-white">
          Describe your project
        </button>
      </div>
    </div>
  );
}

function ExpertPage({ onOpen }) {
  return (
    <div className="mx-auto px-6 pt-14" style={{ maxWidth: 760 }}>
      <div className="flex items-start gap-5">
        <Avatar initials={EXPERT.initials} size={72} />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-slate-900">{EXPERT.name}</h1>
          <p className="text-slate-600 mt-1">{EXPERT.headline}</p>
          <div className="flex items-center gap-1 mt-2 text-sm text-slate-700">
            <Star size={15} className="text-amber-500" fill="currentColor" /> 4.9 from 38 engagements
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {EXPERT.certs.map((c) => <Chip key={c}>{c}</Chip>)}
          </div>
          <button type="button" onClick={onOpen} className="mt-5 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-sm font-semibold text-white">
            Request a proposal
          </button>
        </div>
      </div>
    </div>
  );
}

function CasePage({ onOpen }) {
  const msgs = [
    { me: true, t: "P1s are still sitting in the enterprise queue behind routine stuff during peak." },
    { me: false, t: "Capacity on Billing and Returns is fixed now. The real answer is skills-based routing across all five queues, plus an escalation Flow." },
    { me: true, t: "That sounds bigger than a quick fix. Can we scope it properly?" },
  ];
  return (
    <div className="mx-auto px-6 pt-10" style={{ maxWidth: 720 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-slate-500">Case {CASE.id}</div>
          <h1 className="text-xl font-semibold text-slate-900">{CASE.subject}</h1>
          <div className="text-sm text-slate-600 mt-1 flex items-center gap-1.5"><User size={14} /> with {EXPERT.name}</div>
        </div>
        <button type="button" onClick={onOpen} className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-sm font-semibold text-white whitespace-nowrap">
          Convert to project
        </button>
      </div>
      <div className="mt-6 space-y-3">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.me ? "justify-end" : "justify-start"}`}>
            <div className={`rounded-2xl px-4 py-2.5 text-sm ${m.me ? "bg-blue-600 text-white" : "bg-white border border-slate-200 text-slate-800"}`} style={{ maxWidth: 420 }}>
              {m.t}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const ENTRIES = [
  { id: "search", label: "Homepage search" },
  { id: "expert", label: "Expert profile" },
  { id: "case", label: "Case" },
];

export default function App() {
  const [entry, setEntry] = useState("expert");
  const [unavailable, setUnavailable] = useState(false);
  const [query, setQuery] = useState("Migrate our CPQ quotes to Revenue Cloud");
  const [open, setOpen] = useState(true);
  const [panelKey, setPanelKey] = useState(0);

  const openPanel = () => { setOpen(true); setPanelKey((k) => k + 1); };
  const switchEntry = (id) => { setEntry(id); openPanel(); };

  return (
    <div className="h-screen flex flex-col bg-slate-50" style={{ fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');`}</style>

      {/* Prototype controls */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-slate-900 text-slate-200 px-5 py-3 text-sm">
        <span className="text-slate-400">Opened from</span>
        <div className="flex rounded-lg bg-slate-800 p-0.5">
          {ENTRIES.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => switchEntry(e.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${entry === e.id ? "bg-white text-slate-900" : "text-slate-300 hover:text-white"}`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <label className={`flex items-center gap-2 ${entry === "search" ? "opacity-40" : "cursor-pointer"}`}>
          <button
            type="button"
            role="switch"
            aria-checked={unavailable}
            disabled={entry === "search"}
            onClick={() => setUnavailable((v) => !v)}
            className={`relative rounded-full ${unavailable ? "bg-amber-500" : "bg-slate-600"}`}
            style={{ width: 34, height: 20 }}
          >
            <span className="absolute bg-white rounded-full" style={{ width: 16, height: 16, top: 2, left: unavailable ? 16 : 2, transition: "left 120ms" }} />
          </button>
          Expert unavailable
        </label>
        <button type="button" onClick={openPanel} className="ml-auto inline-flex items-center gap-1.5 text-slate-300 hover:text-white">
          <RefreshCw size={14} /> Reopen panel
        </button>
      </div>

      {/* Stage */}
      <div className="relative flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto">
          {entry === "search" && <SearchPage query={query} setQuery={setQuery} onOpen={openPanel} />}
          {entry === "expert" && <ExpertPage onOpen={openPanel} />}
          {entry === "case" && <CasePage onOpen={openPanel} />}
        </div>

        {open && (
          <>
            <div className="absolute inset-0" style={{ background: "rgba(15, 23, 42, 0.18)" }} onClick={() => setOpen(false)} />
            <div className="absolute top-0 right-0 bottom-0 shadow-2xl border-l border-slate-200" style={{ width: 520, maxWidth: "100%" }}>
              <RequestPanel
                key={`${entry}-${panelKey}`}
                entry={entry}
                unavailable={unavailable}
                searchQuery={query}
                onClose={() => setOpen(false)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
