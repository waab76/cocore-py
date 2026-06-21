"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";

/**
 * Detailed explainer for the two — orthogonal — security postures a co/core
 * provider can hold: Secure Mode (hardware attestation) and the Confidential
 * tier (operator-blind inference). The provider app links here from its
 * Status → Security section.
 */
export function SecurityDocsPage() {
  return (
    <>
      <div {...stylex.props(docsStyles.masthead)}>
        <div {...stylex.props(docsStyles.kicker)}>Security</div>
        <h1 {...stylex.props(docsStyles.title)}>Secure Mode &amp; the Confidential tier</h1>
        <p {...stylex.props(docsStyles.dek)}>
          A co/core provider can carry two independent security guarantees. They answer different
          questions and are earned separately — you can have either, both, or neither. This page
          explains what each one proves, how it works, and what it means for the prompts you send
          (as a requestor) or serve (as an operator).
        </p>
      </div>

      <div {...stylex.props(docsStyles.introProse)}>
        <h2 {...stylex.props(docsStyles.h2, docsStyles.h2First)}>The two are orthogonal</h2>
        <p {...stylex.props(docsStyles.prose)}>
          <strong>Secure Mode</strong> answers{" "}
          <em>“is this genuine, untampered Apple hardware?”</em> The{" "}
          <strong>Confidential tier</strong> answers{" "}
          <em>“can the machine&apos;s operator read the prompts a requestor sends it?”</em> One is
          about the integrity of the hardware; the other is about who can observe the data. A
          machine can prove its hardware and still run inference somewhere its operator can read, or
          seal inference from its operator without an Apple hardware-root proof. The strongest
          providers carry both.
        </p>

        <h2 {...stylex.props(docsStyles.h2)}>Secure Mode — “this is a real Mac, provably”</h2>
        <p {...stylex.props(docsStyles.prose)}>
          Secure Mode enrolls the Mac with co/core&apos;s device management and obtains an Apple{" "}
          <strong>Managed Device Attestation</strong> certificate chain — an Apple-signed credential
          rooted in the device&apos;s Secure Enclave that proves the silicon is genuine, the OS is
          intact, and System Integrity Protection is on. It sets the provider&apos;s trust level to{" "}
          <strong>hardware-attested</strong>.
        </p>
        <p {...stylex.props(docsStyles.prose)}>
          What it defends against: a spoofed or tampered provider — a VM pretending to be a Mac, or
          a machine with SIP disabled. What it does <em>not</em> say: anything about whether the
          operator can see your data. A genuine, hardware-attested Mac can still run inference in a
          process its operator reads. Secure Mode is optional and additive — turning it on never
          changes how the machine serves, only how strongly it can prove what it is.
        </p>

        <h2 {...stylex.props(docsStyles.h2)}>
          The Confidential tier — “the operator can&apos;t read the prompts”
        </h2>
        <p {...stylex.props(docsStyles.prose)}>
          This is the guarantee that matters to a <strong>requestor</strong>: when you send a prompt
          to a confidential provider, the machine&apos;s own operator cannot read it. A best-effort
          provider runs inference in a helper process the operator controls and could observe. A
          confidential provider instead runs inference{" "}
          <strong>entirely inside the measured, signed co/core agent</strong> — the in-process
          engine, with no subprocess and no IPC to tap — so the plaintext never leaves the attested
          binary. There is no observation surface for the operator to use.
        </p>
        <p {...stylex.props(docsStyles.prose)}>
          “Operator” here means the person running the provider machine. If you&apos;re an operator
          reading this in the app: confidential means that <em>you</em> can&apos;t read what
          requestors send you — and that&apos;s the point. It&apos;s what lets requestors trust your
          machine with sensitive work.
        </p>
        <p {...stylex.props(docsStyles.prose)}>
          How it&apos;s proven, so a requestor doesn&apos;t have to take the operator&apos;s word
          for it: the matchmaker challenges the running agent with an AMFI-gated push that only the
          genuine, team-signed binary can answer, and the binary&apos;s measured code identity (its
          code-directory hash) must be in the blessed-build set, under a hardened runtime with
          library validation and verified SIP. Only when all of that holds does the provider
          advertise the <strong>attested-confidential</strong> tier.
        </p>

        <h2 {...stylex.props(docsStyles.h2)}>Why they&apos;re independent</h2>
        <p {...stylex.props(docsStyles.prose)}>
          <strong>Neither</strong> — fast best-effort serving: a real-enough machine whose operator
          can read prompts. <strong>Secure Mode only</strong> — proven genuine hardware, but
          inference still runs where the operator can read it. <strong>Confidential only</strong> —
          the operator can&apos;t read prompts, but you&apos;re trusting the code-identity proof
          without an Apple hardware-root attestation of the silicon. <strong>Both</strong> — genuine
          attested hardware <em>and</em> a sealed, operator-blind inference path.
        </p>

        <h2 {...stylex.props(docsStyles.h2)}>The model constraint for operators</h2>
        <p {...stylex.props(docsStyles.prose)}>
          Confidential serving runs in the agent&apos;s in-process engine, which only loads certain
          model architectures — Qwen2 / Qwen3 / Llama / Gemma / Phi / Mistral-class weights. A model
          outside that set (for example a newer Qwen3.5+, Gemma 4, or Llama 4 architecture) can only
          be served best-effort, in the readable helper process. The provider app marks each model
          in the picker as <strong>“Confidential&nbsp;✓”</strong> or{" "}
          <strong>“Best-effort only”</strong>: choosing a best-effort-only model means your machine
          can&apos;t offer requestors the confidential guarantee while serving it, even if the
          machine is otherwise confidential-capable. Pick a confidential-capable model to keep the
          guarantee.
        </p>

        <h2 {...stylex.props(docsStyles.h2)}>Turning them on</h2>
        <p {...stylex.props(docsStyles.prose)}>
          Both are controlled from the provider app under{" "}
          <strong>Open co/core → Status → Security</strong>: <em>Enable Secure Mode</em> runs the
          device-enrollment wizard, and <em>Enable confidential</em> opts the machine into the
          attested-confidential tier (the same intent the console&apos;s per-machine control
          writes). The machine then restarts serving to earn the posture; it only advertises the
          higher tier once actually earned, so opting in never overstates what a machine can prove.
          For the receipt and lexicon fields these map to, see the{" "}
          <Link to="/docs/lexicons" {...stylex.props(docsStyles.proseLink)}>
            lexicon reference
          </Link>
          .
        </p>
      </div>
    </>
  );
}
