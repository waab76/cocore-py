"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";
import {
  HighlightedBlock,
  inferenceDocsSharedStyles,
} from "@/components/inference-docs/shared.tsx";
import { COMMUNITY_TOOLS_CATALOG } from "@/lib/community-tools/catalog.ts";
import { primaryColor, uiColor } from "@/design-system/theme/color.stylex";
import { radius } from "@/design-system/theme/radius.stylex";
import { gap, verticalSpace } from "@/design-system/theme/semantic-spacing.stylex";
import { spacing } from "@/design-system/theme/spacing.stylex";
import { fontFamily, fontSize, fontWeight } from "@/design-system/theme/typography.stylex";

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: gap["4xl"],
    marginTop: spacing["8"],
  },
  card: {
    borderColor: uiColor.border1,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: spacing["px"],
    backgroundColor: uiColor.component1,
    display: "flex",
    flexDirection: "column",
    gap: gap["2xl"],
    paddingBlock: verticalSpace["4xl"],
    paddingInline: verticalSpace["4xl"],
  },
  cardHeader: {
    display: "flex",
    flexDirection: "column",
    gap: gap["md"],
  },
  cardTitleRow: {
    alignItems: "baseline",
    display: "flex",
    flexWrap: "wrap",
    gap: gap["lg"],
    justifyContent: "space-between",
  },
  cardTitle: {
    color: uiColor.text2,
    fontFamily: fontFamily.title,
    fontSize: fontSize["2xl"],
    fontWeight: fontWeight.bold,
    margin: 0,
  },
  repoLink: {
    alignItems: "center",
    color: primaryColor.text2,
    display: "inline-flex",
    fontFamily: fontFamily.sans,
    fontSize: fontSize.sm,
    gap: gap["xs"],
    textDecoration: "underline",
    textUnderlineOffset: spacing["3"],
  },
  tagList: {
    display: "flex",
    flexWrap: "wrap",
    gap: gap["sm"],
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  tag: {
    borderColor: uiColor.border1,
    borderRadius: radius.full,
    borderStyle: "solid",
    borderWidth: spacing["px"],
    color: uiColor.text1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xs,
    letterSpacing: "0.06em",
    paddingBlock: spacing["0.5"],
    paddingInline: spacing["2.5"],
    textTransform: "uppercase",
  },
  sectionLabel: {
    color: uiColor.text1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: "0.14em",
    marginBottom: spacing["2"],
    textTransform: "uppercase",
  },
});

export function CommunityToolsPage() {
  return (
    <>
      <div {...stylex.props(docsStyles.masthead)}>
        <div {...stylex.props(docsStyles.kicker)}>Integrations</div>
        <h1 {...stylex.props(docsStyles.title)}>Community tools</h1>
        <p {...stylex.props(docsStyles.dek)}>
          Extensions, plugins, and integrations built by the community to connect co/core with your
          favorite tools. Official setup guides for OpenCode, Cursor, and Claude Code live on the{" "}
          <Link
            to="/docs/inference/$slug"
            params={{ slug: "opencode" }}
            {...stylex.props(docsStyles.proseLink)}
          >
            inference docs
          </Link>
          .
        </p>
      </div>

      <div {...stylex.props(docsStyles.introProse)}>
        <h2 {...stylex.props(docsStyles.h2, docsStyles.h2First)}>Listed tools</h2>
        <p {...stylex.props(docsStyles.prose)}>
          These projects are maintained independently. If you build something that uses co/core,
          open a pull request on{" "}
          <a
            href="https://github.com/graze-social/cocore"
            target="_blank"
            rel="noreferrer"
            {...stylex.props(docsStyles.proseLink)}
          >
            graze-social/cocore
          </a>{" "}
          to add it here.
        </p>

        {COMMUNITY_TOOLS_CATALOG.length === 0 ? (
          <p {...stylex.props(docsStyles.prose)}>No community tools listed yet.</p>
        ) : (
          <div {...stylex.props(styles.list)}>
            {COMMUNITY_TOOLS_CATALOG.map((tool) => (
              <article key={tool.id} {...stylex.props(styles.card)}>
                <div {...stylex.props(styles.cardHeader)}>
                  <div {...stylex.props(styles.cardTitleRow)}>
                    <h3 {...stylex.props(styles.cardTitle)}>{tool.name}</h3>
                    <a
                      href={tool.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      {...stylex.props(styles.repoLink)}
                    >
                      GitHub
                      <ExternalLink size={14} aria-hidden />
                    </a>
                  </div>
                  <p {...stylex.props(docsStyles.prose)}>{tool.description}</p>
                  {tool.tags.length > 0 ? (
                    <ul {...stylex.props(styles.tagList)}>
                      {tool.tags.map((tag) => (
                        <li key={tag} {...stylex.props(styles.tag)}>
                          {tag}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {tool.install ? (
                  <div>
                    <div {...stylex.props(styles.sectionLabel)}>Install</div>
                    <HighlightedBlock lang="bash" code={tool.install} />
                  </div>
                ) : null}

                {tool.setup && tool.setup.length > 0 ? (
                  <div>
                    <div {...stylex.props(styles.sectionLabel)}>Setup</div>
                    <ol {...stylex.props(inferenceDocsSharedStyles.list)}>
                      {tool.setup.map((step) => (
                        <li key={step} {...stylex.props(inferenceDocsSharedStyles.bullet)}>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
