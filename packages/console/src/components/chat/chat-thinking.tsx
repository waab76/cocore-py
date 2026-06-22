// Collapsible "thinking" block for a reasoning model's trace.
//
// Built on react-aria-components' Disclosure DIRECTLY (not the design-system
// wrapper) so it can be styled to read as a quiet, inline part of the chat
// transcript rather than a standalone DS panel. The reasoning text streams on
// a separate channel from the answer (see chat-dispatch.ts) and is rendered
// with the same markdown pipeline as the answer.

import * as stylex from "@stylexjs/stylex";
import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Disclosure, DisclosurePanel } from "react-aria-components";

import { uiColor } from "@/design-system/theme/color.stylex";
import { mediaQueries } from "@/design-system/theme/media-queries.stylex";
import { radius } from "@/design-system/theme/radius.stylex";
import { gap, size as sizeSpace } from "@/design-system/theme/semantic-spacing.stylex";
import { fontFamily, fontSize, fontWeight } from "@/design-system/theme/typography.stylex";

import { ChatMarkdown } from "@/components/chat/chat-markdown.tsx";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    // Small, intentional gap to the answer below — the answer's own leading
    // adds the rest. (The oversized `size` scale read as too much when open.)
    marginBottom: gap.xs,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: gap.xs,
    width: "fit-content",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    color: { default: uiColor.text2, ":is([data-hovered=true])": uiColor.text1 },
    fontFamily: fontFamily.sans,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    textAlign: "left",
  },
  chevron: {
    flexShrink: 0,
    transition: {
      default: "rotate 200ms ease-in-out",
      [mediaQueries.reducedMotion]: "none",
    },
    rotate: { default: "0deg", ":is([aria-expanded=true] *)": "90deg" },
  },
  panel: {
    overflow: "hidden",
    marginTop: gap.xs,
    paddingLeft: sizeSpace.sm,
    // A subtle left rail visually nests the reasoning under its toggle and
    // distinguishes it from the answer below.
    borderLeftWidth: 2,
    borderLeftStyle: "solid",
    borderLeftColor: uiColor.border1,
    borderTopLeftRadius: radius.xs,
    color: uiColor.text2,
    fontSize: fontSize.sm,
  },
});

export interface ThinkingDisclosureProps {
  reasoning: string;
  /** True only while the model is ACTIVELY producing reasoning (this turn is
   *  streaming and the answer hasn't started). Drives the auto-expand and the
   *  streaming caret; once it flips false the block auto-collapses (the user
   *  can still reopen it to read the trace). */
  active: boolean;
}

export function ThinkingDisclosure({
  reasoning,
  active,
}: ThinkingDisclosureProps): ReactElement {
  // Controlled expansion: expand while thinking, collapse when it ends — but
  // leave the user free to toggle it afterward. We only force the state on the
  // active→inactive (or inactive→active) transition, not on every render.
  const [expanded, setExpanded] = useState(active);
  const prevActive = useRef(active);
  useEffect(() => {
    if (active !== prevActive.current) {
      setExpanded(active);
      prevActive.current = active;
    }
  }, [active]);

  return (
    <Disclosure
      isExpanded={expanded}
      onExpandedChange={setExpanded}
      {...stylex.props(styles.root)}
    >
      {/* No <Heading> wrapper: react-aria allows the trigger button as a
          direct child, and an <h3> brings large default margins that double
          the gap under the toggle (the design-system disclosure omits it too). */}
      <Button slot="trigger" {...stylex.props(styles.trigger)}>
        <ChevronRight size={14} {...stylex.props(styles.chevron)} aria-hidden />
        <span>Thinking</span>
      </Button>
      <DisclosurePanel {...stylex.props(styles.panel)}>
        {/* Caret only while actively thinking — the answer shows its own. */}
        <ChatMarkdown streaming={active} text={reasoning} />
      </DisclosurePanel>
    </Disclosure>
  );
}
