"use client";

import { useCallback, useState } from "react";
import type { JobStatus } from "@underhood/types";
import GraphView from "./graph-view";
import {
  ApiError,
  asTopology,
  pollAnalysis,
  submitAnalysis,
} from "../lib/api-client";

const STATUS_LABELS: Record<JobStatus["status"], string> = {
  queued: "Queued — waiting for a free worker…",
  running: "Analyzing your code…",
  completed: "Done!",
  failed: "Something went wrong.",
};

export default function CodeInput() {
  const [code, setCode] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus["status"] | null>(null);
  const [finalStatus, setFinalStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const analyze = useCallback(async () => {
    setError(null);
    setBusy(true);
    setStatus(null);
    setFinalStatus(null);
    try {
      const id = await submitAnalysis(code);
      setJobId(id);
      const result = await pollAnalysis(id, {
        onUpdate: (s) => setStatus(s.status),
      });
      setStatus(result.status);
      setFinalStatus(result);
      if (result.status === "failed") {
        setError(result.error ?? "Unknown error");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unexpected error");
    } finally {
      setBusy(false);
    }
  }, [code]);

  const topology =
    finalStatus?.status === "completed" && jobId
      ? asTopology(finalStatus)
      : null;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold">Underhood</h1>
        <p className="text-sm text-slate-400">
          Paste code. Get a plain-language picture of what it does.
        </p>
      </header>

      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        rows={12}
        spellCheck={false}
        placeholder={"// Paste any code snippet here\nfunction main() {\n  console.log('hello');\n}"}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 p-4 font-mono text-sm outline-none focus:border-sky-500"
      />

      <div className="flex items-center gap-3">
        <button
          onClick={analyze}
          disabled={busy || code.trim().length === 0}
          className="rounded-lg bg-sky-600 px-5 py-2 font-medium hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Working…" : "Visualize"}
        </button>
        {status && <span className="text-sm text-slate-300">{STATUS_LABELS[status]}</span>}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-800 bg-red-950 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {topology && (
        <div className="flex flex-col gap-3">
          {topology.detectedPatterns.length > 0 && (
            <p className="text-sm text-slate-400">
              Detected patterns:{" "}
              <span className="text-sky-300">{topology.detectedPatterns.join(", ")}</span>
            </p>
          )}
          <GraphView topology={topology} />
        </div>
      )}
    </section>
  );
}
