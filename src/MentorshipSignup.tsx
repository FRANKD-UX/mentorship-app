import { useState, useEffect, useRef } from "react";
import { supabase } from './supabaseClient';

// =============================================================================
// CONFIGURATION — fill in your real values here before going live
// =============================================================================

const BANKING_DETAILS = {
  bank: "STANDARD BANK ",
  accountHolder: "MR FRANK F NDLOVU",
  accountNumber: "10 13 474 966 7",
  accountType: "Current",
  branchCode: "7654",
  reference: "Your Full Name + Track  e.g. QHAWE ZULU  HTML",
};

// Your backend endpoint that returns a pre-signed S3 PUT URL.
// Expected POST body:  { fileName: string, fileType: string }
// Expected response:   { uploadUrl: string }
const S3_PRESIGN_ENDPOINT = "https://your-api.example.com/presign-upload";

const MAX_PER_TRACK = 15;

// Storage keys — version-namespaced so old data doesn't collide.
const COUNTS_KEY    = "dm_v2_counts";   // { "trackId_cohortId": number }
const EMAILS_KEY    = "dm_v2_emails";   // string[]  duplicate guard

// =============================================================================
// TRACKS
// =============================================================================

const TRACKS = [
  {
    id: "html-css",
    label: "HTML & CSS Fundamentals",
    short: "HTML-CSS",
    description: "Semantic markup, Flexbox, Grid and responsive design.",
    tag: "</>",
    color: "#b84c2a",
    price: 1000,
  },
  {
    id: "csharp",
    label: "C# Fundamentals",
    short: "CSharp",
    description: "Typed OOP, .NET basics, console and class-based programs.",
    tag: "C#",
    color: "#5b2d8e",
    price: 1500,
  },
  {
    id: "javascript",
    label: "JavaScript Fundamentals",
    short: "JavaScript",
    description: "DOM, events, fetch, async/await and modern ES6+ patterns.",
    tag: "JS",
    color: "#9a6200",
    price: 1500,
  },
  {
    id: "python",
    label: "Python Fundamentals",
    short: "Python",
    description: "Variables, loops, functions, OOP and script writing.",
    tag: "Py",
    color: "#1a6e9f",
    price: 1500,
  },
];

// =============================================================================
// COHORT GENERATION
// Cohorts always start from NEXT month — it makes no sense to apply for a
// cohort that has already begun. We generate the following 6 months from today.
// e.g. if today is April, the earliest selectable cohort is May.
// =============================================================================

function generateCohorts() {
  const now = new Date();
  const result = [];
  // i starts at 1 so we always skip the current month.
  for (let i = 1; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("default", { month: "long", year: "numeric" }) + " Cohort";
    result.push({ id, label });
  }
  return result;
}

const COHORTS = generateCohorts();

// =============================================================================
// STORAGE HELPERS - Supabase Integration (RPC VERSION - PRODUCTION READY)
// =============================================================================

