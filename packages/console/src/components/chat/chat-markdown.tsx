"use client";

import type { Components } from "react-markdown";

import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ReactElement } from "react";

import "katex/dist/katex.min.css";

import { highlightCodeQueryOptions } from "@/components/account/account.functions.ts";
import { normalizeHighlightLang } from "@/lib/highlight-code.shared.ts";
import {
  primaryColor,
  successColor,
  uiColor,
  uiInverted,
} from "@/design-system/theme/color.stylex";
import { radius } from "@/design-system/theme/radius.stylex";
import { gap, horizontalSpace, verticalSpace } from "@/design-system/theme/semantic-spacing.stylex";
import {
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
} from "@/design-system/theme/typography.stylex";

// rehype-sanitize strips KaTeX's marker classes by default. remark-math emits
// inline/display math as `<code class="language-math math-inline|math-display">`;
// rehype-katex needs those classes to find the math. Keep the default schema
// (incl. its `language-*` allowance, so code highlighting still works) and add
// the two math markers to code's className allowlist. rehype-katex then runs
// AFTER sanitize, so KaTeX's generated markup isn't re-stripped — safe because
// KaTeX runs with trust disabled (no raw HTML / \href injection).
const mathSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: (defaultSchema.attributes?.code ?? []).map((attr) =>
      Array.isArray(attr) && attr[0] === "className"
        ? [...attr, "math-inline", "math-display"]
        : attr,
    ),
  },
};