async function loadCounts() {
  try {
    const { data, error } = await supabase
        .from('mentorship_counts')
        .select('*');

    if (error) throw error;

    // Convert array of records to key-value object using composite key for UI
    const counts = {};
    data?.forEach(record => {
      const key = `${record.track_id}_${record.cohort_id}`;
      counts[key] = record.count;
    });
    return counts;
  } catch (err) {
    console.error('Failed to load counts from Supabase:', err);
    // Fallback to localStorage if Supabase fails
    try {
      const data = localStorage.getItem(COUNTS_KEY);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  }
}

async function saveCounts(trackId, cohortId, currentCounts) {
  try {
    // Use RPC function - database handles the locking and logic atomically
    const { error } = await supabase.rpc('increment_count', {
      p_track: trackId,
      p_cohort: cohortId
    });

    if (error) throw error;

    // Return updated counts for local state (using composite key for UI)
    const trackCohortKey = `${trackId}_${cohortId}`;
    const newCounts = { ...currentCounts, [trackCohortKey]: (currentCounts[trackCohortKey] ?? 0) + 1 };
    return newCounts;
  } catch (err) {
    console.error('Failed to save counts to Supabase:', err);
    // Fallback to localStorage
    const trackCohortKey = `${trackId}_${cohortId}`;
    const newCounts = { ...currentCounts, [trackCohortKey]: (currentCounts[trackCohortKey] ?? 0) + 1 };
    localStorage.setItem(COUNTS_KEY, JSON.stringify(newCounts));
    return newCounts;
  }
}

async function loadEmails() {
  try {
    const { data, error } = await supabase
        .from('mentorship_applicants')
        .select('email');

    if (error) throw error;

    return data?.map(record => record.email.toLowerCase()) || [];
  } catch (err) {
    console.error('Failed to load emails from Supabase:', err);
    // Fallback to localStorage
    try {
      const data = localStorage.getItem(EMAILS_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }
}

// Helper function to save complete application to Supabase (strict payload)
async function saveApplicationToSupabase(applicationData) {
  // Build strict payload - ONLY database columns
  const payload = {
    first_name: applicationData.firstName,
    last_name: applicationData.lastName,
    email: applicationData.email,
    phone: applicationData.phone || null,
    track_id: applicationData.trackId,
    cohort_id: applicationData.cohortId,
    experience_level: applicationData.experience || null,
    motivation: applicationData.motivation,
    proof_file_name: applicationData.fileName,
    created_at: new Date().toISOString()
  };

  // SANITY CHECK - Log payload before insert
  console.log('📤 INSERT PAYLOAD:', payload);

  // Validate no undefined values in required fields
  const requiredFields = ['first_name', 'last_name', 'email', 'track_id', 'cohort_id', 'motivation', 'proof_file_name'];
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  try {
    const { error } = await supabase
        .from('mentorship_applicants')
        .insert([payload]);

    if (error) {
      // Check if it's a duplicate email error
      if (error.code === '23505') {
        throw new Error('DUPLICATE_EMAIL');
      }
      throw error;
    }
    return true;
  } catch (err) {
    console.error('Failed to save application to Supabase:', err);
    throw err;
  }
}

// The composite key for counting spots is "trackId_cohortId".
// This means the cap resets per cohort, which is exactly what you want.
function countKey(trackId, cohortId) {
  return `${trackId}_${cohortId}`;
}

// =============================================================================
// S3 UPLOAD
// The file name is built from the applicant's name + track + cohort so you can
// identify files in the S3 bucket without opening a database.
// e.g.  Jane_Doe_JavaScript_May_2025_Cohort.pdf
// =============================================================================

function buildFileName(firstName, lastName, trackShort, cohortLabel, mimeType) {
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  const sanitise = (s) => s.trim().replace(/[^a-zA-Z0-9]/g, "_");
  return `${sanitise(firstName)}_${sanitise(lastName)}_${sanitise(trackShort)}_${sanitise(cohortLabel)}.${ext}`;
}

async function uploadToS3(file, fileName) {
  // Step 1 — get a short-lived pre-signed PUT URL from your backend.
  const res = await fetch(S3_PRESIGN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, fileType: file.type }),
  });
  if (!res.ok) throw new Error(`Pre-sign failed: ${res.status}`);
  const { uploadUrl } = await res.json();

  // Step 2 — PUT the raw file directly to S3.
  // The file never touches your server; it goes straight to the bucket.
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!put.ok) throw new Error(`S3 PUT failed: ${put.status}`);

  return fileName;
}

// =============================================================================
// FIELD WRAPPER
// =============================================================================

function Field({ label, required, hint, error, children }) {
  return (
      <div className="field">
        <label className="field__label">
          {label}{required && <span className="req"> *</span>}
        </label>
        {hint && <p className="field__hint">{hint}</p>}
        {children}
        {error && <p className="field__error">{error}</p>}
      </div>
  );
}

// =============================================================================
// BANKING DETAILS CARD
// Each row has a one-click copy button so applicants can copy the account
// number or branch code without any risk of typos.
// =============================================================================

function BankingCard() {
  const [copied, setCopied] = useState(null);

  function copy(value, key) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  }

  const rows = [
    { key: "bank",    label: "Bank",           value: BANKING_DETAILS.bank },
    { key: "holder",  label: "Account Holder", value: BANKING_DETAILS.accountHolder },
    { key: "acc",     label: "Account Number", value: BANKING_DETAILS.accountNumber },
    { key: "type",    label: "Account Type",   value: BANKING_DETAILS.accountType },
    { key: "branch",  label: "Branch Code",    value: BANKING_DETAILS.branchCode },
    { key: "ref",     label: "Payment Reference", value: BANKING_DETAILS.reference },
  ];

  return (
      <div className="bank-card">
        <div className="bank-card__notice">
          Please make your EFT payment to the account below before submitting this form.
          Upload your bank-generated proof of payment in Step 5. Applications without
          valid proof will not be processed.
        </div>
        <table className="bank-table">
          <tbody>
          {rows.map((row) => (
              <tr className="bank-table__row" key={row.key}>
                <td className="bank-table__lbl">{row.label}</td>
                <td className="bank-table__val">{row.value}</td>
                <td className="bank-table__action">
                  <button
                      type="button"
                      className="copy-btn"
                      onClick={() => copy(row.value, row.key)}
                  >
                    {copied === row.key ? "Copied" : "Copy"}
                  </button>
                </td>
              </tr>
          ))}
          </tbody>
        </table>
      </div>
  );
}

// =============================================================================
// TRACK SELECTOR
// =============================================================================