const styles = stylex.create({
  root: {
    color: uiColor.text2,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.sm,
    lineHeight: 1.65,
    maxWidth: "100%",
    minWidth: 0,
    overflowWrap: "break-word",
  },
  heading: {
    color: uiColor.text2,
    fontFamily: fontFamily.sans,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.sm,
    marginBottom: verticalSpace.sm,
    marginTop: verticalSpace.lg,
  },
  h1: {
    fontSize: fontSize.lg,
  },
  h2: {
    fontSize: fontSize.base,
  },
  h3: {
    fontSize: fontSize.sm,
  },
  h4: {
    fontSize: fontSize.sm,
  },
  h5: {
    fontSize: fontSize.xs,
  },
  h6: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  paragraph: {
    marginBottom: verticalSpace.md,
    marginTop: 0,
  },
  list: {
    marginBottom: verticalSpace.md,
    marginTop: 0,
    paddingLeft: horizontalSpace["2xl"],
  },
  orderedList: {
    marginBottom: verticalSpace["2xl"],
    marginLeft: horizontalSpace.lg,
    marginTop: verticalSpace["2xl"],
    paddingLeft: horizontalSpace["8xl"],
  },
  listItem: {
    marginBottom: verticalSpace.xs,
  },
  blockquote: {
    borderColor: uiColor.border1,
    borderLeftStyle: "solid",
    borderLeftWidth: 3,
    color: uiColor.text1,
    fontStyle: "italic",
    marginBottom: verticalSpace.md,
    marginTop: 0,
    paddingLeft: horizontalSpace.lg,
  },
  link: {
    color: primaryColor.text2,
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  inlineCode: {
    backgroundColor: uiColor.bgSubtle,
    borderColor: uiColor.border1,
    borderRadius: radius.xs,
    cornerShape: "squircle",
    borderStyle: "solid",
    borderWidth: 1,
    fontFamily: fontFamily.mono,
    fontSize: "0.9em",
    paddingLeft: horizontalSpace.xs,
    paddingRight: horizontalSpace.xs,
  },
  codeBlock: {
    backgroundColor: uiInverted.bg,
    borderColor: uiInverted.border1,
    borderRadius: radius.xs,
    cornerShape: "squircle",
    borderStyle: "solid",
    borderWidth: 1,
    boxSizing: "border-box",
    color: uiInverted.text2,
    display: "block",
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    lineHeight: 1.55,
    marginBottom: verticalSpace.md,
    marginTop: verticalSpace.md,
    maxWidth: "100%",
    overflowX: "auto",
    paddingBottom: verticalSpace.md,
    paddingLeft: horizontalSpace.lg,
    paddingRight: horizontalSpace.lg,
    paddingTop: verticalSpace.md,
    whiteSpace: "pre",
  },
  highlightedCode: {
    marginBottom: verticalSpace.md,
    marginTop: verticalSpace.md,
    maxWidth: "100%",
    overflow: "hidden",
  },
  tableWrap: {
    marginBottom: verticalSpace.md,
    marginTop: verticalSpace.md,
    maxWidth: "100%",
    overflowX: "auto",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: fontSize.xs,
    width: "100%",
  },
  tableCell: {
    borderColor: uiColor.border1,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBottom: verticalSpace.xs,
    paddingLeft: horizontalSpace.md,
    paddingRight: horizontalSpace.md,
    paddingTop: verticalSpace.xs,
    textAlign: "left",
    verticalAlign: "top",
  },
  tableHeader: {
    backgroundColor: uiColor.bgSubtle,
    fontWeight: fontWeight.semibold,
  },
  hr: {
    borderColor: uiColor.border1,
    borderStyle: "solid",
    borderWidth: 0,
    borderTopWidth: 1,
    marginBottom: verticalSpace.lg,
    marginTop: verticalSpace.lg,
  },
  image: {
    borderRadius: radius.xs,
    cornerShape: "squircle",
    display: "block",
    height: "auto",
    marginBottom: verticalSpace.md,
    marginTop: verticalSpace.md,
    maxWidth: "100%",
  },
  strikethrough: {
    textDecoration: "line-through",
  },
  taskList: {
    listStyleType: "none",
    paddingLeft: horizontalSpace.lg,
  },
  taskItem: {
    alignItems: "flex-start",
    display: "flex",
    gap: gap.sm,
    marginBottom: verticalSpace.xs,
  },
  taskCheckbox: {
    marginTop: "0.25em",
  },
  caret: {
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationName: stylex.keyframes({
      "0%": { opacity: 1 },
      "50%": { opacity: 0 },
      "100%": { opacity: 1 },
    }),
    backgroundColor: successColor.solid1,
    display: "inline-block",
    height: "14px",
    marginLeft: "2px",
    verticalAlign: "-2px",
    width: "7px",
  },
});

function fenceLang(className: string | undefined): string | null {
  const match = /language-([\w-+#.]+)/i.exec(className ?? "");
  return match?.[1] ?? null;
}

function HighlightedCodeBlock({
  code,
  lang,
  streaming,
}: {
  code: string;
  lang: string;
  streaming: boolean;
}): ReactElement {
  const normalizedLang = normalizeHighlightLang(lang);
  const { data } = useQuery({
    ...highlightCodeQueryOptions({ code, lang: normalizedLang }),
    enabled: !streaming && code.length > 0,
  });

  if (streaming || !data) {
    return (
      <pre {...stylex.props(styles.codeBlock)}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      {...stylex.props(styles.highlightedCode)}
      // Shiki HTML is produced server-side from our own highlighter.
      dangerouslySetInnerHTML={{ __html: data }}
    />
  );
}

function createChatMarkdownComponents(streaming: boolean): Components {
  return {
    h1: ({ children }) => <h1 {...stylex.props(styles.heading, styles.h1)}>{children}</h1>,
    h2: ({ children }) => <h2 {...stylex.props(styles.heading, styles.h2)}>{children}</h2>,
    h3: ({ children }) => <h3 {...stylex.props(styles.heading, styles.h3)}>{children}</h3>,
    h4: ({ children }) => <h4 {...stylex.props(styles.heading, styles.h4)}>{children}</h4>,
    h5: ({ children }) => <h5 {...stylex.props(styles.heading, styles.h5)}>{children}</h5>,
    h6: ({ children }) => <h6 {...stylex.props(styles.heading, styles.h6)}>{children}</h6>,
    p: ({ children }) => <p {...stylex.props(styles.paragraph)}>{children}</p>,
    ul: ({ className, children, ...props }) => {
      const isTaskList = className?.includes("contains-task-list");
      return (
        <ul
          {...props}
          {...stylex.props(styles.list, isTaskList && styles.taskList)}
          className={className}
        >
          {children}
        </ul>
      );
    },
    ol: ({ children, ...props }) => (
      <ol {...props} {...stylex.props(styles.orderedList)}>
        {children}
      </ol>
    ),
    li: ({ className, children, ...props }) => {
      const isTaskItem = className?.includes("task-list-item");
      if (isTaskItem) {
        return (
          <li {...props} {...stylex.props(styles.taskItem)} className={className}>
            {children}
          </li>
        );
      }
      return (
        <li {...props} {...stylex.props(styles.listItem)} className={className}>
          {children}
        </li>
      );
    },
    input: ({ type, checked, disabled, ...props }) => {
      if (type === "checkbox") {
        return (
          <input
            {...props}
            {...stylex.props(styles.taskCheckbox)}
            checked={checked}
            disabled={disabled ?? true}
            readOnly
            type="checkbox"
          />
        );
      }
      return <input type={type} {...props} />;
    },
    blockquote: ({ children }) => (
      <blockquote {...stylex.props(styles.blockquote)}>{children}</blockquote>
    ),
    a: ({ href, children }) => (
      <a {...stylex.props(styles.link)} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ),
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del {...stylex.props(styles.strikethrough)}>{children}</del>,
    hr: () => <hr {...stylex.props(styles.hr)} />,
    img: ({ src, alt }) => (
      <img {...stylex.props(styles.image)} alt={alt ?? ""} loading="lazy" src={src} />
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => {
      const lang = fenceLang(className);
      const code = String(children).replace(/\n$/, "");
      if (lang != null) {
        return <HighlightedCodeBlock code={code} lang={lang} streaming={streaming} />;
      }
      return (
        <code {...props} {...stylex.props(styles.inlineCode)} className={className}>
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div {...stylex.props(styles.tableWrap)}>
        <table {...stylex.props(styles.table)}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th {...stylex.props(styles.tableCell, styles.tableHeader)}>{children}</th>
    ),
    td: ({ children }) => <td {...stylex.props(styles.tableCell)}>{children}</td>,
  };
}

/** Close a dangling ``` fence so code blocks render mid-stream. */
function prepareStreamingMarkdown(text: string): string {
  if (text.split("```").length % 2 === 0) return `${text}\n\`\`\``;
  return text;
}

export interface ChatMarkdownProps {
  text: string;
  streaming?: boolean;
}

/** GitHub-flavored markdown for assistant chat bubbles, with Shiki
 *  highlighting on fenced code blocks once streaming completes. */
export function ChatMarkdown({ text, streaming = false }: ChatMarkdownProps): ReactElement {
  const content = useMemo(
    () => (streaming ? prepareStreamingMarkdown(text) : text),
    [streaming, text],
  );
  const components = useMemo(() => createChatMarkdownComponents(streaming), [streaming]);

  return (
    <div {...stylex.props(styles.root)}>
      <ReactMarkdown
        components={components}
        rehypePlugins={[[rehypeSanitize, mathSanitizeSchema], rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {content}
      </ReactMarkdown>
      {streaming ? <span {...stylex.props(styles.caret)} /> : null}
    </div>
  );
}