function TrackSelector({ selected, cohortId, counts, onSelect, error }) {
  return (
      <div>
        <div className="track-grid">
          {TRACKS.map((t) => {
            const key = countKey(t.id, cohortId);
            const filled = counts[key] ?? 0;
            const spotsLeft = Math.max(0, MAX_PER_TRACK - filled);
            const isFull = spotsLeft === 0;
            const isActive = selected === t.id;

            return (
                <button
                    key={t.id}
                    type="button"
                    disabled={isFull}
                    onClick={() => !isFull && onSelect(t.id)}
                    className={`t-tile ${isActive ? "t-tile--on" : ""} ${isFull ? "t-tile--full" : ""}`}
                    style={{ "--tc": t.color }}
                >
                  <span className="t-tile__tag" style={{ background: t.color }}>{t.tag}</span>
                  <span className="t-tile__name">{t.label}</span>
                  <span className="t-tile__price">R{t.price.toLocaleString()}</span>
                  <span className="t-tile__desc">{t.description}</span>
                  <span className={`t-tile__spots ${isFull ? "t-tile__spots--full" : ""}`}>
                {isFull
                    ? "Full — apply for next cohort"
                    : `${spotsLeft} of ${MAX_PER_TRACK} spots remaining`}
              </span>
                  {isActive && <span className="t-tile__check">&#10003;</span>}
                </button>
            );
          })}
        </div>
        {error && <p className="field__error" style={{ marginTop: 8 }}>{error}</p>}
      </div>
  );
}

// =============================================================================
// UPLOAD ZONE
// =============================================================================

function UploadZone({ file, onChange, error }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);

  function process(f) {
    const ok = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
    if (!ok.includes(f.type)) { onChange(null, "Only PNG, JPG or PDF files are accepted."); return; }
    if (f.size > 8 * 1024 * 1024) { onChange(null, "File must be smaller than 8 MB."); return; }
    onChange(f, null);
  }

  return (
      <div
          className={`dropzone ${drag ? "dropzone--drag" : ""} ${error ? "dropzone--err" : ""} ${file ? "dropzone--filled" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) process(e.dataTransfer.files[0]); }}
          onClick={() => ref.current?.click()}
      >
        <input ref={ref} type="file" accept=".png,.jpg,.jpeg,.pdf"
               style={{ display: "none" }}
               onChange={(e) => { if (e.target.files[0]) process(e.target.files[0]); }}
        />
        {file ? (
            <div className="dropzone__preview">
              <span className="dropzone__badge">{file.type === "application/pdf" ? "PDF" : "IMG"}</span>
              <div>
                <p className="dropzone__fname">{file.name}</p>
                <p className="dropzone__fsize">{(file.size / 1024).toFixed(0)} KB — click to replace</p>
              </div>
            </div>
        ) : (
            <>
              <svg className="dropzone__ico" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="dropzone__text">Drag your proof of payment here, or <u>browse</u></p>
              <p className="dropzone__hint">Screenshot (PNG, JPG) or PDF — max 8 MB</p>
            </>
        )}
      </div>
  );
}

// =============================================================================
// DUPLICATE EMAIL MODAL
// =============================================================================

function DuplicateModal({ onClose }) {
  return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal__ico modal__ico--warn">!</div>
          <h2 className="modal__title">Already Registered</h2>
          <p className="modal__body">
            An application has already been submitted using this email address. Each
            applicant may only apply once per programme cycle. If you believe this is
            an error, please reach out to us directly.
          </p>
          <button className="btn btn--outline" onClick={onClose}>Close</button>
        </div>
      </div>
  );
}

// =============================================================================
// SUCCESS SCREEN
// =============================================================================

function SuccessScreen({ name, trackLabel, cohortLabel, onReset }) {
  return (
      <div className="success">
        <div className="success__ring">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="success__h">You are in, {name.split(" ")[0]}!</h2>
        <p className="success__p">
          Your application for <strong>{trackLabel}</strong> has been received for the{" "}
          <strong>{cohortLabel}</strong>. Your proof of payment is being reviewed.
        </p>
        <div className="success__timeline">
          <div className="success__step">
            <span className="success__num">1</span>
            <div>
              <strong>Month 1</strong>
              <span>Instructor-led fundamentals training</span>
            </div>
          </div>
          <div className="success__line" />
          <div className="success__step">
            <span className="success__num">2</span>
            <div>
              <strong>Days 31 – 44</strong>
              <span>14-day remote Q&amp;A and support window</span>
            </div>
          </div>
        </div>
        <p className="success__note">We will email your onboarding details shortly. Check your inbox.</p>
        <button className="btn btn--ghost" onClick={onReset}>Submit another application</button>
      </div>
  );
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

export default function MentorshipSignup() {
  const [counts, setCounts]       = useState(null);
  const [emails, setEmails]       = useState(null);

  const [form, setForm] = useState({
    firstName:     "",
    lastName:      "",
    email:         "",
    phone:         "",
    cohortId:      COHORTS[0]?.id || "",
    selectedTrack: "",
    experience:    "",
    motivation:    "",
    proofFile:     null,
  });

  const [errors,      setErrors]      = useState({});
  const [fileErr,     setFileErr]     = useState(null);
  const [showDup,     setShowDup]     = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitErr,   setSubmitErr]   = useState(null);
  const [submitted,   setSubmitted]   = useState(false);

  useEffect(() => {
    Promise.all([loadCounts(), loadEmails()]).then(([c, e]) => {
      setCounts(c);
      setEmails(e);
    });
  }, []);

  function setField(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
    setErrors((p) => ({ ...p, [key]: undefined }));
  }

  // When the cohort changes we reset the track selection because capacity is
  // tracked per cohort — a full track in May may still have spots in June.
  function handleCohortChange(cohortId) {
    setForm((p) => ({ ...p, cohortId, selectedTrack: "" }));
  }

  function validate() {
    const e = {};
    if (!form.firstName.trim())  e.firstName  = "Required.";
    if (!form.lastName.trim())   e.lastName   = "Required.";
    if (!form.email.trim())      e.email      = "Required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Enter a valid email.";
    if (!form.cohortId)          e.cohortId   = "Please select a cohort.";
    if (!form.selectedTrack)     e.selectedTrack = "Please select a track.";
    if (!form.motivation.trim()) e.motivation = "Please share your motivation.";
    if (!form.proofFile)         e.proofFile  = "Proof of payment is required.";
    return e;
  }

  async function handleSubmit() {
    setSubmitErr(null);
    const ve = validate();
    if (fileErr) ve.proofFile = fileErr;
    if (Object.keys(ve).length > 0) {
      setErrors(ve);
      document.querySelector(".field__error")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const normEmail = form.email.toLowerCase().trim();

    // Check for duplicate email
    if (emails?.includes(normEmail)) {
      setShowDup(true);
      return;
    }

    setSubmitting(true);

    try {
      const trackObj  = TRACKS.find((t) => t.id === form.selectedTrack);
      const cohortObj = COHORTS.find((c) => c.id === form.cohortId);

      const fileName = buildFileName(
          form.firstName,
          form.lastName,
          trackObj.short,
          cohortObj.label,
          form.proofFile.type
      );

      // ------------------------------------------------------------------
      // S3 UPLOAD
      // The real call is below. It is commented out so the form works in
      // this demo environment without a live backend.
      // Uncomment this once your pre-sign endpoint is deployed:
      //
      //   await uploadToS3(form.proofFile, fileName);
      //
      // For now we simulate a 1.2 second upload delay.
      // ------------------------------------------------------------------
      await new Promise((r) => setTimeout(r, 1200));
      console.log("[S3 mock] File would be uploaded as:", fileName);

      // Save application to Supabase
      const applicationData = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: normEmail,
        phone: form.phone.trim(),
        trackId: form.selectedTrack,
        cohortId: form.cohortId,
        experience: form.experience,
        motivation: form.motivation.trim(),
        fileName: fileName
      };

      try {
        await saveApplicationToSupabase(applicationData);
      } catch (err) {
        if (err.message === 'DUPLICATE_EMAIL') {
          setShowDup(true);
          setSubmitting(false);
          return;
        }
        throw err;
      }

      // Update spot count in Supabase using RPC (atomic, race-condition safe)
      const updatedCounts = await saveCounts(form.selectedTrack, form.cohortId, counts);
      setCounts(updatedCounts);

      // Update local emails array
      const newEmails = [...(emails || []), normEmail];
      setEmails(newEmails);
      localStorage.setItem(EMAILS_KEY, JSON.stringify(newEmails));

      setSubmitted(true);
    } catch (err) {
      console.error('Submission error:', err);
      setSubmitErr("Something went wrong submitting your application. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setForm({ firstName: "", lastName: "", email: "", phone: "", cohortId: COHORTS[0]?.id || "", selectedTrack: "", experience: "", motivation: "", proofFile: null });
    setErrors({});
    setFileErr(null);
    setSubmitErr(null);
    setSubmitted(false);
  }

  const trackObj  = TRACKS.find((t) => t.id === form.selectedTrack);
  const cohortObj = COHORTS.find((c) => c.id === form.cohortId);
  const loading   = counts === null || emails === null;

  if (loading) {
    return (
        <>
          <style>{CSS}</style>
          <div className="app"><div className="page-loading">Loading...</div></div>
        </>
    );
  }

  return (
      <>
        <style>{CSS}</style>
        <div className="app">

          <header className="hdr">
            <div className="hdr__inner">
              <div className="hdr__left">
                <p className="hdr__programme">DevMentorship Programme</p>
                <h1 className="hdr__title">Cohort Application Form</h1>
                <p className="hdr__sub">
                  Complete all sections below and submit your proof of payment to secure your place.
                  Applications are reviewed on a first-come, first-served basis. Each cohort is
                  limited to 15 participants per track.
                </p>
              </div>
              <div className="hdr__meta">
                <div className="hdr__meta-row">
                  <span className="hdr__meta-lbl">Duration</span>
                  <span className="hdr__meta-val">1 Month Training + 14-Day Support</span>
                </div>
                <div className="hdr__meta-row">
                  <span className="hdr__meta-lbl">Format</span>
                  <span className="hdr__meta-val">Remote (Online)</span>
                </div>
                <div className="hdr__meta-row">
                  <span className="hdr__meta-lbl">Capacity</span>
                  <span className="hdr__meta-val">15 Applicants per Track</span>
                </div>
              </div>
            </div>
          </header>

          <main className="main">
            {submitted && trackObj && cohortObj ? (
                <SuccessScreen
                    name={`${form.firstName} ${form.lastName}`}
                    trackLabel={trackObj.label}
                    cohortLabel={cohortObj.label}
                    onReset={handleReset}
                />
            ) : (
                <div className="form-wrap">

                  {/* 01 — Payment details */}
                  <section className="sec">
                    <div className="sec__hd">
                      <span className="sec__n">01</span>
                      <h2 className="sec__t">Make Your Payment First</h2>
                    </div>
                    <BankingCard />
                  </section>

                  {/* 02 — Personal details */}
                  <section className="sec">
                    <div className="sec__hd">
                      <span className="sec__n">02</span>
                      <h2 className="sec__t">Your Details</h2>
                    </div>
                    <div className="g2">
                      <Field label="First Name" required error={errors.firstName}>
                        <input className={`inp ${errors.firstName ? "inp--e" : ""}`} type="text"
                               placeholder="NAME" value={form.firstName}
                               onChange={(e) => setField("firstName", e.target.value)} />
                      </Field>
                      <Field label="Last Name" required error={errors.lastName}>
                        <input className={`inp ${errors.lastName ? "inp--e" : ""}`} type="text"
                               placeholder="SURNAME" value={form.lastName}
                               onChange={(e) => setField("lastName", e.target.value)} />
                      </Field>
                    </div>
                    <div className="g2">
                      <Field label="Email Address" required error={errors.email}>
                        <input className={`inp ${errors.email ? "inp--e" : ""}`} type="email"
                               placeholder="jane@example.com" value={form.email}
                               onChange={(e) => setField("email", e.target.value)} />
                      </Field>
                      <Field label="Phone Number (optional)">
                        <input className="inp" type="tel"
                               placeholder="+27 82 000 0000" value={form.phone}
                               onChange={(e) => setField("phone", e.target.value)} />
                      </Field>
                    </div>
                  </section>

                  {/* 03 — Cohort & Track */}
                  <section className="sec">
                    <div className="sec__hd">
                      <span className="sec__n">03</span>
                      <h2 className="sec__t">Choose Your Cohort &amp; Track</h2>
                    </div>
                    <Field
                        label="Which cohort are you applying for?"
                        required
                        error={errors.cohortId}
                        hint="Each cohort runs for one month. Select the month you want to start."
                    >
                      <select
                          className={`inp inp--sel ${errors.cohortId ? "inp--e" : ""}`}
                          value={form.cohortId}
                          onChange={(e) => handleCohortChange(e.target.value)}
                      >
                        {COHORTS.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ marginTop: 20 }}>
                      <p className="field__label" style={{ marginBottom: 12 }}>
                        Select your track <span className="req"> *</span>
                      </p>
                      <TrackSelector
                          selected={form.selectedTrack}
                          cohortId={form.cohortId}
                          counts={counts}
                          onSelect={(id) => setField("selectedTrack", id)}
                          error={errors.selectedTrack}
                      />
                    </div>
                  </section>

                  {/* 04 — Background */}
                  <section className="sec">
                    <div className="sec__hd">
                      <span className="sec__n">04</span>
                      <h2 className="sec__t">Your Background</h2>
                    </div>
                    <Field label="Current experience level">
                      <select className="inp inp--sel" value={form.experience}
                              onChange={(e) => setField("experience", e.target.value)}>
                        <option value="">Select one...</option>
                        <option value="none">Complete beginner</option>
                        <option value="dabbled">Tried a few tutorials</option>
                        <option value="some">Some exposure, not consistent</option>
                        <option value="self-taught">Self-taught, want structure</option>
                      </select>
                    </Field>
                    <Field label="Why do you want to join?" required error={errors.motivation}
                           hint="Tell us what you hope to achieve and why this track interests you.">
                  <textarea
                      className={`inp inp--ta ${errors.motivation ? "inp--e" : ""}`}
                      placeholder="I want to learn to code because..."
                      rows={4} value={form.motivation}
                      onChange={(e) => setField("motivation", e.target.value)}
                  />
                    </Field>
                  </section>

                  {/* 05 — Proof of payment */}
                  <section className="sec">
                    <div className="sec__hd">
                      <span className="sec__n">05</span>
                      <h2 className="sec__t">Upload Proof of Payment</h2>
                    </div>
                    <p className="sec__desc">
                      Upload a screenshot or PDF of your bank confirmation for the EFT you made in
                      Step 1. Your file is stored securely and linked to your application automatically.
                    </p>
                    <UploadZone
                        file={form.proofFile}
                        onChange={(f, err) => {
                          setForm((p) => ({ ...p, proofFile: f }));
                          setFileErr(err);
                          if (!err) setErrors((p) => ({ ...p, proofFile: undefined }));
                        }}
                        error={errors.proofFile || fileErr}
                    />
                    {(errors.proofFile || fileErr) && (
                        <p className="field__error">{errors.proofFile || fileErr}</p>
                    )}
                  </section>

                  {/* Submit */}
                  <div className="foot">
                    {submitErr && <p className="foot__err">{submitErr}</p>}
                    <button className="btn btn--submit" onClick={handleSubmit} disabled={submitting}>
                      {submitting ? (
                          <span className="btn__loading"><span className="spin" />Uploading &amp; submitting...</span>
                      ) : "Submit Application"}
                    </button>
                    <p className="foot__note">
                      By submitting you confirm the information above is accurate and that your EFT
                      has been processed. Each person may only apply once per cohort cycle.
                    </p>
                  </div>

                </div>
            )}
          </main>

          {showDup && <DuplicateModal onClose={() => setShowDup(false)} />}
        </div>
      </>
  );
}

// =============================================================================
// CSS
// Warm editorial light theme: cream paper, ink type, terracotta accent.
// =============================================================================

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --cream:    #f5f5f4;
    --paper:    #ffffff;
    --ink:      #111110;
    --mid:      #4a4a48;
    --muted:    #888884;
    --rule:     #ddddd8;
    --rust:     #b84c2a;
    --rust-l:   #e8603a;
    --rust-bg:  #fdf0eb;
    --rust-bd:  #f0cfc2;
    --grn:      #2d6a4f;
    --grn-bg:   #eaf4ef;
    --red:      #c0392b;
    --red-bg:   #fdecea;
    --shadow:   0 1px 12px rgba(0,0,0,0.06);
    --r:        6px;
    --ff-d:     'IBM Plex Serif', Georgia, serif;
    --ff-b:     'IBM Plex Sans', system-ui, sans-serif;
    --t:        0.15s ease;
  }

  body { background: var(--cream); }

  .app {
    min-height: 100vh;
    font-family: var(--ff-b);
    color: var(--ink);
    background: var(--cream);
  }

  /* ── Header ── */
  .hdr {
    background: var(--paper);
    border-bottom: 2px solid var(--ink);
    padding: 36px 40px 32px;
  }

  .hdr__inner {
    max-width: 780px;
    margin: 0 auto;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 40px;
    flex-wrap: wrap;
  }

  .hdr__left { flex: 1; min-width: 260px; }

  .hdr__programme {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .hdr__title {
    font-family: var(--ff-d);
    font-size: 30px;
    font-weight: 900;
    color: var(--ink);
    letter-spacing: -0.5px;
    line-height: 1.1;
    margin-bottom: 12px;
  }

  .hdr__sub {
    font-size: 13px;
    color: var(--mid);
    line-height: 1.65;
    max-width: 460px;
  }

  .hdr__meta {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--rule);
    border-radius: 8px;
    overflow: hidden;
    align-self: flex-start;
    min-width: 240px;
    flex-shrink: 0;
  }

  .hdr__meta-row {
    display: flex;
    flex-direction: column;
    padding: 10px 16px;
    border-bottom: 1px solid var(--rule);
  }

  .hdr__meta-row:last-child { border-bottom: none; }

  .hdr__meta-lbl {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    margin-bottom: 2px;
  }

  .hdr__meta-val {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink);
  }

  @media (max-width: 600px) {
    .hdr { padding: 28px 20px 24px; }
    .hdr__meta { width: 100%; }
  }

  /* ── Main ── */
  .main { max-width: 780px; margin: 0 auto; padding: 48px 20px 80px; }

  .form-wrap { display: flex; flex-direction: column; }

  /* ── Sections ── */
  .sec {
    padding: 36px 0;
    border-bottom: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .sec:last-of-type { border-bottom: none; }

  .sec__hd { display: flex; align-items: baseline; gap: 14px; margin-bottom: 2px; }

  .sec__n {
    font-family: var(--ff-d); font-size: 13px; font-weight: 700;
    color: var(--rust-l); letter-spacing: 1px;
  }

  .sec__t {
    font-family: var(--ff-d); font-size: 22px; font-weight: 700;
    color: var(--ink); letter-spacing: -0.3px;
  }

  .sec__desc {
    font-size: 14px; color: var(--mid); line-height: 1.65; max-width: 580px;
  }

  /* ── Banking card ── */
  .bank-card {
    border: 1px solid var(--rule);
    border-radius: var(--r);
    overflow: hidden;
  }

  .bank-card__notice {
    padding: 14px 20px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--mid);
    background: var(--cream);
    border-bottom: 1px solid var(--rule);
  }

  .bank-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--paper);
  }

  .bank-table__row { border-bottom: 1px solid var(--rule); }
  .bank-table__row:last-child { border-bottom: none; }

  .bank-table__lbl {
    padding: 12px 20px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    white-space: nowrap;
    width: 160px;
    vertical-align: middle;
    border-right: 1px solid var(--rule);
  }

  .bank-table__val {
    padding: 12px 20px;
    font-size: 14px;
    color: var(--ink);
    vertical-align: middle;
  }

  .bank-table__action {
    padding: 12px 16px 12px 0;
    text-align: right;
    vertical-align: middle;
    white-space: nowrap;
  }

  .copy-btn {
    font-size: 11px;
    font-weight: 600;
    font-family: var(--ff-b);
    letter-spacing: 0.3px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--rule);
    border-radius: 4px;
    color: var(--mid);
    cursor: pointer;
    transition: border-color var(--t), color var(--t);
  }

  .copy-btn:hover { border-color: var(--ink); color: var(--ink); }

  /* ── Grids ── */
  .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  @media (max-width: 540px) {
    .g2 { grid-template-columns: 1fr; }
    .hdr { padding: 22px 20px 18px; }
  }

  /* ── Field ── */
  .field { display: flex; flex-direction: column; gap: 5px; }

  .field__label {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--ink);
  }

  .req { color: var(--rust-l); }

  .field__hint { font-size: 12px; color: var(--muted); line-height: 1.4; margin-top: -1px; }

  .field__error { font-size: 12px; color: var(--red); font-weight: 700; }

  /* ── Inputs ── */
  .inp {
    background: var(--paper); border: 1.5px solid var(--rule);
    border-radius: 8px; color: var(--ink); font-family: var(--ff-b);
    font-size: 15px; padding: 11px 14px; outline: none; width: 100%;
    transition: border-color var(--t), box-shadow var(--t);
    appearance: none;
  }

  .inp::placeholder { color: #c0b8b0; }

  .inp:focus {
    border-color: var(--rust-l);
    box-shadow: 0 0 0 3px rgba(184,76,42,0.10);
  }

  .inp--e { border-color: var(--red); background: var(--red-bg); }

  .inp--ta { resize: vertical; min-height: 110px; line-height: 1.55; }

  .inp--sel {
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239a948c' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 14px center; padding-right: 36px;
  }

  /* ── Track tiles ── */
  .track-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  @media (max-width: 540px) { .track-grid { grid-template-columns: 1fr; } }

  .t-tile {
    position: relative; display: flex; flex-direction: column; align-items: flex-start;
    gap: 5px; background: var(--paper); border: 1.5px solid var(--rule);
    border-radius: var(--r); padding: 16px 18px 14px; cursor: pointer; text-align: left;
    width: 100%; font-family: var(--ff-b); overflow: hidden;
  }

  .t-tile--on {
    border-color: var(--ink);
    background: #f5f3f0;
  }

  .t-tile--full { opacity: 0.42; cursor: not-allowed; }

  .t-tile__tag {
    font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
    padding: 3px 8px; border-radius: 4px; color: #fff; margin-bottom: 4px;
  }

  .t-tile__name { font-size: 14px; font-weight: 700; color: var(--ink); line-height: 1.3; }

  .t-tile__price {
    font-size: 16px; font-weight: 900; color: var(--ink);
    font-family: var(--ff-d); margin: 2px 0;
  }

  .t-tile__desc { font-size: 12px; color: var(--mid); line-height: 1.45; }

  .t-tile__spots {
    font-size: 11px; font-weight: 700; color: var(--grn); background: var(--grn-bg);
    padding: 2px 8px; border-radius: 100px; margin-top: 4px;
  }

  .t-tile__spots--full { color: var(--red); background: var(--red-bg); }

  .t-tile__check {
    position: absolute; top: 12px; right: 14px;
    width: 22px; height: 22px; background: var(--ink); border-radius: 50%;
    color: #fff; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
  }

  /* ── Drop zone ── */
  .dropzone {
    background: var(--paper); border: 2px dashed var(--rule); border-radius: var(--r);
    padding: 40px 24px; text-align: center; cursor: pointer;
    transition: border-color var(--t), background var(--t);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }

  .dropzone:hover, .dropzone--drag {
    border-color: var(--rust-l); background: var(--rust-bg);
  }

  .dropzone--filled {
    border-style: solid; border-color: var(--grn); background: var(--grn-bg); padding: 22px 24px;
  }

  .dropzone--err { border-color: var(--red); }

  .dropzone__ico { color: var(--muted); }
  .dropzone:hover .dropzone__ico, .dropzone--drag .dropzone__ico { color: var(--rust-l); }

  .dropzone__text { font-size: 15px; color: var(--mid); }
  .dropzone__text u { color: var(--rust-l); text-underline-offset: 3px; cursor: pointer; }
  .dropzone__hint { font-size: 12px; color: var(--muted); }

  .dropzone__preview { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; justify-content: center; }

  .dropzone__badge {
    background: var(--grn); color: #fff; font-size: 11px; font-weight: 700;
    padding: 4px 10px; border-radius: 4px; letter-spacing: 0.5px;
  }

  .dropzone__fname { font-size: 14px; font-weight: 700; color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dropzone__fsize { font-size: 12px; color: var(--mid); margin-top: 2px; }

  /* ── Footer ── */
  .foot { padding-top: 36px; display: flex; flex-direction: column; align-items: center; gap: 14px; }

  .foot__note { font-size: 12px; color: var(--muted); text-align: center; max-width: 440px; line-height: 1.55; }

  .foot__err {
    font-size: 13px; color: var(--red); background: var(--red-bg);
    border: 1px solid #f5c6c3; border-radius: 8px; padding: 12px 16px;
    text-align: center; max-width: 500px; line-height: 1.5;
  }

  /* ── Buttons ── */
  .btn {
    font-family: var(--ff-b); font-size: 15px; font-weight: 700; border: none;
    border-radius: 8px; cursor: pointer; letter-spacing: 0.2px;
    transition: background var(--t), transform var(--t), opacity var(--t);
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn--submit {
    background: var(--ink); color: #fff; padding: 16px 52px; font-size: 16px;
  }

  .btn--submit:hover:not(:disabled) {
    background: var(--rust-l); transform: translateY(-1px);
  }

  .btn--outline {
    background: transparent; border: 2px solid var(--rule); color: var(--ink); padding: 12px 28px;
  }

  .btn--outline:hover { border-color: var(--ink); }

  .btn--ghost { background: var(--rule); color: var(--ink); padding: 12px 28px; }
  .btn--ghost:hover { background: #ddd7cc; }

  .btn__loading { display: flex; align-items: center; gap: 10px; }

  .spin {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff; display: inline-block;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Modal ── */
  .overlay {
    position: fixed; inset: 0; background: rgba(28,26,23,0.55);
    backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; padding: 20px; animation: fi 0.15s ease;
  }

  .modal {
    background: var(--paper); border-radius: 14px; padding: 36px 32px;
    max-width: 400px; width: 100%; display: flex; flex-direction: column;
    align-items: center; gap: 16px; text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.16); animation: su 0.2s ease;
  }

  .modal__ico {
    width: 56px; height: 56px; border-radius: 50%;
    font-family: var(--ff-d); font-size: 24px; font-weight: 900;
    display: flex; align-items: center; justify-content: center;
  }

  .modal__ico--warn { background: #fff3e0; color: #e67e22; border: 2px solid #f0c080; }

  .modal__title { font-family: var(--ff-d); font-size: 22px; font-weight: 700; color: var(--ink); }
  .modal__body  { font-size: 14px; color: var(--mid); line-height: 1.6; }

  /* ── Success ── */
  .success {
    background: var(--paper); border: 1px solid var(--rule); border-radius: 14px;
    padding: 60px 40px; display: flex; flex-direction: column; align-items: center;
    gap: 18px; text-align: center; animation: fi 0.35s ease;
    box-shadow: var(--shadow);
  }

  .success__ring {
    width: 68px; height: 68px; border-radius: 50%;
    background: var(--grn-bg); border: 2px solid var(--grn);
    color: var(--grn); display: flex; align-items: center; justify-content: center;
    margin-bottom: 4px;
  }

  .success__h {
    font-family: var(--ff-d); font-size: 30px; font-weight: 900;
    color: var(--ink); letter-spacing: -0.4px;
  }

  .success__p { font-size: 15px; color: var(--mid); max-width: 420px; line-height: 1.65; }
  .success__p strong { color: var(--ink); }

  .success__timeline {
    border: 1px solid var(--rule); border-radius: 10px; overflow: hidden;
    width: 100%; max-width: 380px; text-align: left;
  }

  .success__step { display: flex; align-items: flex-start; gap: 14px; padding: 16px 20px; background: var(--paper); }
  .success__line { height: 1px; background: var(--rule); }

  .success__num {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--rust-bg); border: 1.5px solid var(--rust-bd);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; color: var(--rust-l); flex-shrink: 0; margin-top: 2px;
  }

  .success__step div { display: flex; flex-direction: column; gap: 3px; }
  .success__step strong { font-size: 14px; font-weight: 700; color: var(--ink); }
  .success__step span { font-size: 13px; color: var(--mid); }

  .success__note { font-size: 13px; color: var(--muted); max-width: 360px; line-height: 1.5; }

  /* ── Loading ── */
  .page-loading {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-size: 15px; color: var(--mid); font-family: var(--ff-b);
  }

  /* ── Animations ── */
  @keyframes fi { from { opacity: 0; } to { opacity: 1; } }
  @keyframes su { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
`;